import { z } from "zod";

/**
 * Executor Worker 执行协议契约（control plane ↔ worker ↔ dispatcher 共享）。
 *
 * 一次 Step 执行尝试对应一个 execution：
 * - execution_id 由 dispatcher 生成（uuid），同时用作 FGS step 租约的
 *   worker 身份；
 * - attempt 是该 step 的单调审计序号（服务端分配，从 1 起，含准备失败）；
 *   它不是业务重试预算，准备失败的 execution 保留但不消耗该预算；
 * - queued → failed：控制端准备失败，started_at / result_outcome 均为 null；
 *   running → failed：Worker 已领取并上报失败，仍消耗业务重试预算；
 * - lease_version 是创建 execution 时 step 租约的版本；step 被重新
 *   认领后版本递增，旧 execution 的所有写入随即被拒绝。
 *
 * 状态机（最终状态只能由控制端写入，worker 的 result 是持久化请求）：
 *
 *   queued ──▶ running ──▶ succeeded | failed
 *      │            │
 *      └────────────┴──▶ cancelled | lost
 *
 * - queued → running：Worker 以短期令牌领取任务。
 * - running → succeeded/failed：Worker 结果经服务端持久化确认。
 * - → cancelled：取消（dispatcher 请求 / 控制端强制回收）。
 * - → lost：Worker 失联、启动超时、执行超时或容器异常退出。
 * 终态不可逆；迟到的 result 返回持久化确认但不改变终态。
 */

/** steer 之后到强制 abort 之间的默认宽限（毫秒）。 */
export const DEFAULT_GRACE_MS = 60_000;
/** 容器启动 + 会话初始化 + 结果上报的预算（秒）。 */
const DEADLINE_STARTUP_ALLOWANCE_SECONDS = 60;
/** 控制端回收容器、落终态的余量（秒）。 */
const DEADLINE_MARGIN_SECONDS = 120;

/**
 * 一次执行的硬截止（秒）：覆盖 Worker 两段 pass 的最坏耗时（含各自 steer grace）
 * 再加控制端余量；历史上余量为零时曾导致用满宽限的执行全部被判 lost。
 */
export function executionDeadlineSeconds(input: {
	runSeconds: number;
	harvestSeconds: number;
	graceMs: number;
	marginSeconds?: number;
}): number {
	return (
		input.runSeconds +
		input.harvestSeconds +
		2 * Math.ceil(input.graceMs / 1000) +
		DEADLINE_STARTUP_ALLOWANCE_SECONDS +
		(input.marginSeconds ?? DEADLINE_MARGIN_SECONDS)
	);
}

export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "lost";

export const EXECUTION_TERMINAL_STATUSES: readonly ExecutionStatus[] = [
	"succeeded",
	"failed",
	"cancelled",
	"lost",
];

type ExecutionOutcome = "succeeded" | "failed" | "cancelled";

/** 业务验收结果，与 execution succeeded（协议正常交付）独立。 */
export type TaskStatus = "satisfied" | "inconclusive" | "blocked";

/** 旧执行记录只在 error 中保留降级来源；集中定义以便列表正确回显。 */
export const AUTO_INCONCLUSIVE_RESULT_ERROR = "structured result was not submitted";
export const AUTO_INCONCLUSIVE_BUDGET_ERROR =
	"explore budget exhausted; harvest did not submit a structured result";
export function isAutoInconclusiveError(error: string | null): boolean {
	return error === AUTO_INCONCLUSIVE_RESULT_ERROR || error === AUTO_INCONCLUSIVE_BUDGET_ERROR;
}

/**
 * 单次执行允许上报的规划升级次数。
 *
 * 执行者用 signal_planner 在发现「当前计划的前提已经不成立」时立刻唤醒规划器；
 * 上限防止单个执行者（或它的重试循环）把规划器拉成热循环。重复的上报理由会被
 * 去重，因此这个上限只约束真正不同的理由数量。
 */
export const MAX_EXECUTION_ESCALATIONS = 3;

/** Recording a signal does not guarantee when the planner will run. */
export type EscalationAck = {
	count: number;
	limit: number;
} & (
	| { status: "accepted"; accepted: true }
	| { status: "duplicate" | "limit_reached"; accepted: false }
);

/**
 * 结构化交付的**唯一权威** schema。
 *
 * Worker 侧工具提交前用它做本地判定，服务端用它做最终校验 —— 必须是同一份。
 * 此前两侧各写一份（工具侧 TypeBox、服务端 zod），规则很快漂移：工具回
 * "structured result accepted" 并触发 requestStop()，服务端却以 400 拒绝
 * （额外键、全空白的 summary/unresolved），于是整轮探索的交付丢失、步骤挂到
 * deadline 被判 lost。任何规则改动都只改这里。
 */
export const executionResultSubmissionSchema = z
	.object({
		schema_version: z.literal(1),
		/** 验收结论，必填；缺省绝不等于 satisfied。 */
		task_status: z
			.enum(["satisfied", "inconclusive", "blocked"])
			.describe(
				"satisfied = acceptance evidenced; inconclusive = undetermined; " +
					"blocked = missing required input, permission or environment.",
			),
		// regex 同时把非空白约束暴露给生成的 JSON Schema；运行时仍先 trim。
		summary: z
			.string()
			.trim()
			.min(1)
			.max(200_000)
			.regex(/\S/)
			.describe("Acceptance evidence or blocking reason; must not be blank."),
		unresolved: z
			.array(z.string().trim().min(1).max(2000).regex(/\S/))
			.max(32)
			.describe("Open questions only; no blank entries."),
	})
	.strict();

/** 模型通过 submit_result 提交的最小结构；不允许模型声明服务端记录 id。 */
export type ExecutionResultSubmission = z.infer<typeof executionResultSubmissionSchema>;

/** 服务端按 execution_id 汇总产出（Fact/Finding）后形成的权威结果。 */
export interface CommittedExecutionResult extends ExecutionResultSubmission {
	produced: {
		fact_ids: string[];
		finding_ids: string[];
	};
}

/** 解析 execution_results.payload（由 compileExecutionResult 写入的权威结构）。 */
export function parseCommittedExecutionResultJson(raw: string): CommittedExecutionResult {
	return JSON.parse(raw) as CommittedExecutionResult;
}

/** Decide 创建 Step 时通过 from 选中的最小事实切片。 */
export interface ExecutionSourceFact {
	id: string;
	description: string;
	confidence: "observed" | "inferred";
}

/**
 * 失败原因前缀：本次失败可归因于模型端点不健康（区别于业务失败与 lost）。
 * 状态仍是 failed；标记随 error 上浮，供 DispatcherLoop 触发 endpoint 冷却。
 */
export const UNHEALTHY_ERROR_MARKER = "model endpoint unhealthy";

/** TSecBench 题目上下文；只含公开信息，平台 token 不在其中。 */
export interface ExecutionBenchmarkContext {
	unique_code: string;
	title: string;
	description: string | null;
	difficulty: string;
	level: number;
	total_score: number;
	flag_count: number;
	correct_flag_count: number;
	hint_used: boolean;
	container_status: string;
	/** 靶场容器直连地址（需 VPN 可达）；未就绪时为空数组。 */
	container_addr: string[];
}

export interface ExecutionTask {
	/** 本次执行的活动配置快照（配置中心下发；唯一支持的运行模式）。 */
	configuration: import("./configuration.js").ActivitySnapshot;
	execution_id: string;
	project_id: string;
	step_id: string;
	attempt: number;
	lease_version: number;
	/** FGS step 租约 worker 身份（= execution_id），工具写入时原样回传。 */
	worker: string;
	step_description: string;
	/** 当前 Step 直接引用的事实。 */
	source_facts: ExecutionSourceFact[];
	/** Finding.data contract, delivered through submit_finding.data_json; null means no schema. */
	finding_schema: unknown | null;
	/** 系统提示词的环境变量；逐执行输入使用顶层 Step、source_facts 与 finding_schema。 */
	prompt: {
		/**
		 * 执行环境语义段落（注入 execute 提示词的 {container_semantics}）：
		 * 由项目 Worker 下发「项目常驻容器 + 并发步骤」的说明。
		 */
		container_semantics?: string;
	};
	/** 控制端基地址（活动模型通道 /internal/activities/* 与执行协议同源）。 */
	control_url: string;
	benchmark?: ExecutionBenchmarkContext;
	timeouts: {
		/** 探索 pass 上限（毫秒）。 */
		step_ms: number;
		/** 收割 pass 上限（毫秒）。 */
		harvest_ms: number;
		/** steer 之后到强制 abort 的宽限（毫秒）。 */
		grace_ms: number;
	};
	/** 心跳间隔与租约 TTL（秒）；来自服务端 settings。 */
	heartbeat_interval_s: number;
	lease_timeout_s: number;
	/** 单条 bash 命令的默认超时（秒）。 */
	bash_timeout_seconds: number;
	/** 执行硬截止；Worker 不得依赖它主动退出。 */
	deadline_at: string;
	/** deadline_at 对应的总预算（秒）；用于 Worker 启动时校验自洽性。 */
	deadline_seconds: number;
}

/**
 * Worker 启动自检：控制端 deadline 必须覆盖 Worker 最坏耗时（两段 pass + grace）。
 * 两侧公式曾各自算出零余量，导致执行 100% lost；这里把算术漂移变成显式失败。
 */
export function assertExecutionBudget(input: {
	stepMs: number;
	harvestMs: number;
	graceMs: number;
	deadlineSeconds: number;
}): void {
	const worstMs = input.stepMs + input.harvestMs + 2 * input.graceMs;
	const needMs =
		executionDeadlineSeconds({
			runSeconds: input.stepMs / 1000,
			harvestSeconds: input.harvestMs / 1000,
			graceMs: input.graceMs,
		}) * 1000;
	const haveMs = input.deadlineSeconds * 1000;
	if (haveMs < needMs) {
		throw new Error(
			"execution budget is not self-consistent: deadline=" +
				haveMs +
				"ms < required " +
				needMs +
				"ms (worst-case " +
				worstMs +
				"ms + startup and controller margins). " +
				"Worker 的两段 grace 必须被 deadline 覆盖，否则用满宽限的执行必然被控制端硬杀" +
				"（见 contracts/execution.ts 的回归说明）。",
		);
	}
}

/** 项目 Worker 一次 next() 的返回：ExecutionTask + 本次现签的短期执行令牌。 */
export interface ProjectWorkerTask extends ExecutionTask {
	token: string;
}

export interface ExecutionView {
	id: string;
	project_id: string;
	step_id: string;
	attempt: number;
	lease_version: number;
	status: ExecutionStatus;
	cancel_requested: boolean;
	created_at: string;
	started_at: string | null;
	heartbeat_at: string | null;
	finished_at: string | null;
	deadline_at: string | null;
	result_outcome: string | null;
	/** 本次执行的结构化结果；未完成执行为 null。 */
	result: CommittedExecutionResult | null;
	summary: string | null;
	error: string | null;
	exit_code: number | null;
	/** 轨迹丢行数（>0 = 本次会话轨迹不完整，缓冲溢出所致）。 */
	dropped_events: number;
	session_seq: number;
}

/** Worker 事件批量上传（幂等：seq 单调，服务端只追加 seq > session_seq 的行）。 */
export interface ExecutionEventsBody {
	events: Array<{ seq: number; line: string }>;
}

export interface ExecutionEventsResult {
	/** 服务端已持久化到的 seq；重复/回退的行被忽略。 */
	session_seq: number;
	applied: number;
}

interface ExecutionUsage {
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
}

/** Worker 最终提交：成功时原子结束 Step，并与用量、Execution 终态一同持久化。 */
export interface ExecutionResultBody {
	outcome: ExecutionOutcome;
	/** 结构化交付；outcome=succeeded 时必填。Step 摘要与 Execution.summary 均取自 result.summary。 */
	result?: ExecutionResultSubmission;
	error?: string | null;
	/** 与最终结果同事务保存；会话初始化失败时可省略。 */
	usage?: ExecutionUsage;
	/**
	 * 因事件上传缓冲溢出而永久丢失的轨迹行数（>0 表示本次会话的轨迹不完整）。
	 * 控制端落库并在执行视图里展示，避免"轨迹少了一段"这件事静默发生。
	 */
	dropped_events?: number;
}

export interface ExecutionResultAck {
	/** true = 本次上报被持久化为终态；false = 执行已是终态（迟到/重复结果）。 */
	committed: boolean;
	status: ExecutionStatus;
	/** 首次提交和幂等重试都返回服务端保存的权威结果。 */
	result?: CommittedExecutionResult | null;
}

/** 容器内工作目录：Worker 的本地世界工具作用域，随容器销毁。 */
export const CONTAINER_WORKDIR = "/workspace";
/** 容器内输入附件目录（只读）。 */
export const CONTAINER_UPLOADS_DIR = `${CONTAINER_WORKDIR}/uploads`;
