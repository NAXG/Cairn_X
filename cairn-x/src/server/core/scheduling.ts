import type { Db } from "../db.js";
import type {
	SchedulingProject,
	SchedulingProjectState,
	SchedulingCandidates,
	SchedulingCandidate,
} from "../../contracts/scheduling.js";
import { ApiError } from "./base.js";
import { hasPendingStepResultBarrier } from "./decide.js";

/** Used both by candidate selection and the final claim transaction; s is the target Step. */
const dependenciesConcluded = `NOT EXISTS (
	SELECT 1 FROM json_each(COALESCE(s.waiting_on,'[]')) dep
	LEFT JOIN steps d ON d.project_id=s.project_id AND d.id=dep.value
	WHERE d.id IS NULL OR d.status<>'concluded'
)`;

export function requireConcludedDependencies(db: Db, pid: string, sid: string): void {
	if (
		!db
			.prepare(`SELECT 1 FROM steps s WHERE s.project_id=? AND s.id=? AND ${dependenciesConcluded}`)
			.get(pid, sid)
	)
		throw new ApiError(409, "Step dependencies must all exist and be concluded");
}

export function schedulingProjectState(db: Db, pid: string): SchedulingProjectState {
	const row = db.prepare("SELECT id,status FROM projects WHERE id=?").get(pid) as
		SchedulingProjectState | undefined;
	if (!row) throw new ApiError(404, "Project not found");
	return row;
}

export function schedulingProjects(db: Db): SchedulingProject[] {
	const rows = db
		.prepare(
			`SELECT p.id,p.status,p.decide_worker,
	 EXISTS(SELECT 1 FROM steps WHERE project_id=p.id AND status='open') has_open_steps,
	 EXISTS(SELECT 1 FROM steps WHERE project_id=p.id AND status='claimed') has_claimed_steps
	 FROM projects p ORDER BY p.created_at,p.id`,
		)
		.all() as Array<
		Omit<SchedulingProject, "has_open_steps" | "has_claimed_steps"> & {
			has_open_steps: number;
			has_claimed_steps: number;
		}
	>;
	return rows.map((row) => ({
		...row,
		has_open_steps: !!row.has_open_steps,
		has_claimed_steps: !!row.has_claimed_steps,
	}));
}

export function schedulingCandidates(
	db: Db,
	pid: string,
	limit = 1,
	exclude: string[] = [],
): SchedulingCandidates {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
		throw new ApiError(400, "limit must be between 1 and 20");
	if (exclude.length > 128 || exclude.some((id) => typeof id !== "string" || !id.trim()))
		throw new ApiError(400, "exclude must contain at most 128 nonempty Step IDs");
	const project = schedulingProjectState(db, pid);
	const row = db.prepare("SELECT decide_worker FROM projects WHERE id=?").get(pid) as {
		decide_worker: string | null;
	};
	const blocked_reason =
		project.status !== "active"
			? "inactive"
			: row.decide_worker !== null
				? "decide_running"
				: hasPendingStepResultBarrier(db, pid)
					? "pending_step_result"
					: null;
	const candidates = blocked_reason
		? []
		: (db
				.prepare(
					`SELECT s.id,s.priority,s.created_at FROM steps s
	 WHERE s.project_id=? AND s.status='open' AND s.worker IS NULL
	 AND s.id NOT IN (SELECT value FROM json_each(?)) AND ${dependenciesConcluded}
	 ORDER BY s.priority DESC,s.created_at DESC,s.id DESC LIMIT ?`,
				)
				.all(pid, JSON.stringify(exclude), limit) as SchedulingCandidate[]);
	return { project, blocked_reason, candidates };
}
