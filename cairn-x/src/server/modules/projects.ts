import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { getProjectWorker } from "../core/project-workers.js";
import { buildProjectStats } from "../core/stats.js";
import { consoleLogger } from "../../shared/logger.js";

import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import {
	completeProjectSchema,
	createProjectSchema,
	updateProjectStatusSchema,
} from "../models.js";
import { ApiError, utcnow } from "../core/base.js";
import { nextHintId, nextProjectId } from "../core/ids.js";
import { discardActivityResources } from "../../control/resources.js";
import { achieveProjectGoal } from "../core/goal-completion.js";
import { cancelStepExecutions } from "../core/execution-cascade.js";
import { clearProjectDecide, expireDecideLeases } from "../core/lease-expiry.js";
import { getProjectOr404 } from "../core/project-guards.js";
import { projectMetaFromRow } from "../core/model-mappers.js";

export function projectRoutes(
	db: Db,
	cleanupProject?: (projectId: string) => Promise<void>,
	dataRoot?: string,
): Hono {
	const app = new Hono();

	// Browser-facing observation only; never expose worker credentials.
	app.get("/projects/:id/environment", (c) => {
		const id = c.req.param("id");
		getProjectOr404(db, id);
		const worker = getProjectWorker(db, id);
		if (!worker) return c.json({ status: "unavailable", last_seen_at: null });
		const lastSeen = worker.last_seen_at;
		const stale = Date.now() - Date.parse(lastSeen ?? worker.created_at) > 60_000;
		return c.json({
			status: worker.status === "stopped" ? "stopped" : stale ? "unresponsive" : worker.status,
			last_seen_at: lastSeen,
		});
	});

	app.get("/projects/:id/stats", (c) => c.json(buildProjectStats(db, c.req.param("id"))));

	app.post("/projects", async (c) => {
		const body = await parseBody(c, createProjectSchema);
		const create = db.transaction(() => {
			const pid = nextProjectId(db);
			const now = utcnow();
			db.prepare(
				"INSERT INTO projects (id, title, status, created_at, finding_schema, experiment_id, harness_variant) VALUES (?, ?, 'active', ?, ?, ?, ?)",
			).run(
				pid,
				body.title,
				now,
				body.finding_schema === undefined ? null : JSON.stringify(body.finding_schema),
				body.experiment_id ?? null,
				body.harness_variant ?? null,
			);
			db.prepare(
				"INSERT INTO facts (id, project_id, description, created_at) VALUES ('origin', ?, ?, ?)",
			).run(pid, body.origin, now);
			db.prepare(
				"INSERT INTO goals (id, project_id, parent_goal_id, description, status, created_at) VALUES ('goal', ?, NULL, ?, 'pending', ?)",
			).run(pid, body.goal, now);
			for (const hint of body.hints ?? []) {
				db.prepare(
					"INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
				).run(nextHintId(db, pid), pid, hint.content, hint.creator, now);
				if (hint.persistent)
					db.prepare(
						"INSERT INTO persistent_hints(project_id,hint_id) SELECT project_id,id FROM hints WHERE project_id=? ORDER BY rowid DESC LIMIT 1",
					).run(pid);
			}
			return pid;
		});
		const pid = create.immediate();
		return c.json({ project: projectMetaFromRow(getProjectOr404(db, pid)) }, 201);
	});

	app.post("/projects/:id/status", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, updateProjectStatusSchema);
		const update = db.transaction(() => {
			expireDecideLeases(db, pid);
			const row = getProjectOr404(db, pid);
			if (row.status === "completed") {
				throw new ApiError(409, "Completed projects cannot change status");
			}
			if (row.status !== body.status) {
				db.prepare("UPDATE projects SET status = ? WHERE id = ?").run(body.status, pid);
				if (body.status === "stopped") {
					const now = utcnow();
					const inFlight = db
						.prepare(
							"SELECT DISTINCT step_id FROM executions WHERE project_id = ? AND status IN ('queued', 'running')",
						)
						.all(pid) as Array<{ step_id: string }>;
					for (const execution of inFlight)
						cancelStepExecutions(
							db,
							pid,
							execution.step_id,
							now,
							"Project stopped; in-flight execution cancelled by controller",
						);
					db.prepare(
						// 同 release：归还租约必须递增 lease_version，作废在途执行者的写入。
						"UPDATE steps SET worker = NULL, status = 'open', lease_expires_at = NULL, lease_version = lease_version + 1 WHERE project_id = ? AND status = 'claimed'",
					).run(pid);
					clearProjectDecide(db, pid);
				}
			}
			return projectMetaFromRow(getProjectOr404(db, pid));
		});
		return c.json(update.immediate());
	});

	app.post("/projects/:id/complete", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, completeProjectSchema);
		const complete = db.transaction(() => {
			const goal = achieveProjectGoal(db, pid, "goal", body);
			return { goal, project: projectMetaFromRow(getProjectOr404(db, pid)) };
		});
		return c.json(complete.immediate());
	});

	app.delete("/projects/:id", async (c) => {
		const pid = c.req.param("id");
		/** 该项目的活动快照 id：删表之前先取出来，用于清理它们的资源目录。 */
		let snapshotIds: string[] = [];
		const remove = db.transaction(() => {
			const row = getProjectOr404(db, pid);
			if (row.status === "active") {
				throw new ApiError(409, "Stop the project before deleting it");
			}
			db.prepare("DELETE FROM projects WHERE id = ?").run(pid);
			// control 模块的行无外键约束：decide 活动快照与活动令牌随项目一并清理。
			// （表仅在 control 初始化后存在；纯 server 部署中跳过。）
			const hasTable = (name: string) =>
				db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
				undefined;
			if (hasTable("activity_configurations")) {
				snapshotIds = (
					db
						.prepare(
							"SELECT id FROM activity_configurations WHERE json_extract(body, '$.project_id') = ?",
						)
						.all(pid) as Array<{ id: string }>
				).map((entry) => entry.id);
				db.prepare(
					"DELETE FROM activity_configurations WHERE json_extract(body, '$.project_id') = ?",
				).run(pid);
			}
			if (hasTable("configuration_objects")) {
				db.prepare(
					"DELETE FROM configuration_objects WHERE kind = 'activity-token' AND json_extract(body, '$.project_id') = ?",
				).run(pid);
			}
		});
		remove();
		if (cleanupProject !== undefined) {
			try {
				await cleanupProject(pid);
			} catch (err) {
				consoleLogger.error(
					`project ${pid} deleted but its uploads directory could not be removed: ${String(err)}`,
				);
			}
		}
		if (dataRoot !== undefined) {
			// 活动资源目录（agentDir）与快照 id 一一对应，没有数据库引用：快照行已随
			// 项目删除，这里把它们在数据目录里的残留一并清掉。
			discardActivityResources(dataRoot, snapshotIds);
			// 项目分区的会话轨迹随删除一并清理；失败不阻塞删除
			// （best-effort：目录不存在或权限问题只记录日志）。
			const projectDir = path.join(dataRoot, pid);
			for (const dir of [path.join(projectDir, "sessions")]) {
				try {
					await rm(dir, { recursive: true, force: true });
				} catch (err) {
					consoleLogger.error(
						`project ${pid} deleted but ${dir} could not be removed: ${String(err)}`,
					);
				}
			}
			// 空的项目目录本身不再保留；非空时 rmdir 抛 ENOTEMPTY，自然跳过。
			try {
				await rmdir(projectDir);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTEMPTY") {
					consoleLogger.error(
						`project ${pid} deleted but ${projectDir} could not be removed: ${String(err)}`,
					);
				}
			}
		}
		return c.body(null, 204);
	});

	return app;
}
