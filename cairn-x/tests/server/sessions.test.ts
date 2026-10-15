/** 会话列表与统一活动索引；原始消息全部使用 /messages 游标接口。 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, expect, test } from "vitest";
import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { createProject, get, post } from "./helpers.js";

function createSessionServer() {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-sessions-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const dataRoot = path.join(dir, "data");
	const app = createApp(db, undefined, undefined, dataRoot);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { app, dataRoot, db };
}
const HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "s",
	timestamp: "2026-09-01T00:00:00.000Z",
});
function userLine(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-01T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1788364801000 },
	});
}
function writeSession(
	dataRoot: string,
	pid: string,
	file: string,
	lines: string[],
	mtime?: Date,
): string {
	const dir = path.join(dataRoot, pid, "sessions");
	mkdirSync(dir, { recursive: true });
	const full = path.join(dir, file);
	writeFileSync(full, lines.join("\n") + "\n");
	if (mtime) utimesSync(full, mtime, mtime);
	return full;
}

test("lists sessions with metadata, newest first", async () => {
	const { app, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	writeSession(
		dataRoot,
		pid,
		"execute-old.jsonl",
		[HEADER, userLine("m1", "go"), userLine("m2", "more")],
		new Date("2026-09-01T00:00:00Z"),
	);
	writeSession(
		dataRoot,
		pid,
		"decide-new.jsonl",
		[HEADER, userLine("m3", "decide")],
		new Date("2026-09-02T00:00:00Z"),
	);
	writeSession(dataRoot, pid, "notes.txt", ["hello"]);
	const res = await get(app, `/projects/${pid}/activities/page`);
	expect(res.status).toBe(200);
	const { items } = await res.json();
	const sessions = items.map((r: { session: unknown }) => r.session);
	expect(sessions).toHaveLength(2);
	expect(sessions[0]).toMatchObject({ file: "decide-new.jsonl", activity: "decide", entries: 1 });
	expect(sessions[1]).toMatchObject({ file: "execute-old.jsonl", activity: "execute", entries: 2 });
	expect(sessions[1].bytes).toBeGreaterThan(0);
});

test("marks a decide session triggered by an interrupted round as a retry", async () => {
	const { app, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	writeSession(dataRoot, pid, "decide-retry.jsonl", [
		HEADER,
		userLine("m1", "项目：测试\n调度触发：external_signal:decide_interrupted（规划版本 v2）。"),
	]);
	const res = await get(app, `/projects/${pid}/activities/page`);
	expect(res.status).toBe(200);
	expect((await res.json()).items[0].session).toMatchObject({ retry: true, entries: 1 });
});

test("marks a decide session whose lease was released before completion as interrupted", async () => {
	const { app, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	const worker = "decide:test:round";
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker })).status).toBe(200);
	expect((await post(app, `/projects/${pid}/decide/release`, { worker })).status).toBe(200);
	writeSession(dataRoot, pid, "decide-decide-test-round.jsonl", [
		HEADER,
		userLine("m1", "项目：测试\n调度触发：initial_run（规划版本 v0）。"),
	]);
	const res = await get(app, `/projects/${pid}/activities/page`);
	expect(res.status).toBe(200);
	expect((await res.json()).items[0].session).toMatchObject({ interrupted: true, entries: 1 });
});

test("reads sessions through the canonical raw message endpoint", async () => {
	const { app, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	const file = "decide-test.jsonl";
	writeSession(dataRoot, pid, file, [HEADER, userLine("m1", "decide record")]);
	const detail = await get(app, `/projects/${pid}/sessions/${encodeURIComponent(file)}/messages`);
	expect(detail.status).toBe(200);
	expect((await detail.json()).entries[1].record.message.content).toBe("decide record");
});

test("raw messages preserve assistant text, thinking and tool arguments, skipping malformed lines", async () => {
	const { app, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	const assistant = {
		type: "message",
		id: "a1",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "x".repeat(5000) },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			],
			usage: { input: 12, output: 34 },
		},
	};
	const tool = {
		type: "message",
		id: "a2",
		message: {
			role: "toolResult",
			toolName: "bash",
			content: [{ type: "text", text: "flag.txt" }],
			isError: true,
		},
	};
	writeSession(dataRoot, pid, "execute-test.jsonl", [
		HEADER,
		userLine("m1", "start"),
		"{invalid",
		JSON.stringify(assistant),
		JSON.stringify(tool),
	]);
	const body = await (
		await get(app, `/projects/${pid}/sessions/execute-test.jsonl/messages`)
	).json();
	expect(body.entries.map((e: { record: unknown }) => e.record)).toEqual([
		JSON.parse(HEADER),
		JSON.parse(userLine("m1", "start")),
		assistant,
		tool,
	]);
	// The duplicate, truncating parser has been retired instead of maintained in parallel.
	expect((await get(app, `/projects/${pid}/sessions/execute-test.jsonl`)).status).toBe(404);
});

test("rejects unknown projects and returns empty indexes before any work exists", async () => {
	const { app } = createSessionServer();
	for (const endpoint of ["activities/page"])
		expect((await get(app, `/projects/missing/${endpoint}`)).status).toBe(404);
	const pid = await createProject(app);
	expect(await (await get(app, `/projects/${pid}/activities/page`)).json()).toEqual({
		items: [],
		next_cursor: null,
	});
	expect(await (await get(app, `/projects/${pid}/activities/page`)).json()).toEqual({
		items: [],
		next_cursor: null,
	});
});

test("rejects path traversal and unknown session files with 404", async () => {
	const { app } = createSessionServer();
	const pid = await createProject(app);
	for (const file of [
		"..%2F..%2Fcairn.db",
		"evil.jsonl",
		"bash-test.jsonl",
		"execute-.jsonl",
		"decide-missing.jsonl",
	]) {
		expect((await get(app, `/projects/${pid}/sessions/${file}/messages`)).status).toBe(404);
	}
});

test("canonical message pages are bounded and support incremental reads after append", async () => {
	const { app, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	const file = "execute-test.jsonl";
	const entries = Array.from({ length: 205 }, (_, i) => userLine(`m${i}`, `entry ${i}`));
	writeSession(dataRoot, pid, file, [HEADER, ...entries]);
	const url = `/projects/${pid}/sessions/${file}/messages`;
	const first = await (await get(app, url + "?limit=200")).json();
	expect(first.entries).toHaveLength(200);
	expect(first.has_more).toBe(true);
	const second = await (await get(app, `${url}?cursor=${first.next_cursor}`)).json();
	expect(second.entries).toHaveLength(6);
	expect(second.has_more).toBe(false);
	writeSession(dataRoot, pid, file, [HEADER, ...entries, userLine("new", "appended")]);
	const third = await (await get(app, `${url}?cursor=${second.next_cursor}`)).json();
	expect(third.entries.map((e: { record: { id: string } }) => e.record.id)).toEqual(["new"]);
	expect(
		(await (await get(app, `/projects/${pid}/activities/page`)).json()).items[0].session.entries,
	).toBe(206);
	expect((await get(app, url + "?limit=201")).status).toBe(400);
});

test("activities associate sessions server-side, retain orphan files, and isolate projects", async () => {
	const { app, db, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	const other = await createProject(app);
	const insert = db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES (?, ?, ?, ?, 1, 'queued', '2026-09-01T00:00:00Z')",
	);
	insert.run("exec1", pid, "s001", 1);
	insert.run("exec2", pid, "s002", 1);
	insert.run("foreign", other, "s001", 1);
	writeSession(
		dataRoot,
		pid,
		"execute-s001-a1-new.jsonl",
		[HEADER, userLine("new", "latest")],
		new Date("2026-09-02T00:00:00Z"),
	);
	writeSession(
		dataRoot,
		pid,
		"execute-s001-a1-old.jsonl",
		[HEADER],
		new Date("2026-09-01T00:00:00Z"),
	);
	writeSession(dataRoot, pid, "execute-s999-a1-orphan.jsonl", [HEADER]);
	writeSession(dataRoot, pid, "decide-planning.jsonl", [HEADER]);
	writeSession(dataRoot, other, "decide-foreign.jsonl", [HEADER]);
	const { items: records } = await (await get(app, `/projects/${pid}/activities/page`)).json();
	expect(records).toHaveLength(4);
	expect(records.find((r: { key: string }) => r.key === "e:exec1")).toMatchObject({
		kind: "execute",
		execution: { id: "exec1", step_id: "s001", attempt: 1 },
		session: { file: "execute-s001-a1-new.jsonl", entries: 1 },
	});
	expect(records.find((r: { key: string }) => r.key === "e:exec2")).not.toHaveProperty("session");
	expect(
		records.find((r: { key: string }) => r.key === "s:execute-s999-a1-orphan.jsonl"),
	).toMatchObject({ kind: "execute", session: { file: "execute-s999-a1-orphan.jsonl" } });
	expect(JSON.stringify(records)).not.toContain("foreign");
});

test("session I/O errors surface for indexed activities", async () => {
	const { app, dataRoot } = createSessionServer();
	const pid = await createProject(app);
	mkdirSync(path.join(dataRoot, pid), { recursive: true });
	writeFileSync(path.join(dataRoot, pid, "sessions"), "not a directory");
	expect((await get(app, `/projects/${pid}/activities/page`)).status).toBe(500);
});
