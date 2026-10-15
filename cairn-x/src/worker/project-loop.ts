/**
 * 项目级常驻 Worker 循环。
 *
 * 一个 active 项目对应一个常驻容器；循环用项目令牌不断领取 queued execution，
 * 并在同一个容器里并发执行多个 step（上限 maxConcurrency）：
 *
 *   next() ──▶ 200：拿到任务 + 现签短期执行令牌
 *            │     └─▶ runWorkerExecution（工作目录 /workspace/steps/<execution_id>）
 *            │          └─▶ finalizeWorkerRun（conclude / usage / result）
 *            └─▶ 204：无任务，退避后重试
 *
 * 跨步持久化：/workspace/persist 常驻（装一次的工具、脚本、字典）；
 * uploads 由项目目录只读挂载。每个 step 独立 try/catch，单步异常不会拖死循环。
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import type { ProjectWorkerTask } from "../contracts/execution.js";
import type { Logger } from "../shared/logger.js";
import { finalizeWorkerRun, runWorkerExecution } from "./agent.js";
import { WorkerClient } from "./client.js";
import { ProjectWorkerClient } from "./project-client.js";
import { sleepAbortable } from "../shared/async.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** 项目保活间隔（毫秒）；循环被并发闸门挡住时也持续刷新。 */
const DEFAULT_PROJECT_HEARTBEAT_MS = 10_000;

/** 执行一个 step；返回进程退出语义（0 = 成功）。默认实现复用单执行路径。 */
type ProjectExecutionRunner = (
	task: ProjectWorkerTask,
	workspaceDir: string,
	signal: AbortSignal,
	logger: Logger,
) => Promise<number>;

interface ProjectWorkerLoopOptions {
	client: ProjectWorkerClient;
	workspaceDir: string;
	maxConcurrency: number;
	logger: Logger;
	signal: AbortSignal;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	/** 测试注入点；缺省时走 runWorkerExecution + finalizeWorkerRun。 */
	runExecution?: ProjectExecutionRunner;
}

interface ProjectWorkerLoopResult {
	reason: "signal" | "stopped" | "unauthorized";
	completed: number;
}

/** 每步独立工作目录：/workspace/steps/<execution_id>。 */
export function stepWorkspaceDir(workspaceDir: string, executionId: string): string {
	const component = executionId.replaceAll(/[^0-9a-zA-Z-]/g, "");
	if (component.length === 0) throw new Error("execution ID has no usable workspace component");
	return path.join(workspaceDir, "steps", component);
}

/** 跨步共享目录：/workspace/persist。 */
export function persistWorkspaceDir(workspaceDir: string): string {
	return path.join(workspaceDir, "persist");
}

/**
 * per-project 模式注入 execute 提示词的执行环境段落。
 *
 * 只有项目常驻循环会覆写 {container_semantics}：单个步骤的执行者需要知道
 * 自己和其他步骤共用一个容器，以及由此产生的硬约定（persist 复用、
 * apt 锁、别拖垮容器）。
 */
export const PROJECT_CONTAINER_SEMANTICS = [
	"## 执行环境（项目常驻容器）",
	"",
	"本项目的所有步骤共享**同一个常驻容器**，多个步骤会同时运行。",
	"",
	"- 当前工作目录属于本次执行，位于 /workspace/steps/ 下；临时输出放这里。/workspace/persist 用于跨步骤复用的脚本和文件，共享路径应避免重名覆盖。容器重建后本地文件不保证保留。",
	"- 安装前先检查依赖是否已有；apt-get 安装的系统包由整个容器共享，不放入 persist。需要时使用 apt-get update 与 apt-get install；遇到 apt/dpkg 锁等待或改用已有工具，不删锁文件、不终止其他步骤的安装进程。",
	"- 需要跨步骤存活的后台任务使用命名 tmux 会话，日志放 /workspace/persist；提交事实说明用途、会话名、启动命令、端口和日志路径。只清理自己不再需要的任务，不影响并行步骤。",
].join("\n");

/** 给任务注入项目常驻容器语义（覆写 execute 提示词的 {container_semantics}）。 */
export function applyProjectContainerSemantics(task: ProjectWorkerTask): ProjectWorkerTask {
	return {
		...task,
		prompt: { ...task.prompt, container_semantics: PROJECT_CONTAINER_SEMANTICS },
	};
}

/** 默认执行器：现签令牌 → WorkerClient → 单执行主循环 → 收尾上报。 */
function defaultProjectExecutionRunner(client: ProjectWorkerClient): ProjectExecutionRunner {
	return async (task, workspaceDir, signal, logger) => {
		const worker = new WorkerClient(client.controlUrl, task.execution_id, task.token);
		const result = await runWorkerExecution({
			task: applyProjectContainerSemantics(task),
			client: worker,
			workspaceDir,
			logger,
			signal,
		});
		const finalized = await finalizeWorkerRun(worker, result, logger);
		return finalized.exitCode;
	};
}

export async function runProjectWorkerLoop(
	options: ProjectWorkerLoopOptions,
): Promise<ProjectWorkerLoopResult> {
	const logger = options.logger;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_PROJECT_HEARTBEAT_MS;
	const runExecution = options.runExecution ?? defaultProjectExecutionRunner(options.client);

	const stopController = new AbortController();
	const stopSignal = AbortSignal.any([options.signal, stopController.signal]);
	let stopReason: ProjectWorkerLoopResult["reason"] | null = null;
	let completed = 0;

	mkdirSync(options.workspaceDir, { recursive: true });
	mkdirSync(persistWorkspaceDir(options.workspaceDir), { recursive: true });

	const running = new Map<string, Promise<void>>();
	// 初值来自容器启动时的环境变量，之后以心跳下发的当前设置为准。
	let maxConcurrency = options.maxConcurrency;
	/** 并发上限调大时唤醒正在等空槽的主循环。 */
	let wakeForSlot: (() => void) | null = null;

	const stop = (reason: ProjectWorkerLoopResult["reason"]): void => {
		stopReason ??= reason;
		stopController.abort(reason);
	};

	const beat = async (): Promise<void> => {
		const result = await options.client.heartbeat();
		if (result.statusCode === 401 || result.statusCode === 403 || result.statusCode === 404) {
			stop("unauthorized");
			return;
		}
		if (result.ok && result.data !== undefined) {
			const limit = result.data.max_concurrency;
			if (limit !== undefined && Number.isSafeInteger(limit) && limit > 0) {
				const grew = limit > maxConcurrency;
				maxConcurrency = limit;
				if (grew) wakeForSlot?.();
			}
			// 项目已停止/完成：不再领取新任务，在途 step 由 dispatcher 取消容器兜底。
			if (result.data.project_status !== "active") stop("stopped");
		}
	};
	const heartbeatTimer = setInterval(() => void beat(), heartbeatIntervalMs);
	heartbeatTimer.unref?.();

	try {
		while (!stopSignal.aborted) {
			const ran = running.size;
			if (ran >= maxConcurrency) {
				await waitForSlot(
					running,
					stopSignal,
					new Promise<void>((resolve) => (wakeForSlot = resolve)),
				);
				wakeForSlot = null;
				continue;
			}
			const next = await options.client.nextTask();
			if (stopSignal.aborted) {
				// next() may have claimed an execution while shutdown was in progress.
				// Acknowledge cancellation instead of starting work or stranding the claim.
				if (next.ok && next.data !== undefined) {
					const task = next.data;
					const worker = new WorkerClient(options.client.controlUrl, task.execution_id, task.token);
					const ack = await worker.reportResult({
						outcome: "cancelled",
						error: "project worker stopped before starting execution",
					});
					if (!ack.ok) logger.warn(`project worker cancellation failed status=${ack.statusCode}`);
				}
				break;
			}
			if (next.statusCode === 204) {
				await sleepAbortable(pollIntervalMs, stopSignal);
				continue;
			}
			if (next.statusCode === 401 || next.statusCode === 403 || next.statusCode === 404) {
				logger.warn(`project worker credential rejected status=${next.statusCode}`);
				stop("unauthorized");
				continue;
			}
			if (!next.ok || next.data === undefined) {
				logger.warn(`project worker next failed status=${next.statusCode}`);
				await sleepAbortable(pollIntervalMs, stopSignal);
				continue;
			}
			startExecution(next.data);
		}
	} finally {
		clearInterval(heartbeatTimer);
		// 等待在途 step 收尾（各自受 stopSignal 约束，不做强杀）。
		await Promise.allSettled([...running.values()]);
	}

	return { reason: stopReason ?? "signal", completed };

	function startExecution(task: ProjectWorkerTask): void {
		const promise = Promise.resolve()
			.then(() => {
				const dir = stepWorkspaceDir(options.workspaceDir, task.execution_id);
				mkdirSync(dir, { recursive: true });
				logger.info(
					`project worker started execution=${task.execution_id} step=${task.step_id} running=${running.size + 1}`,
				);
				return runExecution(task, dir, stopSignal, logger);
			})
			.then((exitCode) => {
				if (exitCode === 0) completed += 1;
			})
			.catch((err) => {
				logger.error(
					`project step crashed execution=${task.execution_id} error=${err instanceof Error ? err.message : String(err)}`,
				);
				const worker = new WorkerClient(options.client.controlUrl, task.execution_id, task.token);
				return worker
					.reportResult({
						outcome: "failed",
						error: err instanceof Error ? err.message : String(err),
					})
					.then((ack) => {
						if (!ack.ok)
							logger.warn(`project worker failure report failed status=${ack.statusCode}`);
					})
					.catch((reportError) => {
						logger.warn(`project worker failure report failed: ${String(reportError)}`);
					});
			})
			.finally(() => {
				running.delete(task.execution_id);
			});
		running.set(task.execution_id, promise);
	}
}

function waitForSlot(
	running: Map<string, Promise<void>>,
	signal: AbortSignal,
	wake: Promise<void>,
): Promise<void> {
	if (signal.aborted || running.size === 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const onAbort = (): void => {
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void Promise.race([wake, ...[...running.values()].map((p) => p.catch(() => undefined))]).then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
		);
	});
}
