/**
 * 项目级常驻 Worker 的注册与项目令牌。
 *
 * 每个 active 项目最多一个常驻容器：dispatcher 先取得项目令牌（库中只存
 * 哈希），把它注入容器；容器内的并发 step 循环用项目令牌调用
 * POST /internal/project-workers/:projectId/next 领取任务，服务端在那一刻
 * 才为选中的 execution 现签短期执行令牌。
 *
 * 因此执行令牌从不预先交给容器，也不会跨 execution 复用；既有
 * /internal/executions/:id/* 的鉴权边界与租约语义完全不变。
 */

import { randomBytes } from "node:crypto";

import type { Db, ProjectWorkerRow } from "../db.js";
import { ApiError, utcnow } from "./base.js";
import { getProjectOr404 } from "./project-guards.js";
import { hashToken } from "./tokens.js";

type ProjectWorkerStatus = ProjectWorkerRow["status"];

/** 对外视图：绝不包含 token_hash。 */
interface ProjectWorkerView {
	project_id: string;
	status: ProjectWorkerStatus;
	container_name: string | null;
	created_at: string;
	last_seen_at: string | null;
	stopped_at: string | null;
}

/** 运维视图：列出全部项目常驻 Worker 注册行（按创建时间）。 */
export function listProjectWorkers(db: Db): ProjectWorkerRow[] {
	return db.prepare("SELECT * FROM project_workers ORDER BY created_at, project_id").all() as
		ProjectWorkerRow[] | [];
}

export function getProjectWorker(db: Db, projectId: string): ProjectWorkerRow | undefined {
	return db.prepare("SELECT * FROM project_workers WHERE project_id = ?").get(projectId) as
		ProjectWorkerRow | undefined;
}

export function projectWorkerView(row: ProjectWorkerRow): ProjectWorkerView {
	return {
		project_id: row.project_id,
		status: row.status,
		container_name: row.container_name,
		created_at: row.created_at,
		last_seen_at: row.last_seen_at,
		stopped_at: row.stopped_at,
	};
}

/**
 * dispatcher 为项目签发（或轮换）项目令牌。
 * 轮换会重置 last_seen_at 与 stopped_at（新容器重新开始生命周期）。
 */
export function issueProjectWorkerToken(
	db: Db,
	projectId: string,
	containerName: string | null = null,
): { token: string; view: ProjectWorkerView } {
	getProjectOr404(db, projectId);
	const token = randomBytes(32).toString("hex");
	db.prepare(
		`INSERT INTO project_workers (project_id, token_hash, status, container_name, created_at, last_seen_at, stopped_at)
		 VALUES (?, ?, 'pending', ?, ?, NULL, NULL)
		 ON CONFLICT(project_id) DO UPDATE SET
		   token_hash = excluded.token_hash,
		   status = 'pending',
		   container_name = excluded.container_name,
		   created_at = excluded.created_at,
		   last_seen_at = NULL,
		   stopped_at = NULL`,
	).run(projectId, hashToken(token), containerName, utcnow());
	return { token, view: projectWorkerView(getProjectWorker(db, projectId)!) };
}

/** 所有项目令牌接口的身份入口。已停止的令牌立即失效。 */
export function requireProjectWorkerByToken(db: Db, token: string | undefined): ProjectWorkerRow {
	if (!token) {
		throw new ApiError(401, "Project worker token required");
	}
	const row = db
		.prepare("SELECT * FROM project_workers WHERE token_hash = ?")
		.get(hashToken(token)) as ProjectWorkerRow | undefined;
	if (row === undefined) {
		throw new ApiError(401, "Invalid project worker token");
	}
	if (row.status === "stopped") {
		throw new ApiError(403, "Project worker is stopped");
	}
	const project = db.prepare("SELECT status FROM projects WHERE id = ?").get(row.project_id) as
		{ status: string } | undefined;
	if (project?.status !== "active") throw new ApiError(403, "Project is not active");
	return row;
}

/** 项目容器存活心跳：pending → running，刷新 last_seen_at。 */
export function touchProjectWorker(db: Db, projectId: string): void {
	const now = utcnow();
	db.prepare(
		"UPDATE project_workers SET status = 'running', last_seen_at = ? WHERE project_id = ? AND status <> 'stopped'",
	).run(now, projectId);
}

/** 控制端停止项目容器（幂等）：令牌随之作废。 */
export function stopProjectWorker(db: Db, projectId: string): void {
	const now = utcnow();
	db.prepare(
		"UPDATE project_workers SET status = 'stopped', stopped_at = ?, last_seen_at = ? WHERE project_id = ?",
	).run(now, now, projectId);
}
