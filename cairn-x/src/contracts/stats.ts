import type { ExecutionStatus } from "./execution.js";

export interface ExperimentMetadata {
	experiment_id: string | null;
	harness_variant: string | null;
	profile_revision: number | null;
	prompt_hash: string | null;
	tools_hash: string | null;
	model_id: string | null;
}

export interface UsageStats {
	events: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** input + output；缓存 token 单独统计，不计入这里。 */
	total_tokens: number;
}

export interface StepExecutionStats {
	step_id: string;
	executions: number;
	max_attempt: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	lost: number;
	avg_seconds: number | null;
	p95_seconds: number | null;
}

export interface ProjectStats {
	project_id: string;
	generated_at: string;
	experiment: ExperimentMetadata;
	executions: {
		total: number;
		by_status: Record<ExecutionStatus, number>;
		avg_attempts: number;
		p95_seconds: number | null;
		dropped_events: number;
		by_step: StepExecutionStats[];
	};
	usage: {
		decide: UsageStats;
		execute: UsageStats;
		total: UsageStats;
	};
	yield: {
		facts: number;
		findings: number;
		facts_per_execution: number;
		findings_per_execution: number;
		tokens_per_fact: number | null;
	};
	reliability: {
		lost: number;
		cancelled: number;
		failed: number;
		timeout_failures: number;
		unhealthy_failures: number;
		lease_failures: number;
	};
	benchmark: {
		tasks: number;
		flags_total: number;
		flags_correct: number;
		completion_ratio: number;
		hint_used: number;
		completed: number;
	} | null;
}
