/**
 * Execute 调度 runner（Executor Worker 架构 · 项目常驻容器）：
 * dispatcher 不运行 Agent Loop —— 本 runner 只负责执行尝试的生命周期：
 *
 *   创建 execution（queued）→ 确保项目常驻容器（入口 = Worker 程序的
 *   项目模式）→ 轮询执行终态 / 截止时间 → 映射 outcome。
 *
 * 容器归项目所有：截止/取消都只作用于当前 step（请求取消），绝不动容器；
 * 容器生命周期由 DispatcherLoop 统一负责（停止 / 空闲回收 / 孤儿回收）。
 *
 * 可靠性语义：
 * - 独立超时：deadline 由服务端按 profile 的 run_seconds + harvest_seconds +
 *   grace + 启动与控制端余量计算；超过即请求取消，不依赖 Worker 自觉退出。
 * - 项目容器异常退出而无结果 → 心跳停止，Step 租约在 lease_timeout 后过期，
 *   服务端把 execution 判为 lost（失联 ≠ 未执行：原 Step 关闭为 abandoned，
 *   保留结果未知的说明，由 Decide 根据证据重新规划）。
 * - 取消：先 cancel 请求（Worker 心跳可见，自愿终止 agent 与工具进程树）。
 */

import { EXECUTION_TERMINAL_STATUSES, UNHEALTHY_ERROR_MARKER } from "../contracts/execution.js";
import type { ProjectWorkerLauncher } from "./launcher.js";
import type { FgsClient } from "../orchestrator/client.js";
import type { ExecutionView } from "../orchestrator/client.js";
import type { DeploymentConfig } from "./config.js";
import { consoleLogger, type Logger } from "../shared/logger.js";
import { type ExecuteContext } from "./types.js";
import { type ExecuteOutcome, type Outcome } from "../contracts/activity.js";
import { sleep } from "../shared/async.js";

type ExecuteRunner = (ctx: ExecuteContext, signal: AbortSignal) => Promise<ExecuteOutcome>;

interface ProjectExecuteRunnerDeps {
	config: DeploymentConfig;
	client: FgsClient;
	/** 项目常驻容器启动器（仅控制端持有 Docker 能力）。 */
	projectLauncher: ProjectWorkerLauncher;
	logger?: Logger;
}

interface PreparedExecution {
	/** 控制端强制回收的绝对时刻；Worker 自保预算与它是同一个数。 */
	deadlineMs: number;
}

/** 创建 execution 的 POST 重试：服务端按 execution_id 幂等，重发不会重复建行。 */
const CREATE_POST_ATTEMPTS = 3;
const CREATE_RETRY_DELAY_MS = 250;
/** 对账读取：重发耗尽后按 execution_id 确认到底建没建。 */
const RECONCILE_GET_ATTEMPTS = 3;

/** createExecution + 硬截止计算；不确定是否创建时不得释放 Step 租约。 */
async function prepareExecution(
	deps: {
		client: FgsClient;
		log: Logger;
		label: string;
	},
	ctx: ExecuteContext,
): Promise<PreparedExecution | "uncertain" | null> {
	const projectId = ctx.projectId;
	const stepId = ctx.stepId;
	let lastStatusCode = 0;
	/** 服务端给过确定的 409：创建事务已整体回滚，对账查不到即可断定未创建。 */
	let conflicted = false;
	for (let attempt = 0; attempt < CREATE_POST_ATTEMPTS; attempt += 1) {
		const created = await deps.client.createExecution({
			project_id: projectId,
			step_id: stepId,
			execution_id: ctx.worker,
		});
		if (created.ok && created.data !== undefined) {
			// 截止时刻由服务端冻结；不在调度器重新计算，也不把网络延迟加回预算。
			const deadlineMs = Date.parse(created.data.deadline_at);
			if (
				Number.isFinite(deadlineMs) &&
				Number.isFinite(created.data.deadline_seconds) &&
				created.data.deadline_seconds > 0
			) {
				return { deadlineMs };
			}
			deps.log.warn(`${deps.label} create returned invalid deadline execution=${ctx.worker}`);
		} else if (
			created.statusCode >= 400 &&
			created.statusCode < 500 &&
			created.statusCode !== 409
		) {
			// 明确拒绝请求时，服务端没有创建 execution；可以释放 Step。
			deps.log.warn(
				`${deps.label} create failed project=${projectId} step=${stepId} status=${created.statusCode} body=${created.text.slice(0, 200)}`,
			);
			return null;
		} else if (created.statusCode === 409) {
			// 确定性冲突（租约已易主 / 未配置模型）：重发没有意义，直接对账。
			lastStatusCode = created.statusCode;
			conflicted = true;
			break;
		} else {
			// 响应丢失（0）/5xx：POST 已幂等，可以安全重发。
			lastStatusCode = created.statusCode;
		}
		if (attempt < CREATE_POST_ATTEMPTS - 1) await sleep(CREATE_RETRY_DELAY_MS * (attempt + 1));
	}
	// POST 仍未给出可用结果：按 execution_id 读取确认，兜住代理吞掉响应、
	// 重发也没能回来的情况。
	for (let attempt = 0; attempt < RECONCILE_GET_ATTEMPTS; attempt += 1) {
		const observed = await deps.client.getExecution(ctx.worker);
		if (observed.ok && observed.data !== undefined) {
			const view = observed.data;
			const deadlineMs = Date.parse(view.deadline_at ?? "");
			if (
				view.id === ctx.worker &&
				view.project_id === projectId &&
				view.step_id === stepId &&
				Number.isFinite(deadlineMs)
			) {
				return { deadlineMs };
			}
			deps.log.error(
				`${deps.label} create reconciliation returned invalid execution=${ctx.worker}`,
			);
			return "uncertain";
		}
		if (conflicted && observed.statusCode === 404) {
			// 409 之后查无此行：执行确定没有建出来（例如未配置 execute 模型），
			// 必须立即释放 Step；否则租约空挂到过期，下一轮又被同样拒绝。
			deps.log.warn(
				`${deps.label} create rejected project=${projectId} step=${stepId} status=409; execution was not created`,
			);
			return null;
		}
		if (attempt < RECONCILE_GET_ATTEMPTS - 1) await sleep(CREATE_RETRY_DELAY_MS);
	}
	deps.log.warn(
		`${deps.label} create outcome unknown project=${projectId} step=${stepId} execution=${ctx.worker} status=${lastStatusCode}; retaining Step lease until server expiry`,
	);
	return "uncertain";
}

interface AttemptLifecycleHooks {
	label: string;
	deadlineMs: number;
	/** 截止 / 外部取消时的唯一处置：请求取消当前 step（容器归项目所有）。 */
	onStop: () => Promise<void>;
	deadlineNote: string;
	deadlineError: string;
	cancelError: string;
}

/** 强制迁移可能与 Worker 的终态上报竞态；终态必须以服务端读回值为准。 */
async function forceAndReadTerminalStatus(
	client: FgsClient,
	executionId: string,
	status: "cancelled" | "lost",
	error: string,
	pollMs: number,
): Promise<ExecutionView | null> {
	const forced = await client.setExecutionStatus(executionId, { status, error });
	if (
		forced.ok &&
		forced.data !== undefined &&
		EXECUTION_TERMINAL_STATUSES.includes(forced.data.status)
	) {
		return forced.data;
	}

	for (let attempt = 0; attempt < RECONCILE_GET_ATTEMPTS; attempt += 1) {
		const observed = await client.getExecution(executionId);
		if (
			observed.ok &&
			observed.data !== undefined &&
			EXECUTION_TERMINAL_STATUSES.includes(observed.data.status)
		) {
			return observed.data;
		}
		if (attempt < RECONCILE_GET_ATTEMPTS - 1) await sleep(Math.min(pollMs, 250));
	}
	return null;
}

/**
 * 执行尝试的生命周期骨架：
 *
 *   轮询终态（或硬截止 / 外部取消）→ 取消宽限轮询 → outcomeForStatus 映射。
 */
async function runAttemptLifecycle(
	deps: { client: FgsClient; config: DeploymentConfig; log: Logger; pollMs: number },
	ctx: ExecuteContext,
	hooks: AttemptLifecycleHooks,
	signal: AbortSignal,
): Promise<ExecuteOutcome> {
	const { client, config, log, pollMs } = deps;
	const projectId = ctx.projectId;
	const stepId = ctx.stepId;
	const executionId = ctx.worker;
	let finalStatus: string | null = null;
	let finalView: ExecutionView | null = null;
	try {
		let cancelRequested = false;
		for (;;) {
			if (signal.aborted) {
				cancelRequested = true;
				break;
			}
			if (Date.now() >= hooks.deadlineMs) {
				log.warn(
					`${hooks.label} deadline exceeded project=${projectId} step=${stepId} execution=${executionId}; ${hooks.deadlineNote}`,
				);
				await hooks.onStop();
				const observed = await forceAndReadTerminalStatus(
					client,
					executionId,
					"lost",
					hooks.deadlineError,
					pollMs,
				);
				if (observed === null) {
					log.warn(
						`${hooks.label} deadline status is uncertain execution=${executionId}; retaining Step lease until server reconciliation`,
					);
					return "uncertain";
				}
				finalView = observed;
				finalStatus = observed.status;
				break;
			}
			const view = await client.getExecution(executionId);
			if (view.ok && view.data && EXECUTION_TERMINAL_STATUSES.includes(view.data.status)) {
				finalStatus = view.data.status;
				finalView = view.data;
				break;
			}
			await sleep(pollMs);
		}

		if (cancelRequested && finalStatus === null) {
			await hooks.onStop();
			// 给 Worker 优雅上报留一个宽限轮询，之后强制终态化。
			const graceDeadline = Date.now() + config.container.stop_grace_seconds * 1000;
			while (Date.now() < graceDeadline) {
				const view = await client.getExecution(executionId);
				if (view.ok && view.data && EXECUTION_TERMINAL_STATUSES.includes(view.data.status)) {
					finalStatus = view.data.status;
					finalView = view.data;
					break;
				}
				await sleep(Math.min(pollMs, 1000));
			}
			if (finalStatus === null) {
				const observed = await forceAndReadTerminalStatus(
					client,
					executionId,
					"cancelled",
					hooks.cancelError,
					pollMs,
				);
				if (observed === null) {
					log.warn(
						`${hooks.label} cancellation status is uncertain execution=${executionId}; retaining Step lease until server reconciliation`,
					);
					return "uncertain";
				}
				finalView = observed;
				finalStatus = observed.status;
			}
		}

		log.info(
			`${hooks.label} finished project=${projectId} step=${stepId} execution=${executionId} status=${finalStatus}`,
		);
		return outcomeForStatus(finalStatus, finalView);
	} catch (err) {
		if (signal.aborted) return "cancelled";
		log.error(
			`${hooks.label} runner crashed project=${projectId} step=${stepId} execution=${executionId} error=${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return "failed";
	}
}

/**
 * Execute 调度 runner（项目常驻容器）：
 *
 *   创建 execution（queued）→ ensure 项目常驻容器 → 轮询执行终态 → 映射 outcome。
 *
 * 关键设计：**本 runner 不拥有容器**。容器属于项目，
 * 由 DispatcherLoop 在项目停止 / 空闲超时时统一回收；取消一个 step 只是让
 * Worker 中止该 step，绝不 stop 整个项目容器。
 *
 * 令牌规则：只有当容器「不存在或非 running」时才向控制端签发项目令牌并
 * 新建容器；已在运行的容器复用其既有令牌，绝不用新令牌覆盖（否则运行中
 * 容器的令牌会立即失效）。该判定在 ensure 内部完成（issueToken 回调只在
 * 真正需要新建容器时被调用），同一项目的并发 ensure 由 launcher 串行化。
 */
export function createProjectExecuteRunner(deps: ProjectExecuteRunnerDeps): ExecuteRunner {
	const log = deps.logger ?? consoleLogger;
	const pollMs = Math.min(Math.max(deps.config.runtime.interval * 1000, 1000), 3000);
	// 同一项目的并发 ensure 由 launcher 串行化（检查状态 → 签令牌 → 起容器）。
	async function ensureProjectContainer(projectId: string): Promise<string> {
		const name = deps.projectLauncher.containerName(projectId);
		const runtime = await deps.client.getRuntimeSettings();
		return deps.projectLauncher.ensure({
			projectId,
			// 只在 ensure 判定需要新建/重启容器后才签发令牌：签发会立即吊销
			// 旧令牌，若容器已被并发拉起，那条运行中的令牌就被无谓作废。
			issueToken: async () => {
				const issued = await deps.client.issueProjectWorkerToken(projectId, name);
				if (!issued.ok || issued.data === undefined) {
					throw new Error(`project token issue failed status=${issued.statusCode}`);
				}
				return issued.data.token;
			},
			concurrency: runtime.max_project_workers,
		});
	}

	return async (ctx, signal) => {
		const projectId = ctx.projectId;
		const stepId = ctx.stepId;
		const executionId = ctx.worker;
		if (signal.aborted) return "cancelled";

		const prepared = await prepareExecution(
			{ client: deps.client, log, label: "project execution" },
			ctx,
		);
		if (prepared === null) return "failed";
		if (prepared === "uncertain") return "uncertain";

		try {
			await ensureProjectContainer(projectId);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			log.error(
				`project container ensure failed project=${projectId} step=${stepId} execution=${executionId} error=${error}`,
			);
			// 只有服务端仍为 queued 才能记准备失败（不消耗业务重试预算）。
			// 已有项目 Worker 可能在 ensure 抛错前抢先 claim；409 时继续监视，
			// 不能把已执行的尝试当作未启动失败，也不能提前释放它的 Step 租约。
			const failed = await ctx.client.setExecutionStatus(executionId, {
				status: "failed",
				error: `project container ensure failed: ${error}`,
			});
			if (failed.ok) return "failed";
			if (failed.statusCode !== 409) {
				log.warn(
					`preparation failure status rejected execution=${executionId} status=${failed.statusCode}; monitoring execution`,
				);
			}
		}
		// execution 保持 queued 直到项目容器的 next() 原子领取并 claim → running。
		log.info(
			`project execution queued project=${projectId} step=${stepId} execution=${executionId} deadline_at=${new Date(prepared.deadlineMs).toISOString()}`,
		);

		return await runAttemptLifecycle(
			{ client: deps.client, config: deps.config, log, pollMs },
			ctx,
			{
				label: "project execution",
				deadlineMs: prepared.deadlineMs,
				// 容器归项目所有：截止/取消都只作用于当前 step，绝不动容器。
				onStop: async () => {
					await ctx.client.requestExecutionCancel(executionId);
				},
				deadlineNote: "cancelling step",
				deadlineError: "controller deadline exceeded; project worker step cancelled",
				cancelError: "cancelled by controller; project worker will abort the step",
			},
			signal,
		);
	};
}

/**
 * 终态 → 调度 outcome。
 *
 * unhealthy 与 failed 在控制端都表现为 execution 的 failed 状态（协议取向里
 * 没有 unhealthy），仅靠状态无法区分。Worker 在 error 里写入
 * UNHEALTHY_ERROR_MARKER 表示本次失败可归因于模型端点；这里据此上浮为
 * "unhealthy"，DispatcherLoop 才会执行 endpoint 冷却（loop.ts recordUnhealthy）。
 * 步骤由 release 路径放回 open 等待重试（这次尝试仍计入尝试次数上限），
 * 不像 lost 那样关闭步骤交回 Decide。
 *
 * 刻意保守：只认 error 的前缀。租约丢失、容器失联、外部取消都不带该标记，
 * 因此绝不会用"网络抖动/主动取消"去冷却一个健康的端点。
 */
function outcomeForStatus(finalStatus: string | null, view: ExecutionView | null): Outcome {
	switch (finalStatus) {
		case "succeeded":
			return "success";
		case "cancelled":
			return "cancelled";
		case "failed":
			return view?.error?.startsWith(UNHEALTHY_ERROR_MARKER) ? "unhealthy" : "failed";
		default:
			// lost：Worker 失联/超时 —— 绝不映射为可自动重试的健康信号。
			return "failed";
	}
}
