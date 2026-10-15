import { inspectProjectResponse } from "../support/project-state.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "vitest";

import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { createProject, createTestServer, post } from "./helpers.js";

test("facts can be appended to active projects and appear in the detail", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const res = await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "port 22 open",
	});
	expect(res.status).toBe(201);
	const fact = await res.json();
	expect(fact).toMatchObject({ id: "f001", description: "port 22 open" });
	expect(fact.created_at).toBeTruthy();

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.facts.map((f: { id: string }) => f.id)).toEqual(["origin", "f001"]);
});

test("facts carry confidence and step_id; omitted confidence is rejected without burning an id", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "inspect",
		creator: "human",
	});
	const explicit = await post(app, `/projects/${pid}/facts`, {
		actor: "human",
		description: "not injectable",
		confidence: "inferred",
		step_id: "s001",
	});
	expect(explicit.status).toBe(201);
	expect(await explicit.json()).toMatchObject({
		id: "f001",
		confidence: "inferred",
		step_id: "s001",
	});

	const implicit = await post(app, `/projects/${pid}/facts`, {
		actor: "human",
		description: "port 22 open",
	});
	expect(implicit.status).toBe(400);
	expect((await implicit.json()).detail).toContain("confidence");
	const observed = await post(app, `/projects/${pid}/facts`, {
		actor: "human",
		description: "port 22 open",
		confidence: "observed",
	});
	expect(observed.status).toBe(201);
	expect(await observed.json()).toMatchObject({
		id: "f002",
		confidence: "observed",
		step_id: null,
	});

	const invalid = await post(app, `/projects/${pid}/facts`, {
		actor: "human",
		description: "x",
		confidence: "guessed",
	});
	expect(invalid.status).toBe(400);
});

test("facts are rejected on stopped and completed projects", async () => {
	const { app } = createTestServer();
	const stopped = await createProject(app);
	await post(app, `/projects/${stopped}/status`, { status: "stopped" });
	const resStopped = await post(app, `/projects/${stopped}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "late",
	});
	expect(resStopped.status).toBe(403);
	expect((await resStopped.json()).detail).toBe("Project is stopped");

	const completed = await createProject(app);
	await post(app, `/projects/${completed}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "done",
	});
	const resCompleted = await post(app, `/projects/${completed}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "late",
	});
	expect(resCompleted.status).toBe(403);
	expect((await resCompleted.json()).detail).toBe("Project is completed");
});

test("findings carry structured data and validated fact references", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "evidence",
	});

	const res = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "SSRF in /upload",
		description: "server-side request forgery",
		data: { severity: "high", cvss: 8.6 },
		fact_ids: ["origin", "f001"],
	});
	expect(res.status).toBe(201);
	const finding = await res.json();
	expect(finding).toMatchObject({
		id: "r001",
		title: "SSRF in /upload",
		data: { severity: "high", cvss: 8.6 },
		fact_ids: ["origin", "f001"],
	});

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.findings).toHaveLength(1);

	const missingFact = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "bad ref",
		description: "x",
		fact_ids: ["f404"],
	});
	expect(missingFact.status).toBe(404);
	expect((await missingFact.json()).detail).toBe("Fact f404 not found");

	const noRefs = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "note",
		description: "x",
	});
	expect(noRefs.status).toBe(201);
	expect((await noRefs.json()).fact_ids).toEqual([]);
});

test("finding data is validated against the project finding schema", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app, {
		finding_schema: {
			type: "object",
			required: ["severity"],
			properties: { severity: { type: "string" } },
		},
	});

	const good = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "SSRF",
		description: "x",
		data: { severity: "high" },
	});
	expect(good.status).toBe(201);

	const bad = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "SSRF",
		description: "x",
		data: { severity: 5 },
	});
	expect(bad.status).toBe(400);
	expect((await bad.json()).detail).toContain("does not match the project schema");

	// 声明 schema 就要求显式载荷，不能通过省略 data 绕过校验。
	const noData = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "note",
		description: "x",
	});
	expect(noData.status).toBe(400);
	expect((await noData.json()).detail).toContain("finding data is required");
});

test("duplicate findings do not burn ids", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-finding-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const db = openDatabase(path.join(dir, "cairn.db"));
	onTestFinished(() => {
		db.close();
	});
	const app = createApp(db, undefined, undefined, dir);
	const pid = await createProject(app);

	const body = {
		actor: "human",
		title: "stored xss",
		description: "x",
		client_event_id: "evt-dup-1",
	};
	const first = await post(app, `/projects/${pid}/findings`, body);
	expect(first.status).toBe(201);
	expect((await first.json()).id).toBe("r001");

	// 幂等重传：返回首个结果，不烧 ID。
	const dup = await post(app, `/projects/${pid}/findings`, body);
	expect(dup.status).toBe(200);
	expect((await dup.json()).id).toBe("r001");

	const next = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "another",
		description: "x",
	});
	expect(next.status).toBe(201);
	expect((await next.json()).id).toBe("r002");
});

test("finding schema validates the stored data", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-finding-schema-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const db = openDatabase(path.join(dir, "cairn.db"));
	onTestFinished(() => {
		db.close();
	});
	const app = createApp(db, undefined, undefined, dir);
	const schema = {
		finding_schema: {
			type: "object",
			required: ["severity"],
			properties: { severity: { type: "string" } },
		},
	};
	const pid = await createProject(app, schema);

	const ok = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "t",
		description: "x",
		data: { severity: "high" },
	});
	expect(ok.status).toBe(201);
	expect((await ok.json()).data).toEqual({ severity: "high" });

	const bad = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "t",
		description: "x",
		data: { severity: 7 },
	});
	expect(bad.status).toBe(400);
	expect((await bad.json()).detail).toContain("does not match the project schema");
});

test("findings require an active project", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/status`, { status: "stopped" });
	const res = await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "t",
		description: "d",
	});
	expect(res.status).toBe(403);
});

test("hints stay writable in every project status", async () => {
	const { app } = createTestServer();
	const stopped = await createProject(app);
	await post(app, `/projects/${stopped}/status`, { status: "stopped" });
	const resStopped = await post(app, `/projects/${stopped}/hints`, {
		content: "manual note",
		creator: "human",
	});
	expect(resStopped.status).toBe(201);
	expect((await resStopped.json()).id).toBe("h002");

	const completed = await createProject(app);
	await post(app, `/projects/${completed}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "done",
	});
	const resCompleted = await post(app, `/projects/${completed}/hints`, {
		content: "postmortem",
		creator: "human",
	});
	expect(resCompleted.status).toBe(201);

	const missing = await post(app, "/projects/proj_404/hints", { content: "x", creator: "human" });
	expect(missing.status).toBe(404);

	const invalid = await post(app, `/projects/${stopped}/hints`, { content: " ", creator: "human" });
	expect(invalid.status).toBe(400);
});
