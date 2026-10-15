import { Hono } from "hono";

import type { Db } from "../db.js";
import { buildExecutionDigest, buildProjectDigest } from "../core/digest.js";
import { ApiError } from "../core/base.js";

function integerQuery(raw: string | undefined, label: string): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	if (Number.isSafeInteger(value) === false) {
		throw new ApiError(400, "Invalid " + label);
	}
	return value;
}

export function digestRoutes(db: Db): Hono {
	const app = new Hono();
	app.get("/projects/:id/digest", (c) =>
		c.json(
			buildProjectDigest(db, c.req.param("id"), {
				step_id: c.req.query("step_id") || undefined,
				limit: integerQuery(c.req.query("limit"), "limit"),
				event_limit: integerQuery(c.req.query("event_limit"), "event_limit"),
			}),
		),
	);
	app.get("/projects/:id/executions/:execution_id/digest", (c) =>
		c.json(
			buildExecutionDigest(db, c.req.param("id"), c.req.param("execution_id"), {
				event_limit: integerQuery(c.req.query("event_limit"), "event_limit"),
			}),
		),
	);
	return app;
}
