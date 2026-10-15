import { expect, test } from "vitest";

import { projectGraph } from "../../src/server/core/graph.js";
import { nextFactId, nextGoalId } from "../../src/server/core/ids.js";
import { createProject, createTestServer, post } from "./helpers.js";

test("counter allocations are scoped and roll back with their transaction", async () => {
	const { app, db } = createTestServer();
	const first = await createProject(app);
	const second = await createProject(app);
	expect([first, second]).toEqual(["proj_001", "proj_002"]);
	expect(nextFactId(db, first)).toBe("f001");
	expect(nextFactId(db, second)).toBe("f001");
	expect(nextGoalId(db, first)).toBe("g001");
	expect(() =>
		db.transaction(() => {
			expect(nextFactId(db, first)).toBe("f002");
			throw new Error("rollback");
		})(),
	).toThrow("rollback");
	expect(nextFactId(db, first)).toBe("f002");
});

test("scoped ids keep creation order after crossing 999", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	db.prepare(
		"INSERT OR IGNORE INTO scoped_counters (project_id, kind, value) VALUES (?, 'fact', 999)",
	).run(pid);
	db.prepare("UPDATE scoped_counters SET value = 999 WHERE project_id = ? AND kind = 'fact'").run(
		pid,
	);
	expect(nextFactId(db, pid)).toBe("f1000");
	const insert = db.prepare(
		"INSERT INTO facts (id, project_id, description, confidence, created_at) VALUES (?, ?, ?, 'observed', ?)",
	);
	insert.run("f999", pid, "999th", "2026-01-01T00:00:00Z");
	insert.run("f1000", pid, "1000th", "2026-01-02T00:00:00Z");

	const ids = projectGraph(db, pid)
		.nodes.filter((n) => n.type === "fact")
		.map((n) => n.ref_id);
	expect(ids.indexOf("f999")).toBeLessThan(ids.indexOf("f1000"));

	// section 分页顺序同样按范围 id 序：游标落在 f999 后，下一页是 f1000。
	await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" });
	const page = await post(app, `/projects/${pid}/decide/graph`, {
		worker: "reader",
		view: "section",
		section: "facts",
		cursor: "f999",
	});
	expect(page.status).toBe(200);
	const body = await page.json();
	expect(body.records[0].id).toBe("f1000");
});
