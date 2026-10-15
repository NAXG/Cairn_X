import { inspectProjectResponse } from "../support/project-state.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { onTestFinished, expect, test } from "vitest";

import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { createProject, createTestServer, del, get, post } from "./helpers.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

test("create project returns 201 detail with origin fact, root goal and hints", async () => {
	const { app } = createTestServer();

	const res = await post(app, "/projects", {
		title: "test",
		origin: "starting point",
		goal: "finish",
		hints: [{ content: "initial clue", creator: "human" }],
	});

	expect(res.status).toBe(201);
	const created = await res.json();
	expect(Object.keys(created)).toEqual(["project"]);
	const detail = await (await inspectProjectResponse(app, created.project.id)).json();
	expect(detail.project.id).toBe("proj_001");
	expect(detail.project.title).toBe("test");
	expect(detail.project.status).toBe("active");
	expect(detail.project.decide).toBeNull();
	expect(detail.project.finding_schema).toBeNull();
	expect(detail.project.created_at).toMatch(ISO_UTC);
	expect(detail.facts).toHaveLength(1);
	expect(detail.facts[0]).toMatchObject({ id: "origin", description: "starting point" });
	expect(detail.facts[0].created_at).toMatch(ISO_UTC);
	expect(detail.goals).toHaveLength(1);
	expect(detail.goals[0]).toMatchObject({
		id: "goal",
		parent_goal_id: null,
		description: "finish",
		status: "pending",
		evidence: [],
		achieved_description: null,
		achieved_at: null,
	});
	expect(detail.steps).toEqual([]);
	expect(detail.findings).toEqual([]);
	expect(detail.hints).toHaveLength(1);
	expect(detail.hints[0]).toMatchObject({ id: "h001", content: "initial clue", creator: "human" });
});

test("project ids increment globally and finding_schema is persisted", async () => {
	const { app } = createTestServer();
	const first = await createProject(app);
	const schema = { severity: "string", cvss: "number" };
	const second = await createProject(app, { finding_schema: schema, hints: undefined });

	expect(first).toBe("proj_001");
	expect(second).toBe("proj_002");

	const detail = await (await inspectProjectResponse(app, second)).json();
	expect(detail.project.finding_schema).toEqual(schema);
});

test("create project rejects invalid bodies with 400 and detail", async () => {
	const { app } = createTestServer();

	for (const body of [
		{ origin: "o", goal: "g" },
		{ title: "  ", origin: "o", goal: "g" },
		{ title: "t", origin: "o", goal: "g", hints: [{ content: "", creator: "h" }] },
	]) {
		const res = await post(app, "/projects", body);
		expect(res.status).toBe(400);
		expect((await res.json()).detail).toBeTypeOf("string");
	}

	const notJson = await app.request("/projects", { method: "POST", body: "not json" });
	expect(notJson.status).toBe(400);
});

test("list projects returns summaries with counts", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "claimed work",
		creator: "worker-a",
		worker: "worker-a",
	});
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "open work",
		creator: "decider",
		priority: 3,
	});
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "sub" });
	await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "vuln",
		description: "found",
		fact_ids: ["origin"],
	});

	const res = await get(app, "/projects/page");
	expect(res.status).toBe(200);
	const { items: summaries } = await res.json();
	expect(summaries).toHaveLength(1);
	expect(summaries[0]).toMatchObject({
		id: pid,
		status: "active",
		fact_count: 1,
		goal_count: 2,
		step_count: 2,
		working_step_count: 1,
		unclaimed_step_count: 1,
		finding_count: 1,
		hint_count: 1,
	});
});

test("get unknown project returns 404 with detail", async () => {
	const { app } = createTestServer();
	const res = await get(app, "/projects/proj_999/overview");
	expect(res.status).toBe(404);
	expect(await res.json()).toEqual({ detail: "Project not found" });
});

test("stopping a project releases step claims and the decide lease", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "worker-a",
		worker: "worker-a",
	});
	await post(app, `/projects/${pid}/decide/claim`, { worker: "worker-b", trigger: "facts:1->2" });

	const res = await post(app, `/projects/${pid}/status`, { status: "stopped" });
	expect(res.status).toBe(200);
	const meta = await res.json();
	expect(meta.status).toBe("stopped");
	expect(meta.decide).toBeNull();

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.steps[0].worker).toBeNull();
	expect(detail.steps[0].status).toBe("open");

	const back = await post(app, `/projects/${pid}/status`, { status: "active" });
	expect(back.status).toBe(200);
	expect((await back.json()).status).toBe("active");
});

test("status updates are idempotent and rejected for completed projects", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const same = await post(app, `/projects/${pid}/status`, { status: "active" });
	expect(same.status).toBe(200);

	await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "solved",
	});
	const res = await post(app, `/projects/${pid}/status`, { status: "stopped" });
	expect(res.status).toBe(409);
	expect((await res.json()).detail).toBe("Completed projects cannot change status");

	const invalid = await post(app, `/projects/${pid}/status`, { status: "completed" });
	expect(invalid.status).toBe(400);
});

test("complete achieves the root goal without manufacturing evidence", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "investigate",
		creator: "decider",
	});
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "executor" });
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "measured evidence",
		step_id: "s001",
	});
	await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "executor",
		description: "new fact",
	});

	const res = await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "f001" }],
		description: "solved",
	});
	expect(res.status).toBe(200);
	const payload = await res.json();
	expect(payload.fact).toBeUndefined();
	expect(payload.goal).toMatchObject({
		id: "goal",
		status: "achieved",
		evidence: [{ type: "fact", id: "f001" }],
		achieved_description: "solved",
	});
	expect(payload.goal.achieved_at).toMatch(ISO_UTC);
	expect(payload.project.status).toBe("completed");

	// 幂等确认：证据与理由完全一致的重传返回首次结果（200），不改写。
	const same = await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "f001" }],
		description: "solved",
	});
	expect(same.status).toBe(200);
	expect((await same.json()).goal.achieved_description).toBe("solved");

	// 冲突的重传（不同理由/证据）→ 409，绝不改写首次完成。
	const again = await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "f001" }],
		description: "again",
	});
	expect(again.status).toBe(409);
});

test("complete validates referenced facts", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	const res = await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "f999" }],
		description: "solved",
	});
	expect(res.status).toBe(404);
	expect((await res.json()).detail).toBe("Fact f999 not found");
});

test("delete removes a stopped project and cascades its data", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "decider",
	});
	await post(app, `/projects/${pid}/status`, { status: "stopped" });

	const res = await del(app, `/projects/${pid}`);
	expect(res.status).toBe(204);

	expect((await inspectProjectResponse(app, pid)).status).toBe(404);
	const { items: list } = await (await get(app, "/projects/page")).json();
	expect(list.find((p: { id: string }) => p.id === pid)).toBeUndefined();
});

test("delete rejects active projects and unknown ids", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const active = await del(app, `/projects/${pid}`);
	expect(active.status).toBe(409);
	expect((await active.json()).detail).toBe("Stop the project before deleting it");

	expect((await del(app, "/projects/proj_999")).status).toBe(404);
});

test("delete removes the project uploads directory", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-delete-env-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const app = createApp(db, undefined, { root: dir });
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const pid = await createProject(app);
	mkdirSync(path.join(dir, "uploads", pid), { recursive: true });
	writeFileSync(path.join(dir, "uploads", pid, "x.txt"), "x");

	await post(app, `/projects/${pid}/status`, { status: "stopped" });
	const res = await del(app, `/projects/${pid}`);
	expect(res.status).toBe(204);
	expect(existsSync(path.join(dir, "uploads", pid))).toBe(false);
});

test("complete auto-cancels remaining open and claimed steps", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "still waiting",
		creator: "decider",
	});
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "still running",
		creator: "worker-a",
		worker: "worker-a",
	});

	const res = await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "goal reached",
	});
	expect(res.status).toBe(200);

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.project.status).toBe("completed");
	expect(detail.steps).toHaveLength(2);
	for (const step of detail.steps) {
		expect(step.status).toBe("abandoned");
		expect(step.worker).toBeNull();
		expect(step.summary).toContain("项目完成");
	}
});

test("deleting a project cleans its session directory", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-delete-dirs-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const app = createApp(db, undefined, undefined, dir);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const pid = await createProject(app);
	mkdirSync(path.join(dir, pid, "sessions"), { recursive: true });
	writeFileSync(path.join(dir, pid, "sessions", "decide-2026-01-01T00-00-00-000Z.jsonl"), "{}\n");
	// 活动资源目录按快照 id 落盘，没有数据库引用：随项目一起清掉，别的项目不受影响。
	db.exec(
		"CREATE TABLE IF NOT EXISTS activity_configurations (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
	);
	db.prepare("INSERT INTO activity_configurations VALUES (?, ?)").run(
		"decide-mine",
		JSON.stringify({ project_id: pid, role: "decide", created_at: "2026-01-01T00:00:00Z" }),
	);
	db.prepare("INSERT INTO activity_configurations VALUES (?, ?)").run(
		"decide-other",
		JSON.stringify({ project_id: "proj_999", role: "decide", created_at: "2026-01-01T00:00:00Z" }),
	);
	for (const snapshot of ["decide-mine", "decide-other"]) {
		mkdirSync(path.join(dir, "activity-resources", snapshot), { recursive: true });
		writeFileSync(path.join(dir, "activity-resources", snapshot, "state.json"), "{}\n");
	}

	await post(app, `/projects/${pid}/status`, { status: "stopped" });
	expect((await del(app, `/projects/${pid}`)).status).toBe(204);
	expect(existsSync(path.join(dir, pid))).toBe(false);
	expect(existsSync(path.join(dir, "activity-resources", "decide-mine"))).toBe(false);
	expect(existsSync(path.join(dir, "activity-resources", "decide-other"))).toBe(true);
});
