import {
	cachedPrepare,
	type Db,
	type GoalRow,
	type ProjectRow,
	type RouteRow,
	type StepRow,
} from "../db.js";
import { ApiError } from "./base.js";
import { getDecideRead } from "./decide-changes.js";
import { expireDecideLeases, expireWorkers } from "./lease-expiry.js";

export function getProjectOr404(db: Db, projectId: string): ProjectRow {
	const row = cachedPrepare(db, "SELECT * FROM projects WHERE id = ?").get(projectId) as
		ProjectRow | undefined;
	if (row === undefined) {
		throw new ApiError(404, "Project not found");
	}
	return row;
}

export function checkProjectActive(db: Db, projectId: string): ProjectRow {
	const row = getProjectOr404(db, projectId);
	if (row.status !== "active") {
		throw new ApiError(403, `Project is ${row.status}`);
	}
	return row;
}

/**
 * 用量遥测的写入闸门：decide 用量允许在最后一次 decide 运行完成项目
 * 之后落地（达成目标的那次运行在项目完成后才上报用量）。execute 用量
 * 只在项目 active 时接受：Worker 用量与结果同事务提交，取消/失联路径
 * 由控制端在终态化时回填，项目完成后不可能再有合法的 execute 用量。
 */
export function checkProjectUsageWritable(
	db: Db,
	projectId: string,
	activity: "decide" | "execute",
): ProjectRow {
	const row = getProjectOr404(db, projectId);
	const allowed = activity === "decide" ? ["active", "completed"] : ["active"];
	if (allowed.includes(row.status)) {
		return row;
	}
	throw new ApiError(403, `Project is ${row.status}`);
}

export function validateFactsExist(db: Db, projectId: string, factIds: string[]): void {
	const stmt = cachedPrepare(db, "SELECT 1 AS ok FROM facts WHERE id = ? AND project_id = ?");
	for (const fid of factIds) {
		if (stmt.get(fid, projectId) === undefined) {
			throw new ApiError(404, `Fact ${fid} not found`);
		}
	}
}

export function validateGoalNotInSources(factIds: string[]): void {
	if (factIds.includes("goal")) {
		throw new ApiError(400, "goal cannot be used in from");
	}
}

export function validateStepCreatorWorker(
	creator: string,
	worker: string | null | undefined,
): void {
	if (worker != null && worker !== creator) {
		throw new ApiError(400, "worker must be null or equal to creator");
	}
}

export function getStepOr404(db: Db, projectId: string, stepId: string): StepRow {
	const row = cachedPrepare(db, "SELECT * FROM steps WHERE id = ? AND project_id = ?").get(
		stepId,
		projectId,
	) as StepRow | undefined;
	if (row === undefined) {
		throw new ApiError(404, "Step not found");
	}
	return row;
}

export function getGoalOr404(db: Db, projectId: string, goalId: string): GoalRow {
	const row = cachedPrepare(db, "SELECT * FROM goals WHERE id = ? AND project_id = ?").get(
		goalId,
		projectId,
	) as GoalRow | undefined;
	if (row === undefined) {
		throw new ApiError(404, "Goal not found");
	}
	return row;
}

export function getRouteOr404(db: Db, projectId: string, routeId: string): RouteRow {
	const row = cachedPrepare(db, "SELECT * FROM routes WHERE id = ? AND project_id = ?").get(
		routeId,
		projectId,
	) as RouteRow | undefined;
	if (row === undefined) {
		throw new ApiError(404, "Route not found");
	}
	return row;
}

export function getClaimableOpenStepOr404(
	db: Db,
	projectId: string,
	stepId: string,
	worker: string,
	reap = true,
): StepRow {
	if (reap) expireWorkers(db, projectId);
	const row = getStepOr404(db, projectId, stepId);
	if (row.status === "concluded") {
		throw new ApiError(409, "Step already concluded");
	}
	if (row.status === "abandoned") {
		throw new ApiError(409, "Step already abandoned");
	}
	if (row.worker !== null && row.worker !== worker) {
		throw new ApiError(409, `Step is currently claimed by ${row.worker}`);
	}
	return row;
}

/** Renew/commit requires ownership; unlike claiming, an open step is not acceptable. */
export function requireStepLease(
	db: Db,
	projectId: string,
	stepId: string,
	worker: string,
): StepRow {
	const row = getClaimableOpenStepOr404(db, projectId, stepId, worker);
	if (row.status !== "claimed" || row.worker !== worker)
		throw new ApiError(409, "Step lease is not held by caller");
	return row;
}

export function requireDecideLease(db: Db, projectId: string, worker: string): void {
	expireDecideLeases(db, projectId);
	const project = checkProjectActive(db, projectId);
	if (project.decide_worker !== worker)
		throw new ApiError(409, "Decide lease is not held by caller");
}

/** Human mutations explicitly declare actor=human; agent mutations carry their current lease identity. */
export function requireGraphWriter(
	db: Db,
	projectId: string,
	writer: { worker?: string | null; actor?: "human" },
): void {
	checkProjectActive(db, projectId);
	if (writer.worker) {
		requireDecideLease(db, projectId, writer.worker);
		const read = getDecideRead(db, projectId, writer.worker);
		if (read?.coverage_complete !== 1) {
			throw new ApiError(
				409,
				read?.next_cursor
					? `Planning graph coverage incomplete; continue get_graph with cursor ${read.next_cursor}`
					: "Planning graph has not been read; call get_graph with view=planning",
			);
		}
	} else if (writer.actor !== "human") throw new ApiError(400, "Provide worker or actor=human");
}

export function requireEvidenceWriter(
	db: Db,
	projectId: string,
	writer: { worker?: string | null; step_id?: string | null; actor?: "human" },
): void {
	checkProjectActive(db, projectId);
	if (writer.worker) {
		if (!writer.step_id) throw new ApiError(400, "step_id is required for worker evidence");
		requireStepLease(db, projectId, writer.step_id, writer.worker);
	} else {
		if (writer.actor !== "human") throw new ApiError(400, "Provide worker or actor=human");
		if (writer.step_id) getStepOr404(db, projectId, writer.step_id);
	}
}
