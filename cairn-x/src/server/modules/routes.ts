import { replayDecideCreation } from "../core/decide-mutations.js";
import { Hono } from "hono";

import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import { createRouteSchema } from "../models.js";
import { utcnow } from "../core/base.js";
import { nextRouteId } from "../core/ids.js";
import { getGoalOr404, getRouteOr404, requireGraphWriter } from "../core/project-guards.js";
import { routeToModel } from "../core/model-mappers.js";

/**
 * 攻击路线（假设）的创建与读取。路线把若干步骤归到同一个策略下，便于 Decide
 * 按方向归类证据、判断整条路线是否还在推进。
 *
 * 路线只有创建没有「放弃」入口：一旦方向失效，Decide 用 abandon_step 逐条废弃
 * 该路线下已无价值的步骤即可，不需要另一条会级联改图的写入路径。
 */
export function routeRoutes(db: Db): Hono {
	const app = new Hono();

	app.post("/projects/:id/routes", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, createRouteSchema);
		const create = db.transaction(() =>
			replayDecideCreation(db, pid, body.worker, body.request_id, "add_route", body, () => {
				requireGraphWriter(db, pid, { worker: body.worker, actor: body.actor });
				// 路线是"如何达成某个目标"的假设，省略 goal_id 时落到根目标 —— 与
				// add_route 的参数说明一致。没有归属的路线在图上悬空，规划者只能靠
				// 步骤的 goal_id 反推它服务谁。
				const goalId = body.goal_id ?? "goal";
				getGoalOr404(db, pid, goalId);
				const rid = nextRouteId(db, pid);
				db.prepare(
					"INSERT INTO routes (id, project_id, description, goal_id, creator, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				).run(rid, pid, body.description, goalId, body.worker ?? body.actor ?? "human", utcnow());
				return routeToModel(getRouteOr404(db, pid, rid));
			}),
		);
		const result = create.immediate();
		return c.json(result.data, result.replayed ? 200 : 201);
	});

	return app;
}
