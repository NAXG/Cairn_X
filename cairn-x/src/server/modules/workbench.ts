import { ApiError } from "../core/base.js";
import { Hono } from "hono";
import type { Db } from "../db.js";
import { conditionalRead, conditionalProjects } from "../core/read-versions.js";
import { getProjectOr404 } from "../core/project-guards.js";
import { expireWorkersThrottled, expireDecideLeases } from "../core/lease-expiry.js";
import {
	workbenchOverview,
	workbenchRecord,
	resolveRecord,
	recordPage,
	timelinePage,
	executionDetail,
	projectPage,
	pageLimit,
} from "../core/workbench.js";
export function workbenchRoutes(db: Db) {
	const app = new Hono();
	app.get("/projects/page", (c) => {
		expireWorkersThrottled(db);
		expireDecideLeases(db);
		return conditionalProjects(c, db, () =>
			projectPage(
				db,
				pageLimit(c.req.query("limit")),
				c.req.query("cursor"),
				c.req.query("query") ?? "",
			),
		);
	});
	app.get("/projects/:id/overview", (c) => {
		const pid = c.req.param("id");
		expireWorkersThrottled(db, pid);
		expireDecideLeases(db, pid);
		return conditionalRead(c, db, pid, "overview", () => workbenchOverview(db, pid));
	});
	app.get("/projects/:id/records/:type/:recordId", (c) => {
		const pid = c.req.param("id"),
			type = c.req.param("type"),
			id = c.req.param("recordId");
		getProjectOr404(db, pid);
		return conditionalRead(
			c,
			db,
			pid,
			"records",
			() => workbenchRecord(db, pid, type, id),
			() => resolveRecord(db, pid, type, id),
		);
	});
	app.get("/projects/:id/timeline", (c) =>
		conditionalRead(c, db, c.req.param("id"), "history", () =>
			timelinePage(db, c.req.param("id"), pageLimit(c.req.query("limit")), c.req.query("cursor")),
		),
	);
	for (const kind of ["findings", "hints", "goals"])
		app.get(`/projects/:id/${kind}/page`, (c) =>
			conditionalRead(c, db, c.req.param("id"), "history", () =>
				recordPage(
					db,
					c.req.param("id"),
					kind,
					pageLimit(c.req.query("limit")),
					c.req.query("cursor"),
				),
			),
		);
	app.get("/projects/:id/executions/:eid/detail", (c) =>
		conditionalRead(
			c,
			db,
			c.req.param("id"),
			"executions",
			() => executionDetail(db, c.req.param("id"), c.req.param("eid")),
			() => {
				if (
					!db
						.prepare("SELECT 1 FROM executions WHERE project_id=? AND id=?")
						.get(c.req.param("id"), c.req.param("eid"))
				)
					throw new ApiError(404, "Execution not found");
			},
		),
	);
	return app;
}
