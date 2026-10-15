import { expect, test } from "vitest";
import {
	annotateInterruptedTool,
	lastPendingToolCall,
} from "../../src/server/core/event-search.js";
import { createProject, createTestServer, get, post } from "./helpers.js";

function seedEvents(db: any, pid: string) {
	const now = "2026-01-01T00:00:00Z";
	db.prepare(
		"INSERT INTO steps (id, project_id, description, creator, created_at) VALUES ('s001', ?, 'work', 'test', ?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('e1', ?, 's001', 1, 0, 'succeeded', ?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('e2', ?, 's001', 2, 0, 'lost', ?)",
	).run(pid, now);
	const insert = db.prepare(
		"INSERT INTO execution_events (execution_id, seq, line) VALUES (?, ?, ?)",
	);
	const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
		JSON.stringify({ type: "message", message: { role, content, ...extra } });
	insert.run("e1", 1, msg("user", "检查 config.yaml 的认证配置"));
	insert.run(
		"e1",
		2,
		msg("assistant", [
			{ type: "thinking", thinking: "SECRET-THOUGHT 不应被检索" },
			{ type: "text", text: "先读取文件" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/workspace/config.yaml" } },
		]),
	);
	insert.run(
		"e1",
		3,
		msg("toolResult", [{ type: "text", text: "auth: token endpoint https://auth.example.com" }], {
			toolCallId: "c1",
		}),
	);
	insert.run("e2", 1, msg("user", "重试认证检查"));
	insert.run("e2", 2, msg("toolResult", [{ type: "text", text: "connection refused" }]));
}

test("keyword search hits visible fields with AND semantics and excludes thinking blocks", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	seedEvents(db, pid);

	const res = await get(app, `/projects/${pid}/events/search?q=auth.example.com`);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.hits).toHaveLength(1);
	expect(body.hits[0]).toMatchObject({
		execution_id: "e1",
		step_id: "s001",
		seq: 3,
		field: "toolResult.text",
	});
	expect(body.hits[0].excerpt).toContain("auth.example.com");

	// AND：两个词须同时出现。
	expect(
		(await (await get(app, `/projects/${pid}/events/search?q=auth refused`)).json()).hits,
	).toHaveLength(0);
	// 大小写不敏感。
	expect(
		(await (await get(app, `/projects/${pid}/events/search?q=REFUSED`)).json()).hits[0]
			.execution_id,
	).toBe("e2");
	// 思考块不参与检索。
	expect(
		(await (await get(app, `/projects/${pid}/events/search?q=SECRET-THOUGHT`)).json()).hits,
	).toHaveLength(0);
	// 工具调用可检索。
	expect(
		(await (await get(app, `/projects/${pid}/events/search?q=config.yaml`)).json()).hits.map(
			(h: any) => h.seq,
		),
	).toEqual([1, 2]);

	// 过滤器：execution / step。
	expect(
		(await (await get(app, `/projects/${pid}/events/search?q=refused&execution_id=e1`)).json())
			.hits,
	).toHaveLength(0);
});

test("query validation, pagination cursor and scan budget are enforced", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	seedEvents(db, pid);
	for (const q of ["", "a".repeat(201), "a b c d e f", `${"x".repeat(81)}`]) {
		expect(
			(await get(app, `/projects/${pid}/events/search?q=${encodeURIComponent(q)}`)).status,
		).toBe(400);
	}
	expect((await get(app, `/projects/${pid}/events/search`)).status).toBe(400);
	expect((await get(app, `/projects/${pid}/events/search?q=a&limit=51`)).status).toBe(400);
	expect((await get(app, `/projects/${pid}/events/search?q=a&cursor=bad`)).status).toBe(400);

	// 多次命中分页：limit=1 逐页翻。
	const first = await (await get(app, `/projects/${pid}/events/search?q=检查&limit=1`)).json();
	expect(first.hits).toHaveLength(1);
	expect(first.truncated).toBe(true);
	const second = await (
		await get(
			app,
			`/projects/${pid}/events/search?q=检查&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
		)
	).json();
	expect(second.hits).toHaveLength(1);
	expect(second.hits[0].execution_id).not.toBe(first.hits[0].execution_id);
	expect(
		second.hits[0].execution_id === first.hits[0].execution_id &&
			second.hits[0].seq <= first.hits[0].seq,
	).toBe(false);
});

test("search is scoped to the project", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	seedEvents(db, pid);
	const other = await createProject(app);
	const res = await (await get(app, `/projects/${other}/events/search?q=auth.example.com`)).json();
	expect(res.hits).toHaveLength(0);
	// 其他项目的 execution 过滤器也查不到本项目内容。
	const res2 = await (
		await get(app, `/projects/${other}/events/search?q=refused&execution_id=e2`)
	).json();
	expect(res2.hits).toHaveLength(0);
});

test("search scan budget continues across executions and retains the lookahead row", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	seedEvents(db, pid);
	db.prepare("DELETE FROM execution_events").run();
	const insert = db.prepare("INSERT INTO execution_events VALUES(?,?,?)");
	const line = JSON.stringify({ type: "message", message: { role: "user", content: "needle" } });
	db.transaction(() => {
		for (let i = 1; i <= 4000; i++) insert.run("e1", i, "{}");
		insert.run("e2", 1, line);
	})();
	const first = await (await get(app, `/projects/${pid}/events/search?q=needle`)).json();
	expect(first).toMatchObject({ scanned: 4000, hits: [], truncated: true, next_cursor: "e1:4000" });
	const second = await (
		await get(
			app,
			`/projects/${pid}/events/search?q=needle&cursor=${encodeURIComponent(first.next_cursor)}`,
		)
	).json();
	expect(second).toMatchObject({ scanned: 1, truncated: false, next_cursor: null });
	expect(second.hits).toEqual([expect.objectContaining({ execution_id: "e2", seq: 1 })]);
});

test("decide lease binding is enforced for worker-param reads", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	seedEvents(db, pid);
	await post(app, `/projects/${pid}/decide/signal`, { signal: "read" });
	await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" });
	expect((await get(app, `/projects/${pid}/events/search?q=refused&worker=reader`)).status).toBe(
		200,
	);
	expect((await get(app, `/projects/${pid}/events/search?q=refused&worker=stale`)).status).toBe(
		409,
	);
});

test("search byte budget keeps the first unreturned hit for the next page", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const now = "2026-01-01T00:00:00Z";
	db.prepare(
		"INSERT INTO steps (id, project_id, description, creator, created_at) VALUES ('s001', ?, 'work', 'test', ?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('e1', ?, 's001', 1, 0, 'succeeded', ?)",
	).run(pid, now);
	const insert = db.prepare(
		"INSERT INTO execution_events (execution_id, seq, line) VALUES (?, ?, ?)",
	);
	for (let i = 1; i <= 50; i += 1) {
		insert.run(
			"e1",
			i,
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: `needle ${"\u0000".repeat(240)} ${i}` }],
				},
			}),
		);
	}
	const first = await (await get(app, `/projects/${pid}/events/search?q=needle&limit=50`)).json();
	expect(first.truncated).toBe(true);
	expect(first.hits.length).toBeGreaterThan(0);
	const lastSeq = first.hits[first.hits.length - 1].seq;
	const second = await (
		await get(
			app,
			`/projects/${pid}/events/search?q=needle&limit=50&cursor=${encodeURIComponent(first.next_cursor)}`,
		)
	).json();
	expect(second.hits[0].seq).toBe(lastSeq + 1);
});

// 执行被控制端硬杀（deadline → lost）时 Worker 来不及上报，error 里只剩一句
// "deadline exceeded"。轨迹是实时持久化的，所以可以反推它卡在哪个工具上 —— 这正是
// 2026-09-11 那次「静默 25 分钟然后 lost」唯一缺失的诊断信息。
test("a hard-killed execution names the tool it was stuck on", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const now = "2026-01-01T00:00:00Z";
	db.prepare(
		"INSERT INTO steps (id, project_id, description, creator, created_at) VALUES ('s001', ?, 'work', 'test', ?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('stuck', ?, 's001', 1, 0, 'running', ?)",
	).run(pid, now);
	const insert = db.prepare(
		"INSERT INTO execution_events (execution_id, seq, line) VALUES (?, ?, ?)",
	);
	const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
		JSON.stringify({ type: "message", message: { role, content, ...extra } });
	insert.run(
		"stuck",
		1,
		msg("assistant", [
			{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "nmap -p- 10.0.183.200" } },
		]),
	);
	expect(lastPendingToolCall(db, "stuck")).toEqual({
		name: "bash",
		preview: '{"command":"nmap -p- 10.0.183.200"}',
	});
	const annotated = annotateInterruptedTool(db, "stuck", "controller deadline exceeded");
	expect(annotated).toContain("controller deadline exceeded");
	expect(annotated).toContain("bash");
	expect(annotated).toContain("nmap -p-");

	// 注：经 status 路由 / reaper 落 lost 时的接线由 tsc 保证；createTestServer
	// 不挂执行模块路由，这里只锁纯函数行为。

	// 工具已返回 → 不算卡住，error 原样透传。
	insert.run("stuck", 2, msg("toolResult", [{ type: "text", text: "done" }], { toolCallId: "c9" }));
	expect(lastPendingToolCall(db, "stuck")).toBeNull();
	expect(annotateInterruptedTool(db, "stuck", "x")).toBe("x");
	// 没有轨迹的执行 → 原样透传，绝不因为查不到就丢掉原 error。
	expect(annotateInterruptedTool(db, "no-such-execution", "x")).toBe("x");
});
