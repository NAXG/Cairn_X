import type { Db } from "../db.js";

export function nextProjectId(db: Db): string {
	const row = db
		.prepare("UPDATE counters SET value = value + 1 WHERE name = 'project' RETURNING value")
		.get() as { value: number };
	return `proj_${String(row.value).padStart(3, "0")}`;
}

function nextScopedId(db: Db, kind: string, prefix: string, projectId: string): string {
	const row = db
		.prepare(
			`INSERT INTO scoped_counters (project_id, kind, value) VALUES (?, ?, 1)
			 ON CONFLICT (project_id, kind) DO UPDATE SET value = value + 1 RETURNING value`,
		)
		.get(projectId, kind) as { value: number };
	return `${prefix}${String(row.value).padStart(3, "0")}`;
}

export function nextFactId(db: Db, projectId: string): string {
	return nextScopedId(db, "fact", "f", projectId);
}

export function nextStepId(db: Db, projectId: string): string {
	return nextScopedId(db, "step", "s", projectId);
}

export function nextGoalId(db: Db, projectId: string): string {
	return nextScopedId(db, "goal", "g", projectId);
}

export function nextRouteId(db: Db, projectId: string): string {
	return nextScopedId(db, "route", "t", projectId);
}

export function nextHintId(db: Db, projectId: string): string {
	return nextScopedId(db, "hint", "h", projectId);
}

export function nextFindingId(db: Db, projectId: string): string {
	return nextScopedId(db, "finding", "r", projectId);
}
