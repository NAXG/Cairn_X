import { Hono } from "hono";
import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import { createUsageEventSchema } from "../models.js";
import { recordUsage } from "../core/usage.js";

export function usageRoutes(db: Db): Hono {
	const app = new Hono();
	app.post("/projects/:id/usage", async (c) => {
		const body = await parseBody(c, createUsageEventSchema);
		return c.json(recordUsage(db, c.req.param("id"), body), 201);
	});
	return app;
}
