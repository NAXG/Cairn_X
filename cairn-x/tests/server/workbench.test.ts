import { inspectProjectResponse } from "../support/project-state.js";
import type { ReadPage } from "../../src/contracts/workbench.js";
import type { ActivityRecord } from "../../src/contracts/transcripts.js";
import { expect, test, vi, onTestFinished } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { createProject, createTestServer, get, post } from "./helpers.js";
import { conditionalRead } from "../../src/server/core/read-versions.js";
import { Hono } from "hono";
import { rmSync } from "node:fs";
import { signalDecideExternal } from "../../src/server/core/decide.js";

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "cairn-workbench-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	return { ...createTestServer({ dataRoot: root }), root };
}
async function same(app: Hono, url: string, etag: string) {
	return app.request(url, { headers: { "If-None-Match": etag } });
}

test("overview is bounded and single records retain full text", async () => {
	const { app, db, root } = fixture();
	const pid = await createProject(app);
	const insert = db.prepare(
		"INSERT INTO facts(id,project_id,description,created_at) VALUES(?,?,?,?)",
	);
	for (let i = 0; i < 1000; i++)
		insert.run(`f${i}`, pid, "large material ".repeat(200), "2026-09-01T00:00:00Z");
	const overview = await get(app, `/projects/${pid}/overview`);
	const data = await overview.json();
	expect(data.counts.facts).toBe(1001);
	expect(data.facts).toBeUndefined();
	expect(data.steps).toBeUndefined();
	expect(JSON.stringify(data).length).toBeLessThan(3000);
	const record = await (await get(app, `/projects/${pid}/records/node/f900`)).json();
	expect(record.record.description).toBe("large material ".repeat(200));
	expect((await (await inspectProjectResponse(app, pid)).json()).facts).toHaveLength(1001);
	const secured = createApp(
		db,
		{ user: "admin", password: "test", apiToken: "machine" },
		undefined,
		root,
	);
	expect((await get(secured, `/projects/${pid}/overview`)).status).toBe(401);
});

test("304 skips projection building and revisions are committed atomically with direct writes", async () => {
	const { db, app } = fixture();
	const pid = await createProject(app);
	const build = vi.fn(() => ({ value: 1 }));
	const instrumented = new Hono();
	instrumented.get("/value", (c) => conditionalRead(c, db, pid, "graph", build));
	const first = await get(instrumented, "/value");
	const tag = first.headers.get("etag")!;
	expect((await same(instrumented, "/value", tag)).status).toBe(304);
	expect(build).toHaveBeenCalledTimes(1);
	expect(() =>
		db.transaction(() => {
			db.prepare(
				"UPDATE facts SET description='rolled back' WHERE project_id=? AND id='origin'",
			).run(pid);
			throw Error("rollback");
		})(),
	).toThrow();
	expect((await same(instrumented, "/value", tag)).status).toBe(304);
	db.prepare("UPDATE facts SET description='committed' WHERE project_id=? AND id='origin'").run(
		pid,
	);
	expect((await same(instrumented, "/value", tag)).status).toBe(200);
	expect(build).toHaveBeenCalledTimes(2);
	const overview = await get(app, `/projects/${pid}/overview`);
	const otag = overview.headers.get("etag")!;
	db.prepare("UPDATE projects SET status='stopped' WHERE id=?").run(pid);
	expect((await same(app, `/projects/${pid}/overview`, otag)).status).toBe(200);
});

test("canvas removes execution/hint bodies, and heartbeat/trace writes leave its ETag unchanged", async () => {
	const { db, app } = fixture();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "step",
	});
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at,token_hash) VALUES('e1',?,'s001',1,0,'running','2026-09-01T00:00:00Z','SECRET')",
	).run(pid);
	const url = `/projects/${pid}/graph/canvas`;
	const first = await get(app, url);
	const graph = await first.json();
	const tag = first.headers.get("etag")!;
	expect(graph.nodes.some((n: { type: string }) => ["execution", "hint"].includes(n.type))).toBe(
		false,
	);
	expect(graph.nodes.find((n: { id: string }) => n.id === "step:s001").attempt).toBe(1);
	expect(JSON.stringify(graph)).not.toContain("SECRET");
	db.prepare(
		"UPDATE executions SET last_heartbeat_at='2026-09-30T01:00:00Z',lease_expires_at='2030-01-01T00:00:00Z' WHERE id='e1'",
	).run();
	db.prepare(
		"UPDATE steps SET last_heartbeat_at='2026-09-30T01:00:00Z' WHERE project_id=? AND id='s001'",
	).run(pid);
	db.prepare("INSERT INTO execution_events(execution_id,seq,line) VALUES('e1',1,'{}')").run();
	expect((await same(app, url, tag)).status).toBe(304);
	db.prepare("UPDATE executions SET status='failed',error='failure' WHERE id='e1'").run();
	expect((await same(app, url, tag)).status).toBe(200);
	const second = await get(app, url);
	db.prepare(
		"INSERT INTO goal_evidence(project_id,goal_id,evidence_type,evidence_id,created_at) VALUES(?,'goal','fact','origin','2026-09-01T00:00:00Z')",
	).run(pid);
	expect((await same(app, url, second.headers.get("etag")!)).status).toBe(200);
});

test("read revisions preserve outer UPSERT and replacement write semantics", async () => {
	const { db, app } = fixture();
	const pid = await createProject(app);
	const url = `/projects/${pid}/overview`;
	const first = await get(app, url);
	signalDecideExternal(db, pid, "first");
	signalDecideExternal(db, pid, "second");
	expect((await same(app, url, first.headers.get("etag")!)).status).toBe(200);
	const current = await get(app, url);
	const before = db
		.prepare("SELECT overview FROM project_read_versions WHERE project_id=?")
		.get(pid) as { overview: number };
	db.prepare(
		"INSERT OR REPLACE INTO decide_checkpoints(project_id,fact_count,hint_count,open_step_count,goal_count,finding_count,external_signal,updated_at) VALUES(?,0,0,0,0,0,?,'2026-09-30T00:00:00Z')",
	).run(pid, "replacement");
	const after = db
		.prepare("SELECT overview FROM project_read_versions WHERE project_id=?")
		.get(pid) as { overview: number };
	expect(after.overview).toBeGreaterThan(before.overview);
	expect((await same(app, url, current.headers.get("etag")!)).status).toBe(200);
	const graph = await get(app, `/projects/${pid}/graph/canvas`);
	db.prepare(
		"INSERT INTO hints(id,project_id,content,creator,created_at) VALUES('h1',?,'new hint','human','2026-09-30T00:00:00Z')",
	).run(pid);
	expect(
		(await same(app, `/projects/${pid}/graph/canvas`, graph.headers.get("etag")!)).status,
	).toBe(200);
});

test("timeline/findings keysets are complete at equal timestamps and previews point to full records", async () => {
	const { db, app } = fixture();
	const pid = await createProject(app);
	const insert = db.prepare(
		"INSERT INTO findings(id,project_id,title,description,created_at) VALUES(?,?,?,?,'2026-09-01T00:00:00Z')",
	);
	for (let i = 0; i < 125; i++) insert.run(`r${i}`, pid, `Finding ${i}`, "body ".repeat(200));
	const ids: string[] = [];
	let cursor: string | null = null;
	do {
		const page = await (
			await get(
				app,
				`/projects/${pid}/findings/page?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			)
		).json();
		expect(page.items.length).toBeLessThanOrEqual(50);
		expect(page.items[0].truncated).toBe(true);
		ids.push(...page.items.map((r: { id: string }) => r.id));
		cursor = page.next_cursor;
	} while (cursor);
	expect(new Set(ids).size).toBe(125);
	expect(ids).toHaveLength(125);
	const keys: string[] = [];
	cursor = null;
	do {
		const page = await (
			await get(
				app,
				`/projects/${pid}/timeline?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			)
		).json();
		expect(page.items.length).toBeLessThanOrEqual(30);
		keys.push(...page.items.map((r: { key: string }) => r.key));
		cursor = page.next_cursor;
	} while (cursor);
	expect(new Set(keys).size).toBe(keys.length);
	expect(keys.filter((k) => k.startsWith("finding:"))).toHaveLength(125);
	expect(
		(await (await get(app, `/projects/${pid}/records/finding/r124`)).json()).record.description,
	).toBe("body ".repeat(200));
	const other = await createProject(app);
	expect((await get(app, `/projects/${other}/records/finding/r124`)).status).toBe(404);
});

test("activity pages index legacy files, refresh changes, and never page through full execution summaries", async () => {
	const { db, app, root } = fixture();
	const pid = await createProject(app);
	const dir = path.join(root, pid, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "decide-test.jsonl");
	writeFileSync(
		file,
		JSON.stringify({ type: "session" }) +
			"\n" +
			JSON.stringify({ type: "message", message: { role: "user", content: "planning" } }) +
			"\n",
	);
	const insert = db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES(?,?,'s1',?,0,'succeeded','2026-09-01T00:00:00Z')",
	);
	for (let i = 1; i <= 125; i++) insert.run(`exec-${i}`, pid, i);
	const url = `/projects/${pid}/activities/page?limit=50`;
	const first = await get(app, url);
	const page = await first.json();
	expect(page.items).toHaveLength(50);
	expect(page.items.some((r: { session?: unknown }) => r.session)).toBe(true);
	expect((await same(app, url, first.headers.get("etag")!)).status).toBe(304);
	appendFileSync(
		file,
		JSON.stringify({ type: "message", message: { role: "assistant", content: "updated" } }) + "\n",
	);
	const changed = await same(app, url, first.headers.get("etag")!);
	expect(changed.status).toBe(200);
	const changedPage = (await changed.json()) as ReadPage<ActivityRecord>;
	expect(
		changedPage.items.find((r) => r.session?.file === "decide-test.jsonl")?.session?.entries,
	).toBe(2);
	const keys = page.items.map((r: { key: string }) => r.key);
	let cursor = page.next_cursor;
	while (cursor) {
		const older = await (await get(app, `${url}&cursor=${encodeURIComponent(cursor)}`)).json();
		keys.push(...older.items.map((r: { key: string }) => r.key));
		cursor = older.next_cursor;
	}
	expect(new Set(keys).size).toBe(126);
	expect(keys).toHaveLength(126);
	const detail = await (await get(app, `/projects/${pid}/executions/exec-60/detail`)).json();
	expect(detail.execution.attempt).toBe(60);
	expect(detail.previous.attempt).toBe(59);
	expect(detail.next.attempt).toBe(61);
});

test("project sidebar pages invalidate on membership and metadata changes", async () => {
	const { app, db } = fixture();
	const pid = await createProject(app);
	const url = "/projects/page?limit=1";
	const first = await get(app, url);
	expect((await first.json()).items).toHaveLength(1);
	expect((await same(app, url, first.headers.get("etag")!)).status).toBe(304);
	db.prepare("UPDATE projects SET title='changed title' WHERE id=?").run(pid);
	expect((await same(app, url, first.headers.get("etag")!)).status).toBe(200);
	const current = await get(app, url);
	await createProject(app);
	expect((await same(app, url, current.headers.get("etag")!)).status).toBe(200);
});

test("actual activity summary invalidates on configuration changes but not transcript-only reports", async () => {
	const { app, db } = fixture();
	const pid = await createProject(app);
	const url = `/projects/${pid}/activity-summary`;
	const first = await get(app, url);
	expect(await first.json()).toEqual([]);
	const snapshot = {
		role: "decide",
		project_id: pid,
		profile: { model_id: "model-one" },
		provider: { name: "provider" },
		created_at: "2026-09-01T00:00:00Z",
	};
	db.prepare("INSERT INTO activity_configurations(id,body) VALUES('snapshot',?)").run(
		JSON.stringify(snapshot),
	);
	const changed = await same(app, url, first.headers.get("etag")!);
	expect(changed.status).toBe(200);
	expect(((await changed.json()) as Array<{ model: string }>)[0].model).toBe("model-one");
	const current = await get(app, url);
	db.prepare("UPDATE activity_configurations SET body=? WHERE id='snapshot'").run(
		JSON.stringify({ ...snapshot, final_prompt: "reported", tools: ["get_graph"] }),
	);
	expect((await same(app, url, current.headers.get("etag")!)).status).toBe(304);
});

test("invalid or deleted resources cannot produce a reusable error ETag", async () => {
	const { app } = fixture();
	const pid = await createProject(app);
	const missing = await get(app, `/projects/${pid}/records/fact/missing`);
	expect(missing.status).toBe(404);
	expect(missing.headers.get("etag")).toBeNull();
	expect((await get(app, `/projects/${pid}/records/toString/origin`)).status).toBe(400);
	const invalid = await get(app, `/projects/${pid}/findings/page?limit=1000`);
	expect(invalid.status).toBe(400);
	expect(invalid.headers.get("etag")).toBeNull();
});
