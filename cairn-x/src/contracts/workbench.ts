import type {
	ProjectUsage,
	ProjectPlanning,
	ProjectMeta,
	FactModel,
	GoalModel,
	FindingModel,
	HintModel,
	RouteModel,
	StepModel,
} from "./models.js";
import type { ExecutionSummary } from "./transcripts.js";

export interface ReadPage<T> {
	items: T[];
	next_cursor: string | null;
}
export interface WorkbenchOverview {
	project: Omit<ProjectMeta, "finding_schema">;
	planning: ProjectPlanning;
	usage: ProjectUsage;
	counts: {
		facts: number;
		goals: number;
		steps: number;
		findings: number;
		hints: number;
		open_steps: number;
		running: number;
		queued: number;
	};
	active_executions: Array<ExecutionSummary & { step_description: string }>;
	latest_failure: ExecutionSummary | null;
	latest_finding: { id: string; title: string; created_at: string } | null;
}
type WorkbenchStep = Omit<StepModel, "worker" | "lease_version" | "last_heartbeat_at"> & {
	produced_fact_ids: string[];
};
export type WorkbenchRecord =
	| { type: "fact"; record: FactModel }
	| { type: "goal"; record: GoalModel }
	| { type: "finding"; record: FindingModel }
	| { type: "hint"; record: HintModel }
	| { type: "step"; record: WorkbenchStep }
	| { type: "route"; record: RouteModel };
export interface TimelineItem {
	key: string;
	t: string;
	title: string;
	body: string;
	step: string;
	record_type: string;
	record_id: string;
	truncated: boolean;
}
export interface ExecutionDetail {
	execution: ExecutionSummary;
	previous: ExecutionSummary | null;
	next: ExecutionSummary | null;
}
export type RecordPreview = {
	id: string;
	title?: string;
	description?: string;
	content?: string;
	status?: string;
	parent_goal_id?: string | null;
	creator?: string;
	created_at: string;
	truncated: boolean;
};
