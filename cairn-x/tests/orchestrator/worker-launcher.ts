/**
 * 进程级项目 Worker 启动器：不经过 Docker，直接在测试进程内运行真实的
 * 项目 Worker 循环（runProjectWorkerLoop：next 领取 → runWorkerExecution →
 * 收尾上报），走真实的 HTTP 协议（项目令牌 / 现签执行令牌 / 心跳 / 事件 /
 * result / graph 工具）。
 *
 * 这里被替代的只是容器边界，协议与 Agent Loop 全部真实 —— 真实 Docker
 * 验证由 Docker 环境下的端到端测试另行覆盖。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

import { consoleLogger, type Logger } from "../../src/shared/logger.js";
import type {
	ProjectWorkerLaunchSpec,
	ProjectWorkerLauncher,
} from "../../src/scheduler/launcher.js";
import { ProjectWorkerClient } from "../../src/worker/project-client.js";
import { runProjectWorkerLoop } from "../../src/worker/project-loop.js";

export interface WorkerInProcessLauncherOptions {
	/** 控制端基地址（测试服务器 URL）。 */
	controlUrl: string;
	logger?: Logger;
	/** 启动失败模拟（docker daemon 故障）。 */
	failStart?: boolean;
	/** 启动后挂起（不运行 Worker），模拟容器启动后 Worker 不工作。 */
	hang?: boolean;
	/** Worker 领取任务后立即退出且不报结果（进程崩溃模拟）。 */
	exitWithoutResult?: boolean;
}

interface RunningWorker {
	abort: AbortController;
	done: Promise<void>;
}

export class WorkerInProcessLauncher implements ProjectWorkerLauncher {
	readonly running = new Map<string, RunningWorker>();
	private readonly options: WorkerInProcessLauncherOptions;

	constructor(options: WorkerInProcessLauncherOptions) {
		this.options = options;
	}

	async ping(): Promise<void> {
		if (this.options.failStart) {
			throw new Error("docker daemon not reachable");
		}
	}

	containerName(projectId: string): string {
		return `cairn-pw-${projectId}`;
	}

	projectIdForContainer(handle: string): string | null {
		return handle.startsWith("cairn-pw-") ? handle.slice("cairn-pw-".length) || null : null;
	}

	async ensure(spec: ProjectWorkerLaunchSpec): Promise<string> {
		if (this.options.failStart) {
			throw new Error("failed to create worker container: docker daemon down");
		}
		const handle = this.containerName(spec.projectId);
		if (this.running.has(handle)) {
			return handle;
		}
		if (this.options.hang) {
			this.running.set(handle, {
				abort: new AbortController(),
				done: new Promise(() => {}),
			});
			return handle;
		}
		const workspace = mkdtempSync(path.join(tmpdir(), "cairn-worker-ws-"));
		onTestFinished(() => rmSync(workspace, { recursive: true, force: true }));
		const abort = new AbortController();
		const token = await spec.issueToken();
		const client = new ProjectWorkerClient(this.options.controlUrl, spec.projectId, token);
		const logger = this.options.logger ?? consoleLogger;
		const exitWithoutResult = this.options.exitWithoutResult === true;
		const done = (async () => {
			await runProjectWorkerLoop({
				client,
				workspaceDir: workspace,
				maxConcurrency: spec.concurrency,
				logger,
				signal: abort.signal,
				// 测试提速：生产默认 2s/10s。
				pollIntervalMs: 50,
				heartbeatIntervalMs: 100,
				...(exitWithoutResult
					? {
							runExecution: async () => {
								logger.warn("[worker] simulating crash: exiting without reporting a result");
								// 终止循环（模拟容器死亡），且永不 reportResult：
								// execution 停留在 running，由控制端 deadline 判 lost。
								abort.abort("simulated crash");
								return 0;
							},
						}
					: {}),
			});
		})();
		done.finally(() => rmSync(workspace, { recursive: true, force: true }));
		this.running.set(handle, { abort, done });
		return handle;
	}

	async remove(handle: string): Promise<boolean> {
		const worker = this.running.get(handle);
		if (worker !== undefined) {
			worker.abort.abort("controller remove");
		}
		this.running.delete(handle);
		return true;
	}

	async listManaged(): Promise<Array<{ name: string; state: string }>> {
		const out: Array<{ name: string; state: string }> = [];
		for (const [name] of this.running) {
			const settled = await Promise.race([
				this.running.get(name)!.done.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
			]);
			out.push({ name, state: settled ? "exited" : "running" });
		}
		return out;
	}
}
