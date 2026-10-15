/**
 * 执行环境管理模块：Worker 容器的创建、资源配置、停止与回收。
 *
 * 设计要点（Executor Worker 架构）：
 * - 一个 active 项目 = 一个常驻容器：入口直接是 Worker 程序的项目模式
 *   （镜像 ENTRYPOINT）；容器退出即项目 Worker 结束。
 * - 只有控制端（dispatcher）访问 Docker socket；Worker 容器内没有
 *   docker CLI、不挂载 socket，不具备任何容器管理权限。
 * - 资源与安全限制：CPU/内存/pids 上限、no-new-privileges、cap-drop ALL
 *   （按需加回 NET_RAW/NET_ADMIN/NET_BIND_SERVICE：Kali 的 nmap 等二进制带
 *   file capabilities，容器 bounding set 不覆盖这些 caps 时 execve 直接 EPERM），
 *   独立容器网络。
 * - /workspace/steps/<execution_id> 按步骤隔离，/workspace/persist 跨步骤共享；
 *   /workspace/uploads 只读挂载 dataRoot/uploads/<projectId>；
 *   容器内文件不保证跨容器保留，结论与证据必须走图谱与执行轨迹回传。
 * - 生命周期：容器名 = f(project_id)，项目之间永不复用；
 *   cancel = SIGTERM → 宽限 → SIGKILL；回收幂等，可由 reaper 重试。
 */

import { docker } from "./docker.js";
import { CONTAINER_UPLOADS_DIR, CONTAINER_WORKDIR } from "../contracts/execution.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** 容器名前缀：统一回收扫描的依据。 */
const CONTAINER_PREFIX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*-$/;

export interface ExecutionContainerConfig {
	image: string;
	/** 独立容器网络名（Worker 与控制端同网可达）。 */
	network: string;
	/** Worker 访问控制端的完整 URL（compose 别名 / 宿主网关地址）。 */
	controlUrl: string;
	/** 容器名前缀；默认 cairn-pw-，测试可隔离，避免其他 dispatcher 回收。 */
	containerPrefix?: string;
	/** Dispatcher 进程可见的数据根目录。 */
	dataRoot: string;
	/** Docker daemon 所在宿主机看到的数据根目录。 */
	dataHostRoot: string;
	/** 容器退出时是否自动删除；未指定时删除（部署配置 container.auto_remove 默认 false）。 */
	autoRemove?: boolean;
	resources: {
		cpus: number;
		memoryMb: number;
		pidsLimit: number;
	};
	/** 停止宽限（秒）：SIGTERM → 等待 → SIGKILL。 */
	stopGraceSeconds: number;
}

function uploadsDirectoryFor(dataRoot: string, projectId: string): string {
	return path.resolve(dataRoot, "uploads", projectId);
}

function hostUploadsDirectoryFor(dataHostRoot: string, projectId: string): string {
	return path.posix.join(
		dataHostRoot.replaceAll("\\", "/").replace(/\/+$/, ""),
		"uploads",
		projectId,
	);
}

/** Stable host directory mounted read-only so concurrent tasks can load different releases. */
function hostExecutePluginReleasesDirectoryFor(dataHostRoot: string): string {
	return path.posix.join(
		dataHostRoot.replaceAll("\\", "/").replace(/\/+$/, ""),
		"plugins",
		"execute",
		"releases",
	);
}

export const PROJECT_CONTAINER_PREFIX = "cairn-pw-";

/** 项目常驻容器名：cairn-pw-<projectId>，已收敛到 Docker 名称字符集。 */
export function containerNameForProject(
	projectId: string,
	prefix = PROJECT_CONTAINER_PREFIX,
): string {
	const cleaned = projectId
		.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")
		.replace(/^[-.]+/, "")
		.slice(0, 96);
	return `${prefix}${cleaned === "" ? "project" : cleaned}`;
}

export interface ProjectWorkerSpec {
	projectId: string;
	/** 项目令牌（仅注入容器环境；库中只存哈希）。 */
	projectToken: string;
	concurrency: number;
	/** Docker daemon 可见的项目附件目录。 */
	uploadsDirectory: string;
}

/**
 * 项目常驻容器的 docker run 参数（纯函数，便于单测断言）：
 * 入口是 Worker 程序的项目常驻模式，靠 CAIRN_PROJECT_ID/TOKEN/CONCURRENCY
 * 选择分支；没有任何长期模型 key / 数据库凭据，执行令牌由容器向控制端换取。
 */
export function projectWorkerContainerArgs(
	config: ExecutionContainerConfig,
	spec: ProjectWorkerSpec,
	name: string,
): string[] {
	// 一个 active 项目只有一个常驻容器；container 段定义的是这个容器的总资源上限。
	// max_project_workers 只控制容器内部并发执行的 step 数，不再放大 Docker 配额。
	return [
		"run",
		"--detach",
		// PID 1 是 Worker 的 Node 进程，不会回收孤儿；步骤里退出的后台进程会变成
		// 僵尸并占用 --pids-limit 配额。--init 让 docker-init 做 PID 1 负责收尸。
		"--init",
		...(config.autoRemove === false ? [] : ["--rm"]),
		"--name",
		name,
		"--network",
		config.network,
		"--cpus",
		String(config.resources.cpus),
		"--memory",
		`${config.resources.memoryMb}m`,
		"--pids-limit",
		String(config.resources.pidsLimit),
		"--security-opt",
		"no-new-privileges",
		"--cap-drop",
		"ALL",
		"--cap-add",
		"NET_RAW",
		// Kali 的 nmap / tcpdump 等二进制带 file capabilities
		// （cap_net_bind_service,cap_net_admin,cap_net_raw=eip）。只要容器 bounding
		// set 不覆盖这些 caps，execve 就会报 "operation not permitted"；补回
		// NET_ADMIN/NET_BIND_SERVICE 这些工具才能真正运行。
		"--cap-add",
		"NET_ADMIN",
		"--cap-add",
		"NET_BIND_SERVICE",
		"--stop-timeout",
		String(config.stopGraceSeconds),
		"--workdir",
		CONTAINER_WORKDIR,
		"-v",
		`${spec.uploadsDirectory}:${CONTAINER_UPLOADS_DIR}:ro`,
		"-v",
		`${hostExecutePluginReleasesDirectoryFor(config.dataHostRoot)}:/workspace/plugins/execute/releases:ro`,
		...(new URL(config.controlUrl).hostname === "host.docker.internal"
			? ["--add-host", "host.docker.internal:host-gateway"]
			: []),
		"-e",
		`CAIRN_CONTROL_URL=${config.controlUrl}`,
		"-e",
		`CAIRN_PROJECT_ID=${spec.projectId}`,
		"-e",
		`CAIRN_PROJECT_TOKEN=${spec.projectToken}`,
		"-e",
		`CAIRN_PROJECT_CONCURRENCY=${spec.concurrency}`,
		// 让容器内 Worker 与控制端使用同一日志级别，便于跨容器排查。
		"-e",
		`LOG_LEVEL=${process.env.LOG_LEVEL ?? "info"}`,
		config.image,
	];
}

export class ExecutionEnvironmentManager {
	private readonly timeoutMs: number;

	constructor(
		private readonly config: ExecutionContainerConfig,
		options: { timeoutMs?: number } = {},
	) {
		const prefix = config.containerPrefix ?? PROJECT_CONTAINER_PREFIX;
		if (!CONTAINER_PREFIX_PATTERN.test(prefix)) {
			throw new Error("containerPrefix 必须由 Docker 名称字符组成并以 '-' 结尾");
		}
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	async ping(): Promise<void> {
		const result = await docker(["version", "--format", "{{.Server.Version}}"], this.timeoutMs);
		if (result.code !== 0) {
			throw new Error(`docker daemon not reachable: ${result.stderr.trim() || "unknown error"}`);
		}
	}

	async validateRuntime(): Promise<void> {
		await this.ping();
		const image = await docker(["image", "inspect", this.config.image], this.timeoutMs);
		if (image.code !== 0) {
			throw new Error(
				`Worker image not found: ${this.config.image}; build it first with docker compose --profile build build`,
			);
		}
		const network = await docker(["network", "inspect", this.config.network], this.timeoutMs);
		if (network.code !== 0) {
			throw new Error(
				`Worker network not found: ${this.config.network}; create it with docker network create ${this.config.network}`,
			);
		}
	}

	/**
	 * 创建并启动项目常驻 Worker 容器。失败时抛出，由下一次状态检查处理残留；
	 * 调用方（dispatcher）只在本项目尚无 running 容器时调用。
	 */
	async createProjectWorkerContainer(spec: ProjectWorkerSpec): Promise<string> {
		const name = containerNameForProject(spec.projectId, this.prefix());
		const args = projectWorkerContainerArgs(this.config, spec, name);
		const created = await docker(args, this.timeoutMs);
		if (created.code !== 0) {
			throw new Error(
				`failed to create project worker container ${name}: ${created.stderr.trim()}`,
			);
		}
		return name;
	}

	async inspectState(name: string): Promise<string | null> {
		const result = await docker(["inspect", "--format", "{{.State.Status}}", name], this.timeoutMs);
		if (result.code !== 0) {
			if (result.stderr.toLowerCase().includes("no such object")) {
				return null;
			}
			throw new Error(`failed to inspect container ${name}: ${result.stderr.trim()}`);
		}
		const state = result.stdout.trim();
		return state === "" ? null : state;
	}

	/**
	 * 强制回收：rm --force（running 容器先杀后删）。幂等；失败返回 false
	 * 供调用方重试（reaper 会再次清理）。--rm 容器由 daemon 自删，此处
	 * 的 no such container 视为成功。
	 */
	async dispose(name: string): Promise<boolean> {
		const result = await docker(["rm", "--force", name], this.timeoutMs);
		if (result.code !== 0 && !result.stderr.toLowerCase().includes("no such container")) {
			return false;
		}
		const state = await this.inspectState(name);
		return state === null;
	}

	/**
	 * 孤儿容器对账：列出所有本前缀容器。控制端重启后据此清理不在活跃
	 * 执行集合中的残留容器。
	 */
	async listManagedContainers(): Promise<Array<{ name: string; state: string }>> {
		const list = await docker(
			["ps", "-a", "--filter", `name=^/${this.prefix()}`, "--format", "{{.Names}}\t{{.State}}"],
			this.timeoutMs,
		);
		if (list.code !== 0) {
			throw new Error(`failed to list worker containers: ${list.stderr.trim()}`);
		}
		return list.stdout
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => {
				const [name, state] = line.split("\t");
				return { name: name.trim(), state: (state ?? "").trim() };
			})
			.filter((c) => c.name.startsWith(this.prefix()));
	}

	private prefix(): string {
		return this.config.containerPrefix ?? PROJECT_CONTAINER_PREFIX;
	}

	async ensureUploadsDirectory(projectId: string): Promise<string> {
		await mkdir(uploadsDirectoryFor(this.config.dataRoot, projectId), { recursive: true });
		await mkdir(path.join(this.config.dataRoot, "plugins", "execute", "releases"), {
			recursive: true,
		});
		return hostUploadsDirectoryFor(this.config.dataHostRoot, projectId);
	}
}
