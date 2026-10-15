import { inspectProject } from "../support/project-state.js";
import { expect, test } from "vitest";
import { createProject, createTestServer, post, get } from "./helpers.js";
import { lastPendingToolCall } from "../../src/server/core/event-search.js";

test("duplicate goal evidence remains idempotent on an identical retry", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "sub" });
	const body = {
		actor: "human",
		from: [
			{ type: "fact", id: "origin" },
			{ type: "fact", id: "origin" },
		],
		description: "done",
	};
	expect((await post(app, `/projects/${pid}/goals/g001/achieve`, body)).status).toBe(200);
	expect((await post(app, `/projects/${pid}/goals/g001/achieve`, body)).status).toBe(200);
});

test("interruption diagnostics find an unfinished call in a multi-tool message", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES ('e1',?,'s1',1,0,'succeeded','2026-01-01')",
	).run(pid);
	const insert = db.prepare("INSERT INTO execution_events VALUES (?,?,?)");
	insert.run(
		"e1",
		1,
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "a", name: "first", arguments: {} },
					{ type: "toolCall", id: "b", name: "second", arguments: {} },
				],
			},
		}),
	);
	insert.run(
		"e1",
		2,
		JSON.stringify({
			type: "message",
			message: { role: "toolResult", toolCallId: "a", content: [] },
		}),
	);
	expect(lastPendingToolCall(db, "e1")?.name).toBe("second");
	insert.run(
		"e1",
		3,
		JSON.stringify({
			type: "message",
			message: { role: "toolResult", toolCallId: "b", content: [] },
		}),
	);
	expect(lastPendingToolCall(db, "e1")).toBeNull();
});

test("public trace fragments reconstruct oversized events and remain project scoped", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const other = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES ('large',?,'s1',1,0,'succeeded','2026-01-01')",
	).run(pid);
	const line = JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			content: [{ type: "text", text: "中文😀\u0000".repeat(15000) }],
		},
	});
	db.prepare("INSERT INTO execution_events VALUES (?,?,?)").run("large", 9, line);
	let offset = 0,
		text = "";
	for (let pages = 0; pages < 100; pages++) {
		const response = await get(
			app,
			`/projects/${pid}/executions/large/messages?event_seq=9&offset=${offset}`,
		);
		const raw = await response.text();
		expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(64 * 1024);
		const page = JSON.parse(raw);
		text += page.text;
		if (!page.has_more) break;
		expect(page.next_offset).toBeGreaterThan(offset);
		offset = page.next_offset;
	}
	expect(text).toBe(line);
	expect((await get(app, `/projects/${other}/executions/large/messages?event_seq=9`)).status).toBe(
		404,
	);
	for (const query of ["event_seq=0", "event_seq=9&offset=-1", "offset=1"])
		expect((await get(app, `/projects/${pid}/executions/large/messages?${query}`)).status).toBe(
			400,
		);
});

test("bulk graph models retain exactly the evidence returned by individual readers", async () => {
	const { factToModel, findingToModel, goalToModel } =
		await import("../../src/server/core/model-mappers.js");
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('e1', ?, 's001', 1, 1, 'running', '2026-01-01')",
	).run(pid);
	db.prepare("INSERT INTO execution_events (execution_id, seq, line) VALUES ('e1', 1, '{}')").run();
	const evidence = [{ kind: "event", execution_id: "e1", seq: 1 }];
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "fact",
		evidence,
	});
	await post(app, `/projects/${pid}/findings`, {
		actor: "human",
		title: "finding",
		description: "finding",
		fact_ids: ["f001"],
		evidence,
	});
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "sub" });
	await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		description: "done",
		from: [
			{ type: "finding", id: "r001" },
			{ type: "fact", id: "f001" },
		],
	});
	const detail = inspectProject(db, pid);
	for (const row of db.prepare("SELECT * FROM facts WHERE project_id=? ORDER BY rowid").all(pid))
		expect(detail.facts).toContainEqual(factToModel(db, row as Parameters<typeof factToModel>[1]));
	for (const row of db.prepare("SELECT * FROM findings WHERE project_id=? ORDER BY rowid").all(pid))
		expect(detail.findings).toContainEqual(
			findingToModel(db, row as Parameters<typeof findingToModel>[1]),
		);
	for (const row of db.prepare("SELECT * FROM goals WHERE project_id=? ORDER BY rowid").all(pid))
		expect(detail.goals).toContainEqual(goalToModel(db, row as Parameters<typeof goalToModel>[1]));
});
