import type { ExecutionStatus } from "./execution.js";
import type { ExperimentMetadata } from "./stats.js";

/** Trace Digester 的确定性失败分类；后续 Gate 按这些类别做回归比较。 */
export type FailureClass =
	| "none"
	| "cancelled"
	| "execution_timeout"
	| "lease_failure"
	| "endpoint_error"
	| "budget_exhausted"
	| "harvest_failure"
	| "tool_timeout"
	| "tool_execution"
	| "tool_selection"
	| "prompt_contract"
	| "context_missing"
	| "context_exhausted"
	| "model_capability"
	| "lost"
	| "unknown";

export type FailureComponent =
	"none" | "executor" | "model" | "agent" | "harvest" | "benchmark" | "unknown" | `tool:${string}`;

export interface DigestToolCall {
	id: string;
	name: string;
	sequence: number;
	arguments_excerpt: string;
	result: "ok" | "error" | "missing";
	error_excerpt: string | null;
	timeout: boolean;
	duration_ms: number | null;
}

export interface ExecutionDigest {
	execution_id: string;
	project_id: string;
	step_id: string;
	attempt: number;
	status: ExecutionStatus;
	outcome: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	duration_seconds: number | null;
	failure_class: FailureClass;
	component: FailureComponent;
	evidence: string[];
	error: string | null;
	summary: string | null;
	transcript: {
		events: number;
		messages: number;
		malformed: number;
		dropped: number;
		complete: boolean;
		truncated: boolean;
		assistant_stop_reasons: string[];
		assistant_text_chars: number;
		pending_tool: { name: string; arguments_excerpt: string } | null;
		harvested: boolean;
	};
	tokens: {
		input: number;
		output: number;
		cache_read: number;
		cache_write: number;
		total: number;
		source: "transcript" | "none";
	};
	/**
	 * usage_events 表按 step 聚合的 execute 用量（同一 step 的多次 attempt 合并）。
	 *
	 * 本次 attempt 的精确 token 始终以上面的 tokens（来自轨迹消息）为准：轨迹在
	 * 控制端实时落盘，取消/失联的执行即使没来得及上报 usage_events，也能从
	 * assistant.usage 还原；usage_events 则可能因回填/迟到上报而在单个 attempt
	 * 粒度上不完整。这里显式标记 scope，不把它伪装成本次 attempt 的精确 token。
	 */
	step_usage: {
		scope: "step";
		events: number;
		input_tokens: number;
		output_tokens: number;
		total_tokens: number;
	} | null;
	produced: {
		facts: number;
		findings: number;
	};
	benchmark: {
		unique_code: string;
		is_completed: boolean;
		correct_flag_count: number;
		flag_count: number;
		hint_used: boolean;
	} | null;
	tool_calls: DigestToolCall[];
}

export interface StepDigest {
	step_id: string;
	executions: number;
	failure_history: Array<{
		attempt: number;
		status: ExecutionStatus;
		failure_class: FailureClass;
		component: FailureComponent;
	}>;
}

export interface ProjectDigest {
	project_id: string;
	generated_at: string;
	experiment: ExperimentMetadata;
	executions: ExecutionDigest[];
	steps: StepDigest[];
	summary: {
		executions: number;
		by_status: Record<ExecutionStatus, number>;
		by_failure_class: Record<FailureClass, number>;
		by_component: Record<string, number>;
		tool_calls: number;
		tool_errors: number;
		tool_timeouts: number;
		dropped_events: number;
		tokens: {
			input: number;
			output: number;
			cache_read: number;
			cache_write: number;
			total: number;
		};
	};
}
