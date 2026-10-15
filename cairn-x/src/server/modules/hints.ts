import { z } from "zod";
import { signalDecideExternal } from "../core/decide.js";
import { ApiError } from "../core/base.js";
import { Hono } from "hono";

import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import { createHintSchema } from "../models.js";
import { utcnow } from "../core/base.js";
import { nextHintId } from "../core/ids.js";
import { getProjectOr404 } from "../core/project-guards.js";

export function hintRoutes(db: Db): Hono {
	const app = new Hono();

	app.post("/projects/:id/hints", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, createHintSchema);
		// 同 goals：ID 分配与写入必须在一个事务里（见 goals.ts 的说明）。
		const create = db.transaction(() => {
			getProjectOr404(db, pid);
			const now = utcnow();
			const hid = nextHintId(db, pid);
			db.prepare(
				"INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(hid, pid, body.content, body.creator, now);
			if (body.persistent)
				db.prepare("INSERT INTO persistent_hints(project_id,hint_id) VALUES(?,?)").run(pid, hid);
			return {
				...(body.persistent ? { persistent: true } : {}),
				id: hid,
				content: body.content,
				creator: body.creator,
				created_at: now,
			};
		});
		return c.json(create.immediate(), 201);
	});

	app.patch("/projects/:id/hints/:hid/persistence", async (c) => {
		const { id: pid, hid } = c.req.param();
		const body = await parseBody(c, z.object({ persistent: z.boolean() }).strict());
		const update = db.transaction(() => {
			getProjectOr404(db, pid);
			if (!db.prepare("SELECT 1 FROM hints WHERE project_id=? AND id=?").get(pid, hid))
				throw new ApiError(404, "Hint not found");
			const result = body.persistent
				? db
						.prepare("INSERT OR IGNORE INTO persistent_hints(project_id,hint_id) VALUES(?,?)")
						.run(pid, hid)
				: db.prepare("DELETE FROM persistent_hints WHERE project_id=? AND hint_id=?").run(pid, hid);
			if (result.changes) signalDecideExternal(db, pid, "hint_policy_changed");
			return { id: hid, persistent: body.persistent };
		});
		return c.json(update.immediate());
	});
	return app;
}
