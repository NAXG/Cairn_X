import { inspectProject } from "../support/project-state.js";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "vitest";

import { cancelStepExecutions } from "../../src/server/core/execution-cascade.js";
import { expireWorkers } from "../../src/server/core/lease-expiry.js";
import { getExecutionRow, transitionExecution } from "../../src/server/core/executions.js";
import { recordUsage } from "../../src/server/core/usage.js";
import {
	backfillDecideUsage,
	backfillDecideUsageOnStartup,
	transcriptUsage,
} from "../../src/server/core/usage-backfill.js";
import { claimDecideForRead, createProject, createTestServer, post } from "./helpers.js";

const assistantLine = (usage: Record<string, number>): string =>
	JSON.stringify({ type: "message", message: { role: "assistant", usage } });

/** 与真实 Decide 落盘格式一致的一行（见 control/session 的 message_end 分支）。 */
const decideLine = (usage: Record<string, number>, model = "deepseek-v4-flash"): string =>
	JSON.stringify({ type: "message", message: { role: "assistant", model, usage } });

function writeDecideSession(
	dataRoot: string,
	projectId: string,
	file: string,
	lines: string[],
): string {
	const dir = path.join(dataRoot, projectId, "sessions");
	mkdirSync(dir, { recursive: true });
	const full = path.join(dir, file);
	writeFileSync(full, lines.join("\n") + "\n");
	return full;
}

function usageRows(db: ReturnType<typeof createTestServer>["db"], projectId: string) {
	return db
		.prepare("SELECT * FROM usage_events WHERE project_id = ? ORDER BY id")
		.all(projectId) as Array<Record<string, unknown>>;
}

async function projectWithRunningExecution(
	app: Parameters<typeof post>[0],
	db: ReturnType<typeof createTestServer>["db"],
) {
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "long scan",
		creator: "decider",
	});
	db.prepare(
		`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at, started_at)
		 VALUES ('exec-1', ?, 's001', 1, 1, 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run(pid);
	const events = db.prepare(
		"INSERT INTO execution_events (execution_id, seq, line) VALUES ('exec-1', ?, ?)",
	);
	events.run(1, assistantLine({ input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 }));
	events.run(2, JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }));
	events.run(3, assistantLine({ input: 500, output: 50, cacheRead: 1500, cacheWrite: 10 }));
	return pid;
}

test("cancelled execution's tokens are recovered from its transcript", async () => {
	const { app, db } = createTestServer();
	const pid = await projectWithRunningExecution(app, db);

	// 容器被掐：控制端把执行推到 cancelled，并在同一路径回填轨迹里的 token。
	cancelStepExecutions(db, pid, "s001", "2026-01-01T00:01:00Z");

	const rows = db
		.prepare("SELECT * FROM usage_events WHERE execution_id = 'exec-1'")
		.all() as Array<Record<string, unknown>>;
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		activity: "execute",
		step_id: "s001",
		input_tokens: 1500,
		output_tokens: 250,
		cache_read_tokens: 4500,
		cache_write_tokens: 10,
	});

	// StepModel.cost（Decide 看到的成本）必须包含这笔被取消的执行。
	const step = inspectProject(db, pid).steps.find((s) => s.id === "s001")!;
	expect(step.cost).toMatchObject({ executions: 1, input_tokens: 1500, output_tokens: 250 });
	expect(step.last_outcome).toBe("cancelled");
});

test("backfill is idempotent and a late worker flush does not double count", async () => {
	const { app, db } = createTestServer();
	const pid = await projectWithRunningExecution(app, db);
	cancelStepExecutions(db, pid, "s001", "2026-01-01T00:01:00Z");
	// 重复取消（例如路线级联又走到一次）不应再记一笔。
	cancelStepExecutions(db, pid, "s001", "2026-01-01T00:02:00Z");

	// Worker 迟到上报：同 execution_id 命中已有行，直接返回，不叠加。
	const late = recordUsage(db, pid, {
		activity: "execute",
		step_id: "s001",
		execution_id: "exec-1",
		model: "late-model",
		input_tokens: 9999,
		output_tokens: 9999,
	});
	expect(late.input_tokens).toBe(1500);
	const count = db
		.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE execution_id = 'exec-1'")
		.get() as { n: number };
	expect(count.n).toBe(1);
});

test("an execution with no assistant usage records nothing", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "crashed before the first model call",
		creator: "decider",
	});
	db.prepare(
		`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at, started_at)
		 VALUES ('exec-empty', ?, 's001', 1, 1, 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run(pid);
	cancelStepExecutions(db, pid, "s001", "2026-01-01T00:01:00Z");
	const count = db
		.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE execution_id = 'exec-empty'")
		.get() as { n: number };
	expect(count.n).toBe(0);
});

test("lease-expired executions are backfilled when the controller marks them lost", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "lost scan",
		creator: "decider",
	});
	db.prepare(
		`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at, started_at)
		 VALUES ('exec-2', ?, 's001', 1, 1, 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run(pid);
	db.prepare("INSERT INTO execution_events (execution_id, seq, line) VALUES ('exec-2', 1, ?)").run(
		assistantLine({ input: 700, output: 70, cacheRead: 0, cacheWrite: 0 }),
	);
	// 步骤租约早已过期，且 worker 指向该执行。
	db.prepare(
		`UPDATE steps SET status = 'claimed', worker = 'exec-2', lease_version = 1,
		 last_heartbeat_at = '2000-01-01T00:00:00Z', lease_expires_at = NULL
		 WHERE project_id = ? AND id = 's001'`,
	).run(pid);

	expireWorkers(db, pid);

	const usage = db.prepare("SELECT * FROM usage_events WHERE execution_id = 'exec-2'").get() as
		Record<string, unknown> | undefined;
	expect(usage).toMatchObject({ input_tokens: 700, output_tokens: 70 });
	const step = inspectProject(db, pid).steps.find((s) => s.id === "s001")!;
	expect(step.last_outcome).toBe("lost");
	expect(step.cost.input_tokens).toBe(700);
});

test("transcriptUsage only reads assistant usage blocks", () => {
	expect(
		transcriptUsage(
			JSON.stringify({ type: "message", message: { role: "user", usage: { input: 5 } } }),
		),
	).toBeNull();
	expect(transcriptUsage("not json")).toBeNull();
	expect(
		transcriptUsage(
			JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1 } } }),
		),
	).toEqual({ input: 1, output: 0, cache_read: 0, cache_write: 0, model: null });
});

function decideFixture() {
	const dataRoot = mkdtempSync(path.join(tmpdir(), "cairn-decide-usage-"));
	onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
	return { dataRoot, ...createTestServer({ dataRoot }) };
}

test("a decide round whose usage report was lost is recovered from its session file", async () => {
	const { app, db, dataRoot } = decideFixture();
	const pid = await createProject(app);
	await claimDecideForRead(app, pid, "decide-w1");
	// 这一轮跑完了，但运行结束时的用量上报失败了（控制面瞬时不可达）：
	// 只有逐条落盘的会话轨迹留下来。
	const file = writeDecideSession(dataRoot, pid, "decide-decide-w1-1.jsonl", [
		decideLine({ input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 }),
		JSON.stringify({ type: "message", message: { role: "user", content: "继续" } }),
		decideLine({ input: 500, output: 50, cacheRead: 1500, cacheWrite: 10 }),
	]);

	const released = await post(app, `/projects/${pid}/decide/release`, { worker: "decide-w1" });
	expect(released.status).toBe(200);

	const rows = usageRows(db, pid);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		activity: "decide",
		step_id: null,
		source_file: "decide-decide-w1-1.jsonl",
		model: "deepseek-v4-flash",
		input_tokens: 1500,
		output_tokens: 250,
		cache_read_tokens: 4500,
		cache_write_tokens: 10,
	});
	// 记账时间取轨迹最后写入时间，而不是补账那一刻。
	expect(rows[0].created_at).toBe(statSync(file).mtime.toISOString());
	// 补账随后进入投影片段：Decide 自己读图时能看到这笔成本。
	expect(inspectProject(db, pid).usage.decide).toMatchObject({
		events: 1,
		input_tokens: 1500,
	});
});

test("recovery is idempotent across release, complete and repeated sweeps", async () => {
	const { app, db, dataRoot } = decideFixture();
	const pid = await createProject(app);
	await claimDecideForRead(app, pid, "decide-w1");
	writeDecideSession(dataRoot, pid, "decide-decide-w1-2.jsonl", [
		decideLine({ input: 700, output: 70, cacheRead: 0, cacheWrite: 0 }),
	]);

	expect(backfillDecideUsage(db, pid, dataRoot)).toBe(1);
	expect(backfillDecideUsage(db, pid, dataRoot)).toBe(0);
	// release/complete 也会各自触发一次：已记账的文件被幂等键跳过。
	await post(app, `/projects/${pid}/decide/complete`, {
		worker: "decide-w1",
		planning_version: 0,
	});
	await post(app, `/projects/${pid}/decide/release`, { worker: "decide-w1" });

	const rows = usageRows(db, pid);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ input_tokens: 700, output_tokens: 70 });
});

test("a lost decide round is recovered even when it completed the project", async () => {
	const { app, db, dataRoot } = decideFixture();
	const pid = await createProject(app);
	await claimDecideForRead(app, pid, "decide-w1");
	writeDecideSession(dataRoot, pid, "decide-decide-w1-3.jsonl", [
		decideLine({ input: 400, output: 40, cacheRead: 100, cacheWrite: 0 }),
	]);

	// 这一轮自己达成了根目标：项目变 completed，随后 Dispatcher 的中止收尾
	// （release）会被 403 挡下 —— 用量仍然必须记上。
	await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "done",
	});
	const released = await post(app, `/projects/${pid}/decide/release`, { worker: "decide-w1" });
	expect(released.status).toBe(403);

	const rows = usageRows(db, pid);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		activity: "decide",
		source_file: "decide-decide-w1-3.jsonl",
		input_tokens: 400,
		output_tokens: 40,
		cache_read_tokens: 100,
	});
});

test("a partial recovery never blocks or shrinks the complete report that follows", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const body = {
		activity: "decide" as const,
		source_file: "decide-decide-partial.jsonl",
		model: "deepseek-v4-flash",
		input_tokens: 100,
		output_tokens: 10,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
	};
	// 先落地的可能是「运行还没写完文件」的部分观测。
	expect(recordUsage(db, pid, body).input_tokens).toBe(100);
	// 完整上报到达后按列取最大值：既不加倍计数，也不被部分值缩水。
	const complete = recordUsage(db, pid, {
		...body,
		input_tokens: 900,
		output_tokens: 90,
		cache_read_tokens: 500,
	});
	expect(complete).toMatchObject({ input_tokens: 900, output_tokens: 90, cache_read_tokens: 500 });
	// 反向顺序同样成立：完整的先落地，迟到的部分观测不缩水。
	const late = recordUsage(db, pid, body);
	expect(late).toMatchObject({ input_tokens: 900, cache_read_tokens: 500 });

	const rows = usageRows(db, pid);
	expect(rows).toHaveLength(1);
});

test("only decide transcripts with assistant usage are recovered", async () => {
	const { app, db, dataRoot } = decideFixture();
	const pid = await createProject(app);
	// 没有任何模型调用的一轮（会话头 + 用户消息）不写零值行。
	writeDecideSession(dataRoot, pid, "decide-decide-empty.jsonl", [
		JSON.stringify({ type: "session", id: "decide-empty" }),
	]);
	// Execute 的轨迹归 execution_id 的路径管，不在这里重复记账。
	writeDecideSession(dataRoot, pid, "execute-s001-a1-2026-01-01T00-00-00-000Z.jsonl", [
		decideLine({ input: 5000, output: 500, cacheRead: 0, cacheWrite: 0 }),
	]);
	// 不满足会话文件名模式的文件（人工放进去的笔记等）不记账。
	writeDecideSession(dataRoot, pid, "decide-notes.md", ["# 笔记"]);

	expect(backfillDecideUsage(db, pid, dataRoot)).toBe(0);
	expect(usageRows(db, pid)).toHaveLength(0);
});

test("startup sweep recovers projects without a live decide lease only", async () => {
	const { app, db, dataRoot } = decideFixture();
	const lost = await createProject(app);
	writeDecideSession(dataRoot, lost, "decide-decide-lost.jsonl", [
		decideLine({ input: 300, output: 30, cacheRead: 0, cacheWrite: 0 }),
	]);
	// 仍在跑的轮次：持有活动租约，会话文件还会继续写，必须跳过。
	const running = await createProject(app);
	await claimDecideForRead(app, running, "decide-live");
	writeDecideSession(dataRoot, running, "decide-decide-live.jsonl", [
		decideLine({ input: 800, output: 80, cacheRead: 0, cacheWrite: 0 }),
	]);

	const recovered = backfillDecideUsageOnStartup(db, dataRoot, new Date().toISOString());
	expect(recovered).toBe(1);
	expect(usageRows(db, lost)).toHaveLength(1);
	expect(usageRows(db, running)).toHaveLength(0);

	// 租约过期回收之后（真实部署里由下一次认领或服务启动触发）才补上。
	db.prepare(
		"UPDATE projects SET decide_expires_at = NULL, decide_last_heartbeat_at = '2000-01-01T00:00:00Z' WHERE id = ?",
	).run(running);
	expect(backfillDecideUsageOnStartup(db, dataRoot, new Date().toISOString())).toBe(1);
	expect(usageRows(db, running)).toHaveLength(1);
});

test("a controller-forced lost transition backfills the execution's tokens", async () => {
	const { app, db } = createTestServer();
	const pid = await projectWithRunningExecution(app, db);
	// 调度器在截止时间强制判 lost（POST /internal/executions/:id/status 走这里）。
	transitionExecution(db, getExecutionRow(db, "exec-1"), "lost", { error: "deadline exceeded" });
	const rows = db
		.prepare("SELECT * FROM usage_events WHERE execution_id = 'exec-1'")
		.all() as Array<Record<string, unknown>>;
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ input_tokens: 1500, output_tokens: 250 });
	expect(usageRows(db, pid)).toHaveLength(1);
});

test("a stale forced transition is rejected once the execution already reached a terminal state", async () => {
	const { app, db } = createTestServer();
	await projectWithRunningExecution(app, db);
	const stale = getExecutionRow(db, "exec-1");
	transitionExecution(db, stale, "cancelled");
	// 调用方拿着过期的 running 行再判 lost：不能覆盖已有终态。
	expect(() => transitionExecution(db, stale, "lost")).toThrow(/no longer running/);
	expect(getExecutionRow(db, "exec-1").status).toBe("cancelled");
});
