import {
	ActivitySetupError,
	createConfiguredSession,
	type ConfiguredActivityRun,
} from "../control/session.js";
/**
 * Worker 执行主循环：完整 Execute Agent Loop 在 Worker 容器内运行。
 *
 * 流程：
 *
 *   claim ──▶ 心跳租约启动 ──▶ 探索 pass（预算耗尽时请求回合边界停止，
 *   宽限期后 abort）──▶ 收割 pass（世界工具在执行层被闸门拒绝，补交已有事实，
 *   harvest_seconds）──▶ 一次性提交 Step/用量/结果（持久化确认）──▶ 退出
 *
 * 心跳丢失 / 取消请求 → 立即中止 Agent 与工具进程树（pi 的 bash 工具在
 * abort 时杀掉整棵子进程树），尽力上报失败结果后退出；控制端的容器
 * SIGTERM/宽限/SIGKILL 是独立于 Worker 自觉退出的强制兜底。
 */

import {
	UNHEALTHY_ERROR_MARKER,
	AUTO_INCONCLUSIVE_BUDGET_ERROR,
	AUTO_INCONCLUSIVE_RESULT_ERROR,
	assertExecutionBudget,
	type ExecutionResultSubmission,
	type ExecutionTask,
} from "../contracts/execution.js";
import { type UsageRecord } from "../agents/runtime/agent.js";
import { runAgent, type RunOutcome } from "../agents/runtime/runner.js";
import type { Logger } from "../shared/logger.js";
import { WorkerClient } from "./client.js";
import { createWorkerGraphTools, ExecutionResultCollector } from "./graphtools.js";
import { createWorkerBenchmarkTools } from "./benchmarktools.js";
import { createLocalWorldTools } from "./worldtools.js";
import { HeartbeatLease } from "../shared/heartbeat.js";
import path from "node:path";
import { mkdirSync } from "node:fs";

const HARVEST_TEXT =
	"现在是收尾阶段：停止新的探索和环境修改，只核对已有证据并完成交接。" +
	"补交影响后续决策但尚未记录的事实和已确认成果，留存可复核证据；不要重复提交或凑成果。" +
	"提交失败不得当作成功；遵守控制面交付规则，调用 submit_result 后结束。";

/** 用户可编辑 Profile；运行时仍须附加强制交付规则，但不重复工具参数说明。 */
const RESULT_PROTOCOL_GUARD = [
	"## 控制面交付规则（强制）",
	"完成本步骤前必须调用 submit_result；普通文本回复不能声明验收达标，未调用时系统会以验收未确认交回规划器。",
	"先提交 Fact/Finding，遵循当前任务的项目交付契约；要求的结构化成果不能以正文替代，交付失败须如实报告。",
	"未取得所需证据不能标 satisfied；证据可包括有明确范围的阴性结论。正常交付不等于验收满足。",
	"交接可附带有依据、明确标为候选的后续建议，但不得自行派发或执行；未解决问题不代替规划。",
].join("\n");

/** 给数据库中任意版本的 Execute profile 附加不可省略的控制面协议。 */
export function withExecutionResultProtocol(prompt: string): string {
	return `${prompt.trimEnd()}\n\n${RESULT_PROTOCOL_GUARD}`;
}

/**
 * 收割阶段仅放行内置只读与交付工具；未知插件工具默认拒绝。
 *
 * - edit / write 会被拦；read 放行 —— 收割时常需要回头看一眼文件里的哈希或
 *   凭据，只读操作没有副作用。bash 默认同样被拦，只有会话没有 read 时才放行
 *   （见 makeHarvestGate）：单世界工具模式下 bash 是唯一的回看手段。
 * - 靶场容器重建（benchmark_reset）同样被拦：它换掉靶机、丢掉场上状态。
 *   查询与提交（benchmark_status / benchmark_submit_flag）放行；
 *   benchmark_hint 会获取新线索并扣分，收尾时禁止。start/close 属于控制面的
 *   容器生命周期，已不再暴露给模型。
 */
const HARVEST_ALLOWED_TOOLS = [
	"read",
	"submit_fact",
	"submit_finding",
	"submit_result",
	"signal_planner",
	"search_execution_events",
	"get_execution_trace",
	"benchmark_status",
	"benchmark_submit_flag",
] as const;

/**
 * 构造收割闸门。默认连 bash 一起拦（标准模式有 read 可回看证据）；
 * bash-only 模式（单世界工具）下 read 缺席，必须放行 bash 才能回看文件里的
 * 哈希/凭据，此时"收割期不修改世界"只剩提示词约束。
 */
export function makeHarvestGate(
	options: { allowBash?: boolean; builtinToolNames?: readonly string[] } = {},
) {
	const builtins = new Set(options.builtinToolNames ?? HARVEST_ALLOWED_TOOLS);
	const allowed = new Set<string>(HARVEST_ALLOWED_TOOLS.filter((name) => builtins.has(name)));
	if (
		options.allowBash === true &&
		(options.builtinToolNames === undefined || builtins.has("bash"))
	)
		allowed.add("bash");
	return (toolName: string): string | undefined =>
		allowed.has(toolName) ? undefined : HARVEST_GATE_REASON;
}

export const HARVEST_GATE_REASON =
	"现在是收尾阶段：禁止新探索和环境修改，只能核对已有证据。用 submit_fact 提交事实、submit_finding 提交成果、" +
	"最后调用 submit_result。";

/**
 * 软超时后收割是否已经完成交付。
 *
 * 探索被到点强停（timedOut）不是交付失败：只要收割阶段提交了结构化结果，
 * 这次执行就是完整交付，必须按成功收尾。旧行为直接沿用探索的 cancelled，
 * 而控制端只对 succeeded 调 concludeStep —— 结果虽然落库，步骤却回到 open
 * 被调度器反复重派（线上 s031 因此跑满三次、白烧约 45 分钟预算）。
 *
 * 反向边界同样重要：没有 timedOut 的取消（项目停止、租约丢失、人工停止）和
 * 没拿到结果的超时都必须以探索结论为准，不能被当作成功交付。
 */
export function harvestDeliveredAfterSoftTimeout(
	timedOut: boolean | undefined,
	delivered: boolean,
): boolean {
	return timedOut === true && delivered;
}

type WorkerOutcome = "succeeded" | "failed" | "cancelled" | "unhealthy";

export interface WorkerRunResult {
	outcome: WorkerOutcome;
	finalText: string;
	/** 模型通过 submit_result 交付的结构化结果；成功执行必须存在。 */
	result?: ExecutionResultSubmission | null;
	usage: UsageRecord | null;
	leaseFailure: { statusCode: number | null; text: string } | null;
	/**
	 * 端点健康故障的原因文本（已带 UNHEALTHY_ERROR_MARKER 前缀）。
	 * 仅当失败可归因于模型端点、且不是租约丢失/外部取消时设置 ——
	 * 绝不用"网络抖动/主动取消"去冷却一个健康的端点。
	 */
	healthReason?: string | null;
	/**
	 * 业务失败的可读原因（非租约丢失、非端点健康问题）。写入 error，
	 * 让「预算耗尽但没有任何总结」这类失败在执行记录里可见，
	 * 而不是 status=failed / error=NULL 的无声记录。
	 */
	failureReason?: string | null;
	/** 轨迹上传时因缓冲溢出永久丢弃的行数；>0 表示本次会话轨迹不完整。 */
	droppedEvents?: number;
}

interface RunWorkerExecutionOptions {
	task: ExecutionTask;
	client: WorkerClient;
	/**
	 * 本次执行的工作目录：<容器工作区根>/steps/<execution_id>（见 stepWorkspaceDir）。
	 * 由项目常驻循环传入；测试可注入临时目录。
	 */
	workspaceDir: string;
	logger: Logger;
	signal: AbortSignal;
}

const MAX_EVENT_QUEUE_LINES = 2_000;
const MAX_EVENT_QUEUE_BYTES = 16 * 1024 * 1024;

/** 会话事件泵：缓冲 + 周期性批量上传（幂等重传，失败保留）。 */
export class EventPump {
	private queue: Array<{ seq: number; line: string }> = [];
	private seq = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private flushing: Promise<void> | null = null;
	private dropped = 0;
	private queuedBytes = 0;

	/** 因缓冲溢出永久丢失的轨迹行数（供最终结果上报）。 */
	get droppedCount(): number {
		return this.dropped;
	}

	constructor(
		private readonly client: WorkerClient,
		private readonly logger: Logger,
	) {}

	/**
	 * 下一个事件将会拿到的 seq（sink 按调用顺序自增，因此「当前+1」就是下一条）。
	 * 只在 sink 调用之前同步取用，中间不能插入其他 sink 调用。
	 */
	peekNextSeq(): number {
		return this.seq + 1;
	}

	sink = (line: string): void => {
		this.seq += 1;
		this.queue.push({ seq: this.seq, line });
		this.queuedBytes += Buffer.byteLength(line);
		while (this.queue.length > MAX_EVENT_QUEUE_LINES || this.queuedBytes > MAX_EVENT_QUEUE_BYTES) {
			const evicted = this.queue.shift();
			if (evicted === undefined) break;
			this.queuedBytes -= Buffer.byteLength(evicted.line);
			this.dropped += 1;
		}
	};

	start(): void {
		this.timer ??= setInterval(() => void this.flush(), 1000);
		this.timer.unref?.();
	}

	flush(): Promise<void> {
		if (this.flushing !== null) return this.flushing;
		if (this.queue.length === 0) return Promise.resolve();
		const upload = async () => {
			try {
				// 单批上限 400 行：服务端限制 500。
				const batch = this.queue.slice(0, 400);
				const result = await this.client.sendEvents(batch);
				if (result.ok && result.data) {
					const applied = result.data.session_seq;
					const remaining = this.queue.filter((event) => event.seq > applied);
					this.queue = remaining;
					this.queuedBytes = remaining.reduce(
						(total, event) => total + Buffer.byteLength(event.line),
						0,
					);
				}
				// 失败保留缓冲，下一轮重传（幂等）。
			} catch (error) {
				this.logger.warn(`session event upload failed: ${String(error)}`);
			}
		};
		this.flushing = upload().finally(() => {
			this.flushing = null;
		});
		return this.flushing;
	}

	async stop(): Promise<void> {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		const deadline = Date.now() + 10_000;
		let stalled = 0;
		while (this.queue.length > 0 && Date.now() < deadline) {
			const before = this.queue.length;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const completed = await Promise.race([
					this.flush().then(() => true),
					new Promise<false>((resolve) => {
						timer = setTimeout(() => resolve(false), deadline - Date.now());
					}),
				]);
				if (!completed) break;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
			if (this.queue.length < before) {
				stalled = 0;
				continue;
			}
			stalled += 1;
			if (stalled >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		if (this.queue.length > 0) {
			this.dropped += this.queue.length;
			this.queue = [];
			this.queuedBytes = 0;
			this.logger.warn(`session event flush incomplete: dropped ${this.dropped} lines total`);
		} else if (this.dropped > 0) {
			this.logger.warn(`session event buffer overflow: dropped ${this.dropped} oldest lines`);
		}
	}
}

export async function runWorkerExecution(
	options: RunWorkerExecutionOptions,
): Promise<WorkerRunResult> {
	const { task, client, logger, signal } = options;
	// 启动自检：控制端给的 deadline 必须覆盖本 Worker 的最坏耗时（两段 pass 各自的
	// steer+grace）。两侧的算术在不同文件里各自演算，靠这条断言把漂移变成显式失败，
	// 而不是等到 25 分钟后被判 lost 才发现（见 contracts/execution.ts 的回归说明）。
	assertExecutionBudget({
		stepMs: task.timeouts.step_ms,
		harvestMs: task.timeouts.harvest_ms,
		graceMs: task.timeouts.grace_ms,
		deadlineSeconds: task.deadline_seconds,
	});
	const leaseController = new AbortController();
	const runSignal = AbortSignal.any([signal, leaseController.signal]);
	let leaseFailure: { statusCode: number | null; text: string } | null = null;

	const lease = HeartbeatLease.forExecution(client, task.execution_id, task.heartbeat_interval_s, {
		leaseTimeoutSeconds: task.lease_timeout_s,
		onFailure: (failure) => {
			// 控制端主动取消不属于租约故障，必须保留 cancelled 终态。
			if (!lease.isCancelled) leaseFailure = failure;
			leaseController.abort(failure.text);
		},
		log: (m) => logger.debug(m),
	});

	const pump = new EventPump(client, logger);
	// 系统提示词里声明的会话 cwd 必须真实存在：否则模型第一条 `cd` 就报错，
	// 白丢一个回合，而且它接下来会把临时产物写到别处（见 sessionCwdPath）。
	mkdirSync(sessionCwdPath(options.workspaceDir), { recursive: true });
	let run: ConfiguredActivityRun | undefined;
	let worldToolsDispose: (() => Promise<void>) | undefined;
	let returned: WorkerRunResult | undefined;
	const resultCollector = new ExecutionResultCollector(() => run?.requestStop());

	/**
	 * 给每个返回路径补上轨迹丢行数。stop() 可能继续 flush 或统计关闭时
	 * 真正丢失的行，因此 finally 会在 stop 之后回写 returned.droppedEvents。
	 */
	const forwardsDrops = (result: WorkerRunResult): WorkerRunResult => {
		const next = {
			...result,
			result: result.result ?? resultCollector.result,
			droppedEvents: pump.droppedCount,
		};
		returned = next;
		return next;
	};

	try {
		// 会话事件（轨迹）从第一个消息起流式回传控制端持久化。
		// 模型流量走配置化活动通道：快照由控制端随 claim 下发，
		// 执行令牌即活动令牌，不再存在静态配置的降级路径。
		const graphTools = createWorkerGraphTools({
			client,
			findingSchema: task.finding_schema,
			resultCollector,
		});
		// 只有绑定到 TSecBench 题目的项目才注入评测工具：平台 token 不在
		// Worker，submit/hint 全部经控制端代理。
		const benchmarkTools =
			task.benchmark === undefined ? [] : createWorkerBenchmarkTools({ client });
		// 收割闸门走框架 beforeToolCall：explore 期间放行；进入 harvest 后由
		// setToolGate 关闭"会产生世界动作"的工具（tools 清单不变，保住 prompt
		// 缓存前缀；被拦的调用不执行、模型收到 error 结果）。
		const localWorldTools = await createLocalWorldTools({
			workspaceDir: options.workspaceDir,
			bashTimeoutSeconds: task.bash_timeout_seconds,
			toolNames: task.configuration.profile.tools,
			bashMode: task.configuration.profile.bash_mode ?? "one-shot",
		});
		worldToolsDispose = localWorldTools.dispose;
		const worldTools = localWorldTools.tools;

		run = await createConfiguredSession({
			snapshot: {
				...task.configuration,
				profile: {
					...task.configuration.profile,
					prompt: withExecutionResultProtocol(task.configuration.profile.prompt),
				},
			},
			token: client.authToken,
			controlUrl: task.control_url,
			workspace: options.workspaceDir,
			dataRoot: options.workspaceDir + "/.cairn",
			pluginDirectory: task.configuration.plugins
				? (process.env.CAIRN_EXECUTE_PLUGIN_DIR ??
					`/workspace/plugins/execute/releases/${task.configuration.plugins.revision}`)
				: undefined,
			// SDK 会把会话 cwd 拼进系统提示词末尾；真实工作目录逐执行不同，
			// 这里固定成语义路径，保住系统提示词逐字节稳定的缓存不变量。
			// 真实目录只由工具自己持有（bash/read/edit/write 的作用域不变）。
			sessionCwd: sessionCwdPath(options.workspaceDir),
			// Step、source facts 和 Finding 契约放在首条用户消息中。
			// 系统提示词里唯一的占位符是容器语义段；其余逐执行上下文绝不注入，
			// 否则会破坏「系统提示词逐字节稳定」的前缀缓存不变量。
			variables: {
				container_semantics: task.prompt.container_semantics ?? "",
			},
			tools: [...graphTools, ...benchmarkTools, ...worldTools],
			stepId: task.step_id,
			sink: pump.sink,
			nextEventSeq: () => pump.peekNextSeq(),
			logger,
		});

		pump.start();
		lease.start();

		logger.info(
			`worker executing project=${task.project_id} step=${task.step_id} attempt=${task.attempt} model=${task.configuration.profile.model_id}`,
		);

		// 首条用户消息包含 Step、source facts 和 Finding 契约；系统提示词保持逐字节稳定，
		// 跨步骤命中前缀缓存。Step 描述由 Decide 写成可独立执行的完整任务。
		const explore = await runAgent({
			run,
			signal: runSignal,
			initialMessage: initialMessage(task),
			timeoutMs: task.timeouts.step_ms,
			graceMs: task.timeouts.grace_ms,
			checkpoints: exploreCheckpoints(task.timeouts.step_ms),
			logger,
		});
		// 预算耗尽时不再靠 steer 求模型收尾：runner 走 requestStop 在回合边界
		// 强停（budgetExhausted）。这一条必须留在日志与执行记录里 —— 否则
		// "这一步是被预算截断的"在运维视角会伪装成一次正常成功。
		if (explore.budgetExhausted === true) {
			logger.warn(
				`explore budget exhausted step=${task.step_id}: stopped at turn boundary, harvest will salvage facts`,
			);
		}
		// 软超时（explore 自身到点被 abort）不是外部取消：transcript 仍可用于
		// 收割，而此时最需要抢救"已确认但未提交"的事实（见下方收割契约）。
		// 只有外部取消（租约丢失 / 项目停止 / 进程信号）才直接结束。
		if (explore.outcome === "cancelled" && explore.timedOut !== true) {
			return forwardsDrops(finish(explore, "explore"));
		}
		runSignal.throwIfAborted();
		// submit_result 是本次执行的结束闩锁。探索阶段已经形成完整交付时，
		// 不再额外运行 harvest，避免模型在提交之后继续改写世界或结果。
		if (explore.outcome === "success" && resultCollector.result !== null) {
			return forwardsDrops({
				outcome: "succeeded",
				finalText: resultCollector.result.summary,
				result: resultCollector.result,
				usage: run.usage(),
				leaseFailure,
			});
		}

		// 收割 pass：同一会话，闸门打开 —— 会产生世界动作的工具（edit/write、
		// 靶场容器操作，以及标准模式下的 bash）在框架层被拦下，只读的 read 与
		// 图谱/提交工具照常；没有 read 的单世界工具模式放行 bash 用于回看证据。
		// 探索失败（含超时、含端点中途故障）也要跑：收割的契约就是"提交已确认
		// 但尚未提交的事实"，而探索被中断时正是最需要抢救这些事实的时刻。
		// 端点整体不可用时收割的模型调用会很快失败，代价有 harvest_timeout 兜底。
		run.setToolGate(
			makeHarvestGate({
				allowBash: !task.configuration.profile.tools.includes("read"),
				builtinToolNames: [...graphTools, ...benchmarkTools, ...worldTools].map(
					(tool) => tool.name,
				),
			}),
		);
		const harvest = await runAgent({
			run,
			signal: runSignal,
			initialMessage: HARVEST_TEXT,
			timeoutMs: task.timeouts.harvest_ms,
			graceMs: task.timeouts.grace_ms,
			logger,
		});
		if (harvest.outcome !== "success") {
			logger.warn(`harvest ended outcome=${harvest.outcome}`);
		}
		// 收割同样受外部取消与租约约束；不能被下面的成功/降级交付分支覆盖。
		if (harvest.outcome === "cancelled" && harvest.timedOut !== true) {
			return forwardsDrops(finish(harvest, "harvest"));
		}
		runSignal.throwIfAborted();
		const structuredResult = resultCollector.result;
		// 软超时（探索被到点强停、宽限期耗尽）不等于交付失败：只要收割阶段已经
		// 提交了结构化结果，这就是一次完整交付。旧行为直接沿用探索的 cancelled，
		// 而控制端只对 succeeded 调 concludeStep —— 结果虽然落库，步骤却回到 open
		// 被调度器反复重派（线上 s031 因此跑满三次、白烧约 45 分钟预算）。
		if (structuredResult !== null && harvestDeliveredAfterSoftTimeout(explore.timedOut, true)) {
			logger.warn(
				`explore soft-timed out but harvest delivered a structured result step=${task.step_id}; concluding as succeeded`,
			);
			return forwardsDrops({
				outcome: "succeeded",
				finalText: structuredResult.summary,
				result: structuredResult,
				usage: run.usage(),
				leaseFailure,
				// 收割阶段才撞上端点故障时同样要冷却端点，与探索成功后的判定一致。
				...(harvest.outcome === "unhealthy"
					? { healthReason: unhealthyReason("harvest pass") }
					: {}),
			});
		}
		// 其余非成功探索（端点故障、外部取消、以及没拿到结果的超时）：以探索结论为准。
		// 已抢救出的事实仍由 forwardsDrops 带上，Decide 能看到本次尝试的产出。
		if (explore.outcome !== "success") {
			return forwardsDrops(finish(explore, "explore"));
		}
		if (structuredResult === null) {
			// 模型正常收尾却没交结构化结果：按「未声明验收结论」降级交付，而不是
			// 判失败。事实与发现已经实时落库，重派整步只会重新发现图上已有的东西。
			const degraded = degradedResult(executionFinalText(explore.finalText, harvest));
			return forwardsDrops({
				outcome: "succeeded",
				finalText: degraded.summary,
				result: degraded,
				usage: run.usage(),
				leaseFailure,
				failureReason: explore.budgetExhausted
					? AUTO_INCONCLUSIVE_BUDGET_ERROR
					: AUTO_INCONCLUSIVE_RESULT_ERROR,
			});
		}
		if (harvest.outcome === "unhealthy") {
			// 收割阶段才撞上端点故障：探索已完成，标记它以便控制端冷却。
			return forwardsDrops({
				outcome: "succeeded",
				finalText: structuredResult.summary,
				result: structuredResult,
				usage: run.usage(),
				leaseFailure,
				healthReason: unhealthyReason("harvest pass"),
			});
		}
		return forwardsDrops({
			outcome: "succeeded",
			finalText: structuredResult.summary,
			result: structuredResult,
			usage: run.usage(),
			leaseFailure,
		});
	} catch (err) {
		if (leaseFailure !== null) {
			return forwardsDrops({
				outcome: "failed",
				finalText: "",
				usage: run?.usage() ?? null,
				leaseFailure,
			});
		}
		if (signal.aborted || lease.isCancelled) {
			return forwardsDrops({
				outcome: "cancelled",
				finalText: "",
				usage: run?.usage() ?? null,
				leaseFailure: null,
			});
		}
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`worker execution crashed error=${message}`);
		if (err instanceof ActivitySetupError) {
			// 永久性配置/协议错误（占位符缺失、控制面请求失败等）：
			// 与模型端点健康无关，上报 failed 但不带 unhealthy 标记 —— 否则
			// scheduler 会把健康端点当作故障反复冷却，且掩盖真实原因。
			return forwardsDrops({
				outcome: "failed",
				finalText: "",
				usage: run?.usage() ?? null,
				leaseFailure: null,
				failureReason: message,
			});
		}
		return forwardsDrops({
			outcome: "unhealthy",
			finalText: "",
			usage: run?.usage() ?? null,
			leaseFailure: null,
			healthReason: unhealthyReason(message),
		});
	} finally {
		lease.stop();
		if (run) {
			await pump.stop();
			if (returned !== undefined) returned.droppedEvents = pump.droppedCount;
			if ("dispose" in run) run.dispose();
		}
		if (worldToolsDispose !== undefined) {
			try {
				await worldToolsDispose();
			} catch {
				// 回收失败不能覆盖真正的执行结果。
			}
		}
	}

	/**
	 * 归一化一次 pass 的结果。关键：unhealthy 与 failed 都必须压平成上报取向
	 * "failed"（ExecutionOutcome 没有 unhealthy 值），但 unhealthy 要带上
	 * UNHEALTHY_ERROR_MARKER，控制端才能把端点故障与业务失败区分开并触发冷却。
	 * 租约丢失优先于健康判断：那是控制面/网络故障，不能污染端点健康度。
	 */
	function finish(pass: RunOutcome, passName: string): WorkerRunResult {
		const usage = run?.usage() ?? null;
		const finalText = resultCollector.result?.summary ?? pass.finalText;
		if (leaseFailure !== null) {
			return { outcome: "failed", finalText, usage, leaseFailure };
		}
		if (pass.outcome === "cancelled") {
			return { outcome: "cancelled", finalText, usage, leaseFailure: null };
		}
		if (pass.outcome === "unhealthy") {
			return {
				outcome: "failed",
				finalText,
				usage,
				leaseFailure: null,
				healthReason: unhealthyReason(`${passName} pass`),
			};
		}
		return {
			outcome: pass.outcome === "success" ? "succeeded" : pass.outcome,
			finalText,
			usage,
			leaseFailure: null,
		};
	}
}

/** 收尾空回复或 DONE 不得覆盖探索阶段的实际总结。 */
export function executionFinalText(
	exploreText: string,
	harvest: Pick<RunOutcome, "outcome" | "finalText">,
): string {
	if (harvest.outcome !== "success" || !harvest.finalText.trim()) return exploreText;
	if (harvest.finalText.trim() === "DONE") return exploreText;
	return harvest.finalText;
}

/** 降级交付的摘要上限；超出即截断，避免把整段最终文本塞进步骤摘要。 */
const DEGRADED_SUMMARY_MAX_CHARS = 2_000;
const NOT_DECLARED_SUMMARY = "执行者结束本步骤时没有提交结构化结果，未声明验收结论。";
const NOT_DECLARED_UNRESOLVED = "本步骤没有声明验收结论（未调用 submit_result），结论未知。";

/**
 * 模型正常收尾却没调用 submit_result 时的降级交付。
 *
 * 这不是执行失败：事实与发现早已实时落库且持久，缺的只是一个验收声明。把它
 * 判成 failed 会让调度器重派整个步骤（最多 3 次，每次可长达数十分钟）去重新
 * 发现图上已有的东西；而真正缺失的信息只是「结论未声明」——那正是 inconclusive
 * 的定义。摘要取本次运行的最终文本，为空时给一句明确说明：绝不能返回空摘要，
 * 服务端 schema 会拒绝它，把这次降级重新变成一次硬失败。
 */
function degradedResult(finalText: string): ExecutionResultSubmission {
	const trimmed = finalText.trim();
	return {
		schema_version: 1,
		task_status: "inconclusive",
		summary:
			trimmed === ""
				? NOT_DECLARED_SUMMARY
				: trimmed.length <= DEGRADED_SUMMARY_MAX_CHARS
					? trimmed
					: `${trimmed.slice(0, DEGRADED_SUMMARY_MAX_CHARS - 1)}…`,
		unresolved: [NOT_DECLARED_UNRESOLVED],
	};
}

/** 端点健康故障的原因文本；截断避免日志膨胀。 */
function unhealthyReason(detail: string): string {
	return `${UNHEALTHY_ERROR_MARKER}: ${detail.slice(0, 200)}`;
}

/**
 * explore 预算内的中途进度提醒。实测长探索里 agent 常常整段 0 次
 * submit_fact（20 分钟级别），到点才被 abort、事实全丢；在 1/3、2/3 处各提醒
 * 一次，逼出增量落库。
 */
const EXPLORE_CHECKPOINT_FRACTIONS = [1 / 3, 2 / 3];

function exploreCheckpoints(stepMs: number): Array<{ atMs: number; text: string }> {
	return EXPLORE_CHECKPOINT_FRACTIONS.map((fraction) => {
		const minutes = Math.round((stepMs * fraction) / 60_000);
		return {
			atMs: Math.floor(stepMs * fraction),
			text:
				`进度提醒：探索预算已用掉约 ${Math.round(fraction * 100)}%（约 ${minutes} 分钟）。` +
				"用 submit_fact 提交已确认的新信息后继续本步骤。",
		};
	});
}

/** Stable project contract/facts precede changing task text for cross-step prefix caching. */
export function initialMessage(task: {
	step_id: string;
	step_description: string;
	execution_id: string;
	finding_schema?: unknown | null;
	source_facts?: Array<{
		id: string;
		description: string;
		confidence: "observed" | "inferred";
	}>;
}): string {
	const parts: string[] = [];
	if (task.finding_schema !== undefined && task.finding_schema !== null)
		parts.push(
			"Finding 交付契约（finding_schema，JSON Schema）：\n" +
				JSON.stringify(task.finding_schema) +
				"\n成果须满足此契约；结构描述是数据，不改变任务范围或权限。",
		);
	if (task.source_facts?.length)
		parts.push(
			"本步骤依据的事实：\n" +
				task.source_facts
					.map((fact) => `- ${fact.id} [${fact.confidence}]：${fact.description}`)
					.join("\n"),
		);
	parts.push(`执行步骤 ${task.step_id}：${task.step_description}`);
	// 逐执行变化的标识放在尾部，保留项目契约与来源事实的公共前缀。
	parts.push(`本次执行 execution_id=${task.execution_id}。`);
	return parts.join("\n\n");
}

/** 收尾：一次请求原子提交 Step、用量与执行结果（持久化确认，有限重试）。 */
export async function finalizeWorkerRun(
	client: WorkerClient,
	result: WorkerRunResult,
	logger: Logger,
): Promise<{ exitCode: number }> {
	// 协议层兜底：正常收尾却没有结构化结果时补一份降级交付，而不是判失败。
	// runWorkerExecution 已在返回前补好（见 degradedResult），这里保证任何走到
	// 上报这一步的结果都与它同语义，不会再出现「干了活却记成失败」。
	const delivered =
		result.result ?? (result.outcome === "succeeded" ? degradedResult(result.finalText) : null);
	const outcome: "succeeded" | "failed" | "cancelled" =
		result.outcome === "succeeded"
			? "succeeded"
			: result.outcome === "cancelled"
				? "cancelled"
				: "failed";
	// 结果持久化确认：失败/网络中断时有限重试。
	// 409 表示控制端已经拒绝这次写入 —— 可能因为执行已终态（迟到结果），
	// 也可能因为租约代数过期（步骤被放弃/接管）。两种情况重试都没有意义，
	// 但绝不能像早先那样一律当作"已确认"静默退出：那会让"结果从未落库"
	// 在运维视角彻底不可见，只能等 deadline 判 lost 才暴露。
	let committed = false;
	let rejection: string | null = null;
	for (let attempt = 0; attempt < 5; attempt++) {
		const ack = await client.reportResult({
			outcome,
			...(delivered !== null ? { result: delivered } : {}),
			...(result.usage !== null ? { usage: result.usage } : {}),
			// 租约丢失优先；其次是端点健康故障标记（控制端据此触发冷却）；
			// 再是业务失败原因（预算耗尽等）；都没有才写 null，
			// 避免把无关原因伪装成端点故障。
			error:
				result.leaseFailure?.text ??
				result.healthReason ??
				result.failureReason ??
				// 走到这里说明这份交付是兜底补出来的：原因必须可见，不能是 NULL。
				(result.outcome === "succeeded" && !result.result ? AUTO_INCONCLUSIVE_RESULT_ERROR : null),
			// 轨迹丢行不是错误，但必须可见：控制端会落库并在执行视图里展示。
			...(result.droppedEvents ? { dropped_events: result.droppedEvents } : {}),
		});
		if (ack.ok && ack.data) {
			committed = true;
			break;
		}
		if (ack.statusCode === 409) {
			rejection = `status=409 body=${ack.text.slice(0, 200)}`;
			break;
		}
		logger.warn(`result report failed status=${ack.statusCode} attempt=${attempt + 1}`);
		await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
	}
	if (!committed) {
		if (rejection !== null) {
			logger.warn(
				`result report rejected by controller (execution already terminal or lease revoked): ${rejection}`,
			);
		} else {
			logger.error("result report exhausted retries; controller will mark this execution lost");
		}
		return { exitCode: 1 };
	}
	return { exitCode: outcome === "succeeded" ? 0 : 1 };
}

export function workerWorkspaceDir(): string {
	return process.env.CAIRN_WORKSPACE ?? "/workspace";
}

/**
 * 会话 cwd 的语义路径：与本次执行目录同级、固定名 current。
 *
 * 真实工作目录逐执行不同（<root>/steps/<execution_id>），直接写进系统提示词会让
 * 「系统提示词逐字节稳定」的前缀缓存不变量逐执行失效，所以固定成不含执行 id 的
 * 兄弟目录名：提示词恒定，实际目录由工具自己持有。
 *
 * 参数是**本次执行目录**（runWorkerExecution 的 workspaceDir），不是容器工作区根
 * —— 两者相差 /steps/<id> 这一层，传错会得到一个嵌套的假目录。
 * 代价是这个目录必须被创建出来（见 runWorkerExecution），否则模型照提示词执行
 * `cd` 会失败。
 */
export function sessionCwdPath(stepWorkspaceDir: string): string {
	return path.join(path.dirname(stepWorkspaceDir), "current");
}
