import { test, expect, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { createProject } from "./helpers.js";
test("activity summary selects latest per role within project and excludes credentials", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-summary-"));
	const db = openDatabase(path.join(dir, "test.db"));
	const app = createApp(db, undefined, undefined, dir);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const pid = await createProject(app),
		other = await createProject(app);
	for (const [id, project, role, date, model] of [
		["a", pid, "decide", "2026-01-01", "old"],
		["b", pid, "decide", "2026-01-02", "latest"],
		["c", pid, "execute", "2026-01-01", "execute-model"],
		["d", other, "decide", "2026-02-01", "other-project"],
	])
		db.prepare("INSERT INTO activity_configurations VALUES (?,?)").run(
			id,
			JSON.stringify({
				project_id: project,
				role,
				created_at: date,
				profile: { model_id: model },
				provider: { name: "Test", headers: { Authorization: "private" }, credential_id: "secret" },
			}),
		);
	const res = await app.request(`/projects/${pid}/activity-summary`);
	expect(res.status).toBe(200);
	const data = await res.json();
	expect(data).toHaveLength(2);
	expect(JSON.stringify(data)).toContain("latest");
	expect(JSON.stringify(data)).not.toMatch(/private|secret|other-project|old/);
	expect((await app.request("/projects/missing/activity-summary")).status).toBe(404);
});
