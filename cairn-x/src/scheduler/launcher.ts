/**
 * 项目常驻 Worker 容器的启动器接口与 Docker 实现。
 *
 * 一个 active 项目对应一个常驻容器：dispatcher 通过 ensure 幂等地保证
 * 容器存在（容器内是 Worker 程序的项目模式，循环领取 queued execution
 * 并并发执行多个 step）。容器归 DispatcherLoop 统一回收（项目停止 /
 * 空闲超时 / 孤儿对账）。
 *
 * 只有控制端持有 Docker 能力；Worker 容器内既无 docker CLI 也无 socket。
 */

import {
	containerNameForProject,
	ExecutionEnvironmentManager,
	PROJECT_CONTAINER_PREFIX,
	type ExecutionContainerConfig,
} from "../environments/execution-manager.js";

export interface ProjectWorkerLaunchSpec {
	projectId: string;
	/**
	 * 签发项目令牌（仅注入新建容器环境；库中只存哈希）。
	 *
	 * 故意做成惰性回调而不是字符串：签发会立即吊销旧令牌，因此只能由
	 * ensure 在确认「需要新建/重启容器」之后调用；容器已在运行时复用其
	 * 既有令牌，绝不调用本回调。
	 */
	issueToken: () => Promise<string>;
	concurrency: number;
}

export interface ProjectWorkerLauncher {
	ping(): Promise<void>;
	/** 幂等确保项目常驻容器存在；返回容器句柄（名）。 */
	ensure(spec: ProjectWorkerLaunchSpec): Promise<string>;
	containerName(projectId: string): string;
	/** 容器名 → projectId（对账用）；不属于本项目前缀时为 null。 */
	projectIdForContainer(handle: string): string | null;
	listManaged(): Promise<Array<{ name: string; state: string }>>;
	/** 强制回收（幂等；失败返回 false 供下一轮重试）。 */
	remove(handle: string): Promise<boolean>;
	/**
	 * 最近一次 ensure 失败后仍在退避期内。调度器据此暂停该项目的 Execute 派发，
	 * 避免 Docker 异常时每个节拍都走一遍认领 → 建执行 → 启动失败 → 释放。
	 */
	coolingDown?(projectId: string): boolean;
}

/** ensure 失败退避：5s 起指数增长，封顶 5 分钟。 */
const ENSURE_BACKOFF_BASE_MS = 5_000;
const ENSURE_BACKOFF_MAX_MS = 300_000;

export class DockerProjectWorkerLauncher implements ProjectWorkerLauncher {
	private readonly manager: ExecutionEnvironmentManager;
	private readonly prefix: string;
	private readonly launches = new Map<string, Promise<string>>();
	private readonly failures = new Map<string, { count: number; until: number }>();

	constructor(config: ExecutionContainerConfig, options: { timeoutMs?: number } = {}) {
		this.prefix = config.containerPrefix ?? PROJECT_CONTAINER_PREFIX;
		this.manager = new ExecutionEnvironmentManager(
			{ ...config, containerPrefix: this.prefix },
			options,
		);
	}

	containerName(projectId: string): string {
		return containerNameForProject(projectId, this.prefix);
	}

	projectIdForContainer(handle: string): string | null {
		if (!handle.startsWith(this.prefix)) {
			return null;
		}
		const id = handle.slice(this.prefix.length);
		return id === "" ? null : id;
	}

	async ping(): Promise<void> {
		await this.manager.ping();
	}

	async ensure(spec: ProjectWorkerLaunchSpec): Promise<string> {
		const existing = this.launches.get(spec.projectId);
		if (existing) return existing;
		const launch = this.ensureOnce(spec);
		this.launches.set(spec.projectId, launch);
		try {
			const name = await launch;
			this.failures.delete(spec.projectId);
			return name;
		} catch (err) {
			const count = (this.failures.get(spec.projectId)?.count ?? 0) + 1;
			const delay = Math.min(ENSURE_BACKOFF_BASE_MS * 2 ** (count - 1), ENSURE_BACKOFF_MAX_MS);
			this.failures.set(spec.projectId, { count, until: Date.now() + delay });
			throw err;
		} finally {
			if (this.launches.get(spec.projectId) === launch) this.launches.delete(spec.projectId);
		}
	}

	private async ensureOnce(spec: ProjectWorkerLaunchSpec): Promise<string> {
		const name = this.containerName(spec.projectId);
		const state = await this.manager.inspectState(name);
		// 各步骤按快照加载自己的插件版本；更新插件不需要中断共用容器。
		if (state === "running") return name;
		// 旧容器删不掉就不能继续：签发新令牌会吊销旧令牌，随后同名 run 也必然冲突。
		if (state !== null && !(await this.manager.dispose(name))) {
			throw new Error(`failed to remove stale project worker container ${name}`);
		}
		// 只有确定要新建容器才签发令牌：并发 dispatcher 抢先拉起容器时，
		// 上面的状态检查已命中 running 直接复用，不会走到这里。
		const projectToken = await spec.issueToken();
		const uploadsDirectory = await this.manager.ensureUploadsDirectory(spec.projectId);
		return this.manager.createProjectWorkerContainer({
			projectId: spec.projectId,
			projectToken,
			concurrency: spec.concurrency,
			uploadsDirectory,
		});
	}

	coolingDown(projectId: string): boolean {
		const failure = this.failures.get(projectId);
		return failure !== undefined && Date.now() < failure.until;
	}

	async validateRuntime(): Promise<void> {
		await this.manager.validateRuntime();
	}

	remove(handle: string): Promise<boolean> {
		return this.manager.dispose(handle);
	}

	listManaged(): Promise<Array<{ name: string; state: string }>> {
		return this.manager.listManagedContainers();
	}
}

export { containerNameForProject } from "../environments/execution-manager.js";
