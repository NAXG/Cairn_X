import type { EvidenceRef, TypedEvidenceRef } from "./evidence.js";
import type { CommittedExecutionResult } from "./execution.js";

export type ProjectStatus = "active" | "stopped" | "completed";
export type StepStatus = "open" | "claimed" | "concluded" | "abandoned";
export type GoalStatus = "pending" | "achieved" | "abandoned";

export interface DecideLease {
	worker: string;
	trigger: string;
	started_at: string;
	last_heartbeat_at: string;
}

export interface ProjectMeta {
	id: string;
	title: string;
	status: ProjectStatus;
	created_at: string;
	finding_schema: unknown;
	experiment_id: string | null;
	harness_variant: string | null;
	decide: DecideLease | null;
}

export interface ProjectSummary extends ProjectMeta {
	fact_count: number;
	goal_count: number;
	step_count: number;
	working_step_count: number;
	unclaimed_step_count: number;
	finding_count: number;
	hint_count: number;
}

export interface FactModel {
	id: string;
	description: string;
	confidence: "observed" | "inferred";
	step_id: string | null;
	evidence_refs: EvidenceRef[];
	created_at: string;
}

export interface GoalModel {
	id: string;
	parent_goal_id: string | null;
	description: string;
	status: GoalStatus;
	evidence: TypedEvidenceRef[];
	achieved_description: string | null;
	created_at: string;
	achieved_at: string | null;
}

/**
 * 步骤最近一次执行的归一化结果。
 *
 * 执行失败有很多种，Decide 需要区分「方法不对」「工具装不上」「端点故障」
 * 「超时」「失联」——否则它只能看到一句 summary，或者干脆看不出这一步已经
 * 试过几次。原始 error 文本仍保留在 executions 表，这里只做机器可读的分类。
 */
export type StepLastOutcome =
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "lost"
	| "endpoint_unhealthy"
	| "deadline_exceeded";

/** 单个步骤累计消耗（usage_events 按 step_id 聚合，仅 execute 活动）。 */
export interface StepCost {
	executions: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

/**
 * 攻击路线/假设：把若干步骤归到同一个可弃用的策略下。
 *
 * 没有这一层时，Decide 要放弃一条思路只能逐条 abandon 步骤。
 * 路线让「换方向」成为一个动作，级联取消其下步骤。
 */
/**
 * 攻击路线没有生命周期状态：只有「存在」这一种。方向失效由 Decide 用
 * abandon_step 逐条废弃该路线下的步骤表达，路线本身不需要第二个状态位。
 */
export interface RouteModel {
	id: string;
	description: string;
	goal_id: string | null;
	creator: string;
	created_at: string;
	/**
	 * 路线下的步骤统计，由单条记录查询聚合。
	 * Decide 靠它判断一条路线是「还在推进」还是「建完就没动/全挂了」。
	 */
	step_count: number;
	open_step_count: number;
	concluded_step_count: number;
}

export interface StepModel {
	summary: string | null;
	/** 最近一次成功执行的结构化交付；未完成步骤为 null。 */
	result: CommittedExecutionResult | null;
	id: string;
	from: string[];
	goal_id: string | null;
	/** 所属攻击路线；未归入任何路线为 null。 */
	route_id: string | null;
	description: string;
	priority: number;
	status: StepStatus;
	creator: string;
	worker: string | null;
	last_heartbeat_at: string | null;
	/** Step 租约版本：每次认领/失效/释放递增，用于拒绝过期执行者的写入。 */
	lease_version: number;
	/** 依赖的步骤 id：全部 concluded 后调度器才会派发本步骤。 */
	waiting_on: string[];
	created_at: string;
	concluded_at: string | null;
	/** 本步骤已创建的执行次数（尝试数）。 */
	attempts: number;
	/** 最近一次执行的结果分类；从未执行为 null。 */
	last_outcome: StepLastOutcome | null;
	/** 最近一次执行的错误摘要（≤200 字符）；无错误为 null。 */
	last_error: string | null;
	cost: StepCost;
}

export interface FindingModel {
	id: string;
	title: string;
	description: string;
	data: unknown;
	fact_ids: string[];
	evidence_refs: EvidenceRef[];
	created_at: string;
}

export interface HintModel {
	persistent?: boolean;
	id: string;
	content: string;
	creator: string;
	created_at: string;
}

interface UsageSummary {
	events: number;
	input_tokens: number;
	output_tokens: number;
	/** 命中上下文缓存的输入 token（不计入 input_tokens）。 */
	cache_read_tokens: number;
	/** 写入上下文缓存的 token（Anthropic 系；DeepSeek 等自动缓存为 0）。 */
	cache_write_tokens: number;
}

export interface UsageEvent {
	id: number;
	project_id: string;
	activity: "decide" | "execute";
	step_id: string | null;
	/** 产生该笔用量的执行；Decide 用量与历史行为 null。 */
	execution_id: string | null;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	created_at: string;
}

export interface RecordUsageBody {
	activity: "decide" | "execute";
	step_id?: string | null;
	/** 同一次执行重复上报时用于幂等去重（控制端也会从轨迹回填）。 */
	execution_id?: string | null;
	/**
	 * 产生该笔用量的会话轨迹文件名（`<snapshot.id>.jsonl`）。
	 *
	 * Decide 的用量在运行结束时一次性上报，容器被掐或控制面瞬时不可达就会永久
	 * 丢账；而轨迹是逐条落盘的。带上文件名后控制端既能把这笔上报做成幂等，也能
	 * 在丢失时按同一个文件从轨迹回填（见 server/core/usage-backfill）。
	 */
	source_file?: string | null;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
}

export interface CreatedProject {
	project: ProjectMeta;
}
export interface ProjectUsage {
	decide: UsageSummary;
	execute: UsageSummary;
}
export type ProjectPlanning = {
	version: number;
	last_trigger: string | null;
	updated_at: string;
	interrupted_retries: number;
	stalled: boolean;
} | null;

export interface Settings {
	lease_timeout: number;
	decide_timeout: number;
}
