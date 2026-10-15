import type { ProjectStatus } from "./models.js";

export interface SchedulingProjectState {
	id: string;
	status: ProjectStatus;
}

export interface SchedulingProject extends SchedulingProjectState {
	decide_worker: string | null;
	has_open_steps: boolean;
	has_claimed_steps: boolean;
}

export interface SchedulingCandidate {
	id: string;
	priority: number;
	created_at: string;
}

export interface SchedulingCandidates {
	project: SchedulingProjectState;
	blocked_reason: "inactive" | "decide_running" | "pending_step_result" | null;
	candidates: SchedulingCandidate[];
}
