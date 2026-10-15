import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, expect, onTestFinished } from "vitest";
import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import type {
	ActivityRecord,
	TranscriptPage,
	ExecutionSummary,
} from "../../src/contracts/transcripts.js";
import { createProject } from "./helpers.js";
function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-transcript-test-"));
	const db = openDatabase(path.join(dir, "test.db"));
	const app = createApp(db, undefined, undefined, dir);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir, db, app };
}
test("execution pages preserve blocks, identity, sequence gaps, and scope without exposing tokens", async () => {
	const { app, db } = fixture();
	const pid = await createProject(app);
	const other = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,token_hash,created_at) VALUES ('e1',?,'s1',2,1,'running','secret','2026-01-01')",
	).run(pid);
	const records = [
		{
			type: "message",
			id: "a",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reason" },
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "pwd" },
					},
				],
			},
		},
		{
			type: "message",
			id: "b",
			parentId: "a",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				content: [{ type: "text", text: "result" }],
			},
		},
	];
	records.forEach((r, i) =>
		db
			.prepare("INSERT INTO execution_events VALUES (?,?,?)")
			.run("e1", i * 2 + 1, JSON.stringify(r)),
	);
	const list = (await (
		await app.request(`/projects/${pid}/activities/page?kind=execute`)
	).json()) as { items: Array<{ execution: ExecutionSummary }> };
	expect(JSON.stringify(list)).not.toContain("secret");
	expect(list.items[0].execution.attempt).toBe(2);
	const first = (await (
		await app.request(`/projects/${pid}/executions/e1/messages?limit=1`)
	).json()) as TranscriptPage;
	expect(first.entries[0].record).toEqual(records[0]);
	expect(first.has_more).toBe(true);
	const next = (await (
		await app.request(`/projects/${pid}/executions/e1/messages?after_seq=${first.next_cursor}`)
	).json()) as TranscriptPage;
	expect(next.entries[0].seq).toBe(3);
	expect(next.entries[0].record).toEqual(records[1]);
	expect((await app.request(`/projects/${other}/executions/e1/messages`)).status).toBe(404);
	expect((await app.request(`/projects/${pid}/executions/e1/messages?limit=201`)).status).toBe(400);
});
test("execution lists expose the task verdict separately from delivery status", async () => {
	const { app, db } = fixture();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,error,created_at) VALUES ('e1',?,'s1',1,1,'succeeded','explore budget exhausted; harvest did not submit a structured result','2026-01-01')",
	).run(pid);
	db.prepare(
		"INSERT INTO execution_results(execution_id,schema_version,payload,created_at) VALUES ('e1',1,?,'2026-01-01')",
	).run(
		JSON.stringify({
			schema_version: 1,
			task_status: "inconclusive",
			summary: "No verdict was submitted",
			unresolved: ["Needs review"],
			produced: { fact_ids: ["f001"], finding_ids: [] },
		}),
	);
	const list = (await (
		await app.request(`/projects/${pid}/activities/page?kind=execute`)
	).json()) as { items: Array<{ execution: ExecutionSummary }> };
	expect(list.items[0].execution).toMatchObject({
		status: "succeeded",
		task_status: "inconclusive",
		auto_inconclusive: true,
	});
	const activities = (await (await app.request(`/projects/${pid}/activities/page`)).json()) as {
		items: ActivityRecord[];
	};
	expect(activities.items[0].execution).toMatchObject({
		status: "succeeded",
		task_status: "inconclusive",
		auto_inconclusive: true,
	});
});
test("large execution messages are loaded intact through authenticated content reference", async () => {
	const { app, db } = fixture();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,created_at) VALUES ('e1',?,'s1',1,1,'2026-01-01')",
	).run(pid);
	const record = {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "长".repeat(50000) }],
		},
	};
	db.prepare("INSERT INTO execution_events VALUES (?,?,?)").run("e1", 1, JSON.stringify(record));
	const page = (await (
		await app.request(`/projects/${pid}/executions/e1/messages`)
	).json()) as TranscriptPage;
	expect(page.entries[0].record).toBeUndefined();
	expect(await (await app.request(page.entries[0].content_url!)).json()).toEqual(record);
});
test("file pagination handles malformed lines, partial tail, utf8 byte cursors and full content", async () => {
	const { app, dir } = fixture();
	const pid = await createProject(app);
	const folder = path.join(dir, pid, "sessions");
	mkdirSync(folder, { recursive: true });
	const file = "decide-2026.jsonl";
	const p = path.join(folder, file);
	const record = {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "中文".repeat(40000) }],
		},
	};
	writeFileSync(p, "invalid\n" + JSON.stringify(record) + '\n{"type":"message"');
	const url = `/projects/${pid}/sessions/${file}/messages`;
	const first = (await (await app.request(url)).json()) as TranscriptPage;
	expect(first.entries).toHaveLength(1);
	expect(first.has_more).toBe(false);
	const full = (await (await app.request(first.entries[0].content_url!)).json()) as TranscriptPage;
	expect(full.entries[0].record).toEqual(record);
	appendFileSync(p, ',"id":"tail"}\n');
	const next = (await (
		await app.request(url + "?cursor=" + first.next_cursor)
	).json()) as TranscriptPage;
	expect(next.entries[0].record?.id).toBe("tail");
	expect(next.entries).toHaveLength(1);
	expect((await app.request(url + "?cursor=bad:1")).status).toBe(409);
});
test("public transcript routes require authentication", async () => {
	const { db, dir } = fixture();
	const app = createApp(db, { user: "test", password: "test" }, undefined, dir);
	expect((await app.request("/projects/p1/activities/page")).status).toBe(401);
});

test("execution pages stay bounded and keep next cursor before unread messages", async () => {
	const { app, db } = fixture();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,created_at) VALUES ('e1',?,'s1',1,1,'2026-01-01')",
	).run(pid);
	for (let i = 1; i <= 20; i++)
		db.prepare("INSERT INTO execution_events VALUES (?,?,?)").run(
			"e1",
			i,
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(50000) }],
				},
			}),
		);
	const response = await app.request(`/projects/${pid}/executions/e1/messages`);
	const text = await response.text();
	expect(Buffer.byteLength(text)).toBeLessThan(513 * 1024);
	const page = JSON.parse(text) as TranscriptPage;
	expect(page.has_more).toBe(true);
	expect(Number(page.next_cursor)).toBe(page.entries.at(-1)!.seq);
	const next = (await (
		await app.request(`/projects/${pid}/executions/e1/messages?after_seq=${page.next_cursor}`)
	).json()) as TranscriptPage;
	expect(next.entries[0].seq).toBe(Number(page.next_cursor) + 1);
});

test("console transcripts keep mid-size events inline (the narrow budget is worker-only)", async () => {
	const { app, db } = fixture();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,created_at) VALUES ('e1',?,'s1',1,1,'2026-01-01')",
	).run(pid);
	// 同一个 8 KiB–64 KiB 区间：控制台仍然直接给 record，Worker 才降级为摘录。
	const record = {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			content: [{ type: "text", text: "y".repeat(12000) }],
		},
	};
	const line = JSON.stringify(record);
	expect(Buffer.byteLength(line)).toBeGreaterThan(8 * 1024);
	expect(Buffer.byteLength(line)).toBeLessThan(64 * 1024);
	db.prepare("INSERT INTO execution_events VALUES (?,?,?)").run("e1", 1, line);
	const page = (await (
		await app.request(`/projects/${pid}/executions/e1/messages`)
	).json()) as TranscriptPage;
	expect(page.entries[0].record).toEqual(record);
	expect(page.entries[0].content_url).toBeUndefined();
});
