import { Hono } from "hono";
import type { Db } from "../db.js";
import { validApiToken, type AuthConfig } from "../auth.js";
import { ApiError } from "../core/base.js";
import { expireWorkers, expireWorkersThrottled, expireDecideLeases } from "../core/lease-expiry.js";
import {
	schedulingProjects,
	schedulingProjectState,
	schedulingCandidates,
} from "../core/scheduling.js";

export function schedulingRoutes(db: Db, auth?: AuthConfig): Hono {
	const app = new Hono();
	app.use("/internal/scheduling/*", async (c, next) => {
		if (auth && !validApiToken(auth, c.req.header("authorization")))
			throw new ApiError(401, "Control API token required");
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.get("/internal/scheduling/projects", (c) => {
		expireWorkersThrottled(db);
		expireDecideLeases(db);
		return c.json(db.transaction(() => schedulingProjects(db))());
	});
	app.get("/internal/scheduling/projects/:id/state", (c) =>
		c.json(schedulingProjectState(db, c.req.param("id"))),
	);
	app.get("/internal/scheduling/projects/:id/candidates", (c) => {
		const raw = c.req.query("limit");
		if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) throw new ApiError(400, "Invalid limit");
		const pid = c.req.param("id");
		// Commit expiry effects before the read snapshot or any subsequent claim rejection.
		expireWorkers(db, pid);
		expireDecideLeases(db, pid);
		return c.json(
			db.transaction(() =>
				schedulingCandidates(
					db,
					pid,
					raw === undefined ? 1 : Number(raw),
					c.req.queries("exclude") ?? [],
				),
			)(),
		);
	});
	return app;
}
