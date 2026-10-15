import { inspectProjectResponse } from "../support/project-state.js";
import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createApp } from "../../src/server/app.js";
import {
	createProject,
	createTestServer,
	claimDecideForRead,
	post,
	patch,
	readPlanningGraph,
} from "./helpers.js";

async function ready() {
	const server = createTestServer();
	const pid = await createProject(server.app);
	await claimDecideForRead(server.app, pid, "reader");
	await readPlanningGraph(server.app, pid, "reader");
	return { ...server, pid };
}

test("Decide abandonment requires complete coverage; cascades acknowledge their effects", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "parent",
	});
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "child",
		waiting_on: ["s001"],
	});
	await claimDecideForRead(app, pid, "reader");
	const abandon = () =>
		post(app, `/projects/${pid}/steps/s001/abandon`, {
			worker: "reader",
			reason: "invalid premise",
		});
	expect((await abandon()).status).toBe(409);
	const insert = db.prepare(
		"INSERT INTO facts(id,project_id,description,created_at) VALUES(?,?,?,?)",
	);
	for (let i = 1; i <= 240; i++)
		insert.run(`f${i}`, pid, "evidence ".repeat(120), new Date().toISOString());
	let page = await (
		await post(app, `/projects/${pid}/decide/graph`, { worker: "reader", view: "planning" })
	).json();
	expect(page.coverage.required_complete).toBe(false);
	expect((await abandon()).status).toBe(409);
	expect(db.prepare("SELECT status FROM steps WHERE id='s001' AND project_id=?").get(pid)).toEqual({
		status: "open",
	});
	while (!page.coverage.required_complete)
		page = await (
			await post(app, `/projects/${pid}/decide/graph`, {
				worker: "reader",
				view: "planning",
				cursor: page.coverage.next_cursor,
			})
		).json();
	const result = await abandon();
	expect(result.status).toBe(200);
	expect((await result.json()).effects).toMatchObject({
		abandoned_step_ids: ["s001", "s002"],
		abandoned_step_count: 2,
		cancelled_execution_count: 0,
	});
});

for (const kind of ["steps", "goals", "routes"] as const) {
	test(`${kind} creation replays its acknowledgement after lease release and rejects conflicting reuse`, async () => {
		const { app, db, pid } = await ready();
		const body =
			kind === "steps"
				? {
						decide_worker: "reader",
						creator: "reader",
						from: ["origin"],
						description: "action",
						request_id: "create-1",
					}
				: { worker: "reader", description: "action", request_id: "create-1" };
		const url = `/projects/${pid}/${kind}`;
		const first = await post(app, url, body);
		expect(first.status).toBe(201);
		const original = await first.json();
		expect(await (await post(app, url, body)).json()).toEqual(original);
		expect((await post(app, url, { ...body, description: "different" })).status).toBe(409);
		await post(app, `/projects/${pid}/decide/release`, { worker: "reader" });
		expect(await (await post(app, url, body)).json()).toEqual(original);
		expect((await post(app, url, { ...body, request_id: "new" })).status).toBe(409);
		expect(
			(
				db
					.prepare(`SELECT COUNT(*) n FROM ${kind} WHERE project_id=? AND description='action'`)
					.get(pid) as { n: number }
			).n,
		).toBe(1);
		const other = await createProject(app);
		expect((await post(app, `/projects/${other}/${kind}`, body)).status).toBe(409);
	});
}

test("evidence is lease/project scoped and reconstructs long Unicode events with stable revisions", async () => {
	const { app, db, pid } = await ready();
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES('proof-exec',?,'unused',1,0,'succeeded',?)",
	).run(pid, now);
	const line = JSON.stringify({
		type: "message",
		message: { role: "toolResult", content: "验证🧭".repeat(10000) },
	});
	db.prepare("INSERT INTO execution_events(execution_id,seq,line) VALUES('proof-exec',1,?)").run(
		line,
	);
	db.prepare(
		"INSERT INTO facts(id,project_id,description,created_at) VALUES('proof',?,'claim',?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO evidence_refs(project_id,subject_type,subject_id,ref_key,execution_id,event_seq,created_at) VALUES(?,'fact','proof','event-proof','proof-exec',1,?)",
	).run(pid, now);
	const url = `/projects/${pid}/decide/evidence`;
	const input = { worker: "reader", type: "fact", id: "proof" };
	let page = await (await post(app, url, input)).json();
	expect(page.status).toBe("available");
	expect(page.event.has_more).toBe(true);
	let reconstructed = page.event.text;
	while (page.event.has_more) {
		const response = await post(app, url, {
			...input,
			offset: page.event.next_offset,
			revision: page.revision,
		});
		expect(response.status).toBe(200);
		page = await response.json();
		reconstructed += page.event.text;
	}
	expect(reconstructed).toBe(line);
	expect((await post(app, url, { ...input, offset: 8000 })).status).toBe(400);
	expect(
		(
			await post(app, url, {
				...input,
				revision: createHash("sha256").update("wrong").digest("hex"),
			})
		).status,
	).toBe(409);
	expect((await post(app, url, { ...input, worker: "stale" })).status).toBe(409);
	expect(
		(await (await post(app, url, { worker: "reader", type: "fact", id: "origin" })).json()).status,
	).toBe("no_references");
	const other = await createProject(app);
	await claimDecideForRead(app, other, "other-reader");
	// Even a corrupt offline reference cannot grant cross-project access.
	db.prepare(
		"INSERT INTO evidence_refs(project_id,subject_type,subject_id,ref_key,execution_id,event_seq,created_at) VALUES(?,'fact','origin','bad-ref','proof-exec',1,?)",
	).run(other, now);
	expect(
		(
			await post(app, `/projects/${other}/decide/evidence`, {
				worker: "other-reader",
				type: "fact",
				id: "origin",
			})
		).status,
	).toBe(404);
	const secured = createApp(db, { user: "test", password: "pass", apiToken: "machine" });
	expect((await post(secured, url, input)).status).toBe(401);
});

test("section keysets cross ID widths and searches bind cursors to filters", async () => {
	const { app, db, pid } = await ready();
	const insert = db.prepare(
		"INSERT INTO facts(id,project_id,description,created_at) VALUES(?,?,?,?)",
	);
	for (let i = 800; i <= 1200; i++)
		insert.run(
			`f${i}`,
			pid,
			i === 800 ? "literal 100%_ result" : `needle ${i}`,
			new Date().toISOString(),
		);
	const request = { worker: "reader", view: "section", section: "facts", query: "needle" };
	let page = await (await post(app, `/projects/${pid}/decide/graph`, request)).json();
	expect(page.records).toHaveLength(200);
	expect(page.records[0].id).toBe("f801");
	expect(page.records[198].id).toBe("f999");
	expect(page.records[199].id).toBe("f1000");
	const cursor = page.next_cursor;
	expect(
		(await post(app, `/projects/${pid}/decide/graph`, { ...request, query: "other", cursor }))
			.status,
	).toBe(409);
	page = await (await post(app, `/projects/${pid}/decide/graph`, { ...request, cursor })).json();
	expect(page.records[0].id).toBe("f1001");
	expect(page.records).toHaveLength(200);
	expect(page.next_cursor).toBe(null);
	const literal = await (
		await post(app, `/projects/${pid}/decide/graph`, { ...request, query: "100%_" })
	).json();
	expect(literal.records.map((r: { id: string }) => r.id)).toEqual(["f800"]);
	expect(
		(await post(app, `/projects/${pid}/decide/graph`, { ...request, status: "open" })).status,
	).toBe(400);
});

test("old unused routes move to searchable history while active and result-associated routes stay mandatory", async () => {
	const { app, db, pid } = await ready();
	const now = new Date().toISOString();
	const route = db.prepare(
		"INSERT INTO routes(id,project_id,description,goal_id,creator,created_at) VALUES(?,?,'old strategy','goal','old-worker','2000-01-01T00:00:00Z')",
	);
	for (let i = 1; i <= 500; i++) route.run(`t${i}`, pid);
	db.prepare(
		"INSERT INTO steps(id,project_id,description,status,creator,route_id,created_at) VALUES('active',?,'active','open','human','t1',?)",
	).run(pid, now);
	const pages = await readPlanningGraph(app, pid, "reader");
	const routes = pages.flatMap((p) => p.frontier.routes);
	expect(routes.map((r: { id: string }) => r.id)).toEqual(["t1"]);
	expect(pages).toHaveLength(1);
	expect(pages[0].history_truncated).toBe(true);
	const history = await (
		await post(app, `/projects/${pid}/decide/graph`, {
			worker: "reader",
			view: "section",
			section: "routes",
			query: "old strategy",
		})
	).json();
	expect(history.records).toHaveLength(200);
	expect(history.next_cursor).toBeTruthy();
});

test("explicit persistent hints survive checkpoints and can be unpinned", async () => {
	const { app, pid } = await ready();
	const response = await post(app, `/projects/${pid}/hints`, {
		content: "Only use the approved endpoint",
		creator: "human",
		persistent: true,
	});
	const hint = await response.json();
	await readPlanningGraph(app, pid, "reader");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "reader", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "reader" });
	await claimDecideForRead(app, pid, "next");
	const pages = await readPlanningGraph(app, pid, "next");
	expect(pages.flatMap((p) => p.frontier.hints ?? []).map((h: { id: string }) => h.id)).toEqual([
		hint.id,
	]);
	expect(
		(await patch(app, `/projects/${pid}/hints/${hint.id}/persistence`, { persistent: false }))
			.status,
	).toBe(200);
	expect(
		(await readPlanningGraph(app, pid, "next")).flatMap((p) => p.frontier.hints ?? []),
	).toHaveLength(0);
	expect((await inspectProjectResponse(app, pid)).status).toBe(200);
});

test("creation acknowledgements replay after project completion without granting new writes", async () => {
	const { app, db, pid } = await ready();
	const body = { worker: "reader", description: "strategy", request_id: "route-create" };
	const original = await (await post(app, `/projects/${pid}/routes`, body)).json();
	expect(
		(
			await post(app, `/projects/${pid}/goals/goal/achieve`, {
				worker: "reader",
				description: "evidenced",
				from: [{ type: "fact", id: "origin" }],
			})
		).status,
	).toBe(200);
	const replay = await post(app, `/projects/${pid}/routes`, body);
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(original);
	expect((await post(app, `/projects/${pid}/routes`, { ...body, request_id: "new" })).status).toBe(
		403,
	);
	expect(db.prepare("SELECT COUNT(*) n FROM routes WHERE project_id=?").get(pid)).toEqual({ n: 1 });
});

test("evidence context stays a bounded excerpt while the evidence event pages in full", async () => {
	const { app, db, pid } = await ready();
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES('ctx-exec',?,'unused',1,0,'succeeded',?)",
	).run(pid, now);
	const proofText = "proof-line\n".repeat(1200);
	const proofLine = JSON.stringify({
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: proofText }] },
	});
	db.prepare("INSERT INTO execution_events(execution_id,seq,line) VALUES('ctx-exec',5,?)").run(
		proofLine,
	);
	// 前序事件正文更大：它们只会作为「上下文」回传，不该再占正文级别 token。
	const noise = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "surrounding noise ".repeat(500) }],
		},
	});
	for (const seq of [3, 4])
		db.prepare("INSERT INTO execution_events(execution_id,seq,line) VALUES('ctx-exec',?,?)").run(
			seq,
			noise,
		);
	db.prepare(
		"INSERT INTO facts(id,project_id,description,created_at) VALUES('ctxfact',?,'claim',?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO evidence_refs(project_id,subject_type,subject_id,ref_key,execution_id,event_seq,created_at) VALUES(?,'fact','ctxfact','event-ctx','ctx-exec',5,?)",
	).run(pid, now);
	const page = await (
		await post(app, `/projects/${pid}/decide/evidence`, {
			worker: "reader",
			type: "fact",
			id: "ctxfact",
		})
	).json();
	expect(page.status).toBe("available");
	expect(page.context.length).toBeGreaterThan(0);
	for (const entry of page.context) {
		expect(entry.record).toBeUndefined();
		expect(entry.excerpt.length).toBeLessThanOrEqual(801);
		expect(entry.excerpt).not.toContain('"role"');
	}
	// 主体事件本身仍然逐字可重建。
	let reconstructed = page.event.text;
	let cursor = page;
	while (cursor.event.has_more) {
		cursor = await (
			await post(app, `/projects/${pid}/decide/evidence`, {
				worker: "reader",
				type: "fact",
				id: "ctxfact",
				offset: cursor.event.next_offset,
				revision: cursor.revision,
			})
		).json();
		reconstructed += cursor.event.text;
	}
	expect(reconstructed).toBe(proofLine);
});
