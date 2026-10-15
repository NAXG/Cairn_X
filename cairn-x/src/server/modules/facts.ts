import { Hono } from "hono";
import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import { createFactSchema } from "../models.js";
import { requireEvidenceWriter } from "../core/project-guards.js";
import { createFact } from "../core/facts.js";

export function factRoutes(db: Db): Hono {
	const app = new Hono();
	app.post("/projects/:id/facts", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, createFactSchema);
		requireEvidenceWriter(db, pid, body);
		const result = createFact(db, pid, body);
		if (result.duplicate) return c.json({ id: result.model.id, duplicate: true }, 200);
		return c.json({ ...result.model, duplicate: false }, 201);
	});
	return app;
}
