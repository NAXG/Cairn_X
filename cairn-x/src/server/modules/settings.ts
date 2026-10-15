import { Hono } from "hono";

import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import { updateSettingsSchema } from "../models.js";
import { ApiError } from "../core/base.js";

interface SettingsRow {
	lease_timeout: number;
	decide_timeout: number;
}

export function settingsRoutes(db: Db): Hono {
	const app = new Hono();
	const readSettings = (): SettingsRow => {
		const row = db
			.prepare("SELECT lease_timeout, decide_timeout FROM settings WHERE rowid = 1")
			.get() as SettingsRow | undefined;
		if (!row) throw new ApiError(404, "Settings not found");
		return row;
	};

	app.get("/settings", (c) => c.json(readSettings()));

	app.patch("/settings", async (c) => {
		const body = await parseBody(c, updateSettingsSchema);
		const row = db
			.transaction(() => {
				readSettings();
				db.prepare(
					"UPDATE settings SET lease_timeout = COALESCE(?, lease_timeout), decide_timeout = COALESCE(?, decide_timeout) WHERE rowid = 1",
				).run(body.lease_timeout ?? null, body.decide_timeout ?? null);
				return readSettings();
			})
			.immediate();
		return c.json(row);
	});

	return app;
}
