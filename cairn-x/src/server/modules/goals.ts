import { replayDecideCreation } from "../core/decide-mutations.js";
import { Hono } from "hono";

import type { Db } from "../db.js";
import { withDecideChanges } from "../core/decide-changes.js";
import { parseBody } from "../http.js";
import { achieveGoalSchema, createGoalSchema } from "../models.js";
import { ApiError, utcnow } from "../core/base.js";
import { nextGoalId } from "../core/ids.js";
import { requireGraphWriter, getGoalOr404 } from "../core/project-guards.js";
import { achieveProjectGoal } from "../core/goal-completion.js";
import { goalToModel } from "../core/model-mappers.js";

export function goalRoutes(db: Db): Hono {
	const app = new Hono();

	app.post("/projects/:id/goals", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, createGoalSchema);
		// 与 steps/facts/findings 对齐：ID 分配、父目标校验与写入必须原子，
		// 否则第二个写库进程（如 cairn-x digest）就可能撞出重复的 goal id。
		const create = db.transaction(() =>
			replayDecideCreation(db, pid, body.worker, body.request_id, "add_goal", body, () => {
				requireGraphWriter(db, pid, body);
				const parentId = body.parent_goal_id ?? "goal";
				const parent = getGoalOr404(db, pid, parentId);
				if (parent.status !== "pending") {
					throw new ApiError(409, `Parent goal is ${parent.status}`);
				}
				const now = utcnow();
				const gid = nextGoalId(db, pid);
				withDecideChanges(db, pid, body.worker, () => {
					db.prepare(
						"INSERT INTO goals (id, project_id, parent_goal_id, description, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
					).run(gid, pid, parentId, body.description, now);
				});
				return goalToModel(db, getGoalOr404(db, pid, gid));
			}),
		);
		const result = create.immediate();
		return c.json(result.data, result.replayed ? 200 : 201);
	});

	app.delete("/projects/:id/goals/:gid", (c) => {
		const pid = c.req.param("id");
		const gid = c.req.param("gid");
		const remove = db.transaction(() => {
			requireGraphWriter(db, pid, {
				worker: c.req.query("worker"),
				actor: c.req.query("actor") === "human" ? "human" : undefined,
			});
			const goal = getGoalOr404(db, pid, gid);
			if (goal.id === "goal") {
				throw new ApiError(400, "Root goal cannot be deleted");
			}
			if (goal.status !== "pending") {
				throw new ApiError(409, `Goal is ${goal.status}`);
			}
			const pendingChild = db
				.prepare(
					"SELECT 1 AS ok FROM goals WHERE project_id = ? AND parent_goal_id = ? AND status = 'pending'",
				)
				.get(pid, gid);
			if (pendingChild !== undefined) {
				throw new ApiError(409, "Goal has pending sub goals");
			}
			return withDecideChanges(db, pid, c.req.query("worker"), () => {
				// Reparent achieved children to the deleted goal's parent, preserving the
				// evidence chain. Without this, achieved children would dangle under a
				// deleted goal id and the tree would lose their subtree.
				const goals = db
					.prepare(
						"UPDATE goals SET parent_goal_id = ? WHERE project_id = ? AND parent_goal_id = ?",
					)
					.run(goal.parent_goal_id, pid, gid);
				const steps = db
					.prepare("UPDATE steps SET goal_id = NULL WHERE project_id = ? AND goal_id = ?")
					.run(pid, gid);
				// Routes always serve a goal. Keep them attached to the surviving parent.
				const routes = db
					.prepare("UPDATE routes SET goal_id = ? WHERE project_id = ? AND goal_id = ?")
					.run(goal.parent_goal_id ?? "goal", pid, gid);
				db.prepare("DELETE FROM goal_evidence WHERE project_id = ? AND goal_id = ?").run(pid, gid);
				db.prepare("DELETE FROM goals WHERE id = ? AND project_id = ?").run(gid, pid);
				return {
					id: gid,
					status: "removed",
					effects: {
						reparented_goal_count: goals.changes,
						detached_step_count: steps.changes,
						reparented_route_count: routes.changes,
					},
				};
			});
		});
		const receipt = remove.immediate();
		return c.req.query("effects") === "true" ? c.json(receipt) : c.body(null, 204);
	});

	app.post("/projects/:id/goals/:gid/achieve", async (c) => {
		const pid = c.req.param("id");
		const gid = c.req.param("gid");
		const body = await parseBody(c, achieveGoalSchema);
		const achieve = db.transaction(() => {
			const pending =
				gid === "goal"
					? (db
							.prepare("SELECT id FROM steps WHERE project_id=? AND status IN ('open','claimed')")
							.all(pid) as Array<{ id: string }>)
					: [];
			const running =
				gid === "goal"
					? (db
							.prepare(
								"SELECT id FROM executions WHERE project_id=? AND status IN ('queued','running')",
							)
							.all(pid) as Array<{ id: string }>)
					: [];
			const goal = achieveProjectGoal(db, pid, gid, body);
			return gid === "goal"
				? {
						...goal,
						effects: {
							project_completed: true,
							abandoned_step_ids: pending.slice(0, 20).map((s) => s.id),
							abandoned_step_count: pending.length,
							cancelled_execution_ids: running.slice(0, 20).map((e) => e.id),
							cancelled_execution_count: running.length,
							truncated: pending.length > 20 || running.length > 20,
						},
					}
				: goal;
		});
		return c.json(achieve.immediate());
	});

	return app;
}
