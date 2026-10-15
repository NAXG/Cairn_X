import { Hono } from "hono";
import type { Db } from "../db.js";
import { requireDecideLease } from "../core/project-guards.js";
import { eventSearchOptionsFromQuery, searchExecutionEvents } from "../core/event-search.js";

/** 控制台/Decide 侧的过程检索（session 或机器 token；worker 参数绑定有效 Decide 租约）。 */
export function eventSearchRoutes(db: Db): Hono {
	const app = new Hono();
	app.get("/projects/:id/events/search", (c) => {
		const worker = c.req.query("worker");
		if (worker !== undefined) requireDecideLease(db, c.req.param("id"), worker);
		return c.json(
			searchExecutionEvents(
				db,
				c.req.param("id"),
				c.req.query("q"),
				eventSearchOptionsFromQuery((name) => c.req.query(name)),
			),
		);
	});
	return app;
}
