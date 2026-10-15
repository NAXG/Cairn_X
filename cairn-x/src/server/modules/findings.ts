import { Hono } from "hono";
import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import { createFindingSchema } from "../models.js";
import { requireEvidenceWriter } from "../core/project-guards.js";
import { createFinding } from "../core/findings.js";

export function findingRoutes(db: Db): Hono {
	const app = new Hono();
	app.post("/projects/:id/findings", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, createFindingSchema);
		const result = createFinding(db, pid, body, {
			authorize: () => requireEvidenceWriter(db, pid, body),
		});
		return c.json({ ...result.model, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
	});
	return app;
}
