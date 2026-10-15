import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, expect, onTestFinished } from "vitest";
import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { createProject } from "./helpers.js";

function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-export-test-"));
	const db = openDatabase(path.join(dir, "test.db"));
	const app = createApp(db, undefined, undefined, dir);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir, db, app };
}

// 与真实落盘格式一致（见 datas/<pid>/sessions/*.jsonl）。
const HEADER = {
	type: "session",
	version: 3,
	id: "01a0test-0000-4000-8000-000000000001",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/data",
};
const MSGS = [
	{
		type: "message",
		id: "a",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "你好 cairn-export" }],
		},
	},
	{
		type: "message",
		id: "b",
		parentId: "a",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "收到，执行 pwd" }],
		},
	},
];

function exportedData(html: string): { entries: unknown[] } {
	const m = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html);
	expect(m).toBeTruthy();
	return JSON.parse(Buffer.from(m![1], "base64").toString("utf8")) as {
		entries: unknown[];
	};
}

function writeSession(dir: string, pid: string, name: string) {
	const sessions = path.join(dir, pid, "sessions");
	mkdirSync(sessions, { recursive: true });
	writeFileSync(
		path.join(sessions, name),
		[HEADER, ...MSGS].map((e) => JSON.stringify(e)).join("\n") + "\n",
	);
}

test("session export renders standalone inline HTML with safe headers", async () => {
	const { dir, app } = fixture();
	const pid = await createProject(app);
	writeSession(dir, pid, "decide-2026-01-01T00-00-00-000Z.jsonl");
	const res = await app.request(
		`/projects/${pid}/sessions/decide-2026-01-01T00-00-00-000Z.jsonl/export?inline=1`,
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/html");
	const disposition = res.headers.get("content-disposition") ?? "";
	expect(disposition.startsWith("inline")).toBe(true);
	expect(disposition).toContain("cairn-session-decide-");
	expect(res.headers.get("x-frame-options")).toBe("DENY");
	const html = await res.text();
	expect(html).toContain("<title>Session Export</title>");
	// pi-web 的迭代化补丁已应用（深链防护）。
	expect(html).toContain("const stack = [root];");
	// 会话数据以 base64 JSON 内嵌在 #session-data 中。
	const data = exportedData(html);
	expect(JSON.stringify(data.entries)).toContain("你好 cairn-export");
});

test("session export supports attachment download and rejects bad names", async () => {
	const { dir, app } = fixture();
	const pid = await createProject(app);
	writeSession(dir, pid, "decide-2026-01-01T00-00-00-000Z.jsonl");
	const attach = await app.request(
		`/projects/${pid}/sessions/decide-2026-01-01T00-00-00-000Z.jsonl/export`,
	);
	expect((attach.headers.get("content-disposition") ?? "").startsWith("attachment")).toBe(true);
	for (const file of ["foo.jsonl", "..%2Fdecide-x.jsonl", "decide-a.jsonl.txt"]) {
		const res = await app.request(`/projects/${pid}/sessions/${file}/export?inline=1`);
		expect(res.status).toBe(404);
	}
	const missing = await app.request(
		`/projects/${pid}/sessions/decide-2099-01-01T00-00-00-000Z.jsonl/export?inline=1`,
	);
	expect(missing.status).toBe(404);
});

test("execution export finds its flushed session file", async () => {
	const { dir, db, app } = fixture();
	const pid = await createProject(app);
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES ('e1',?,'s1',2,1,'succeeded','2026-01-01')",
	).run(pid);
	const absent = await app.request(`/projects/${pid}/executions/e1/export?inline=1`);
	expect(absent.status).toBe(404);
	writeSession(dir, pid, "execute-s1-a2-2026-01-01T00-00-05-000Z.jsonl");
	const res = await app.request(`/projects/${pid}/executions/e1/export?inline=1`);
	expect(res.status).toBe(200);
	const html = await res.text();
	expect(JSON.stringify(exportedData(html).entries)).toContain("收到，执行 pwd");
	const other = await createProject(app);
	const cross = await app.request(`/projects/${other}/executions/e1/export?inline=1`);
	expect(cross.status).toBe(404);
});

test("session export supports legacy decide filenames containing colons", async () => {
	const { dir, app } = fixture();
	const pid = await createProject(app);
	const file = "decide-deepseek-v4-flash-u-yc3l-9894a960-5e98-4e92-8060-d37621085a90.jsonl";
	writeSession(dir, pid, file);

	const res = await app.request(
		`/projects/${pid}/sessions/${encodeURIComponent(file)}/export?inline=1`,
	);
	expect(res.status).toBe(200);
	expect(JSON.stringify(exportedData(await res.text()).entries)).toContain("你好 cairn-export");
});
