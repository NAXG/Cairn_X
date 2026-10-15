import { inspectProjectResponse } from "../support/project-state.js";
import { expect, test } from "vitest";

import { checkProjectUsageWritable } from "../../src/server/core/project-guards.js";
import { createProject, createTestServer, post } from "./helpers.js";

test("usage events can be recorded on active projects and returned with 201", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);

	const res = await post(app, `/projects/${pid}/usage`, {
		activity: "execute",
		model: "deepseek-chat",
		input_tokens: 120,
		output_tokens: 45,
	});
	expect(res.status).toBe(201);
	const event = await res.json();
	expect(event).toMatchObject({
		id: 1,
		project_id: pid,
		activity: "execute",
		step_id: null,
		model: "deepseek-chat",
		input_tokens: 120,
		output_tokens: 45,
	});
	expect(event.created_at).toBeTruthy();

	const row = db
		.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE project_id = ?")
		.get(pid) as { n: number };
	expect(row.n).toBe(1);
});

test("usage events may reference a step of the same project", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	const step = await (
		await post(app, `/projects/${pid}/steps`, {
			actor: "human",
			from: ["origin"],
			description: "do work",
			creator: "decide",
		})
	).json();

	const res = await post(app, `/projects/${pid}/usage`, {
		activity: "execute",
		step_id: step.id,
		model: "qwen",
		input_tokens: 10,
		output_tokens: 20,
	});
	expect(res.status).toBe(201);
	expect((await res.json()).step_id).toBe(step.id);

	const missing = await post(app, `/projects/${pid}/usage`, {
		activity: "execute",
		step_id: "s999",
		model: "qwen",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(missing.status).toBe(404);
});

test("usage is rejected with invalid bodies", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const badActivity = await post(app, `/projects/${pid}/usage`, {
		activity: "bootstrap",
		model: "m",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(badActivity.status).toBe(400);

	const negative = await post(app, `/projects/${pid}/usage`, {
		activity: "decide",
		model: "m",
		input_tokens: -1,
		output_tokens: 1,
	});
	expect(negative.status).toBe(400);

	const missingModel = await post(app, `/projects/${pid}/usage`, {
		activity: "decide",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(missingModel.status).toBe(400);
});

test("usage write permissions by activity", async () => {
	const { app } = createTestServer();
	const stopped = await createProject(app);
	await post(app, `/projects/${stopped}/status`, { status: "stopped" });
	const resStopped = await post(app, `/projects/${stopped}/usage`, {
		activity: "decide",
		model: "m",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(resStopped.status).toBe(403);
	expect((await resStopped.json()).detail).toBe("Project is stopped");

	// decide 的遥测数据可能在最后一次 decide 完成项目之后才到达，
	// 因此已完成的项目也接受它。
	const completed = await createProject(app);
	await post(app, `/projects/${completed}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "done",
	});
	const resCompleted = await post(app, `/projects/${completed}/usage`, {
		activity: "decide",
		model: "m",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(resCompleted.status).toBe(201);
	// 项目完成后不再接受 execute 遥测：Worker 用量与结果同事务提交，
	// 取消/失联由控制端在终态化时回填。
	const resExecute = await post(app, `/projects/${completed}/usage`, {
		activity: "execute",
		model: "m",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(resExecute.status).toBe(403);
});

test("execute usage is rejected after completion regardless of elapsed time", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/complete`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "done",
	});
	const res = await post(app, `/projects/${pid}/usage`, {
		activity: "execute",
		model: "m",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(res.status).toBe(403);
	expect(() => checkProjectUsageWritable(db, pid, "execute")).toThrow();
});

test("project detail and graph record carry usage aggregates grouped by activity", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	await post(app, `/projects/${pid}/usage`, {
		activity: "execute",
		model: "m",
		input_tokens: 100,
		output_tokens: 40,
	});
	await post(app, `/projects/${pid}/usage`, {
		activity: "execute",
		model: "m",
		input_tokens: 50,
		output_tokens: 60,
	});
	await post(app, `/projects/${pid}/usage`, {
		activity: "decide",
		model: "n",
		input_tokens: 70,
		output_tokens: 30,
	});

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.usage).toEqual({
		decide: {
			events: 1,
			input_tokens: 70,
			output_tokens: 30,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		},
		execute: {
			events: 2,
			input_tokens: 150,
			output_tokens: 100,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		},
	});

	// 用量也作为图记录暴露给 Decide（record view 的 usage 段）。
	await post(app, `/projects/${pid}/decide/claim`, { worker: "reader" });
	const record = await post(app, `/projects/${pid}/decide/graph`, {
		worker: "reader",
		view: "record",
		section: "usage",
		id: "usage",
	});
	expect(record.status).toBe(200);
	const rows = (await record.json()).record.rows as Array<Record<string, unknown>>;
	expect(rows.find((row) => row.activity === "execute")).toMatchObject({
		events: 2,
		input_tokens: 150,
	});
});

test("usage events record cache tokens and aggregates expose them", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const res = await post(app, `/projects/${pid}/usage`, {
		activity: "execute",
		model: "deepseek-chat",
		input_tokens: 100,
		output_tokens: 20,
		cache_read_tokens: 900,
	});
	expect(res.status).toBe(201);
	const event = await res.json();
	expect(event).toMatchObject({ cache_read_tokens: 900, cache_write_tokens: 0 });

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.usage.execute).toMatchObject({
		input_tokens: 100,
		cache_read_tokens: 900,
		cache_write_tokens: 0,
	});
});

async function projectWithExecution(app: ReturnType<typeof createTestServer>["app"]) {
	const pid = await createProject(app);
	const step = await (
		await post(app, `/projects/${pid}/steps`, {
			actor: "human",
			from: ["origin"],
			description: "do work",
			creator: "human",
		})
	).json();
	return { pid, stepId: step.id as string };
}

test("public usage endpoint accepts execution_id and dedupes by it", async () => {
	const { app, db } = createTestServer();
	const { pid, stepId } = await projectWithExecution(app);
	db.prepare(
		`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at, started_at)
		 VALUES ('exec-pub-1', ?, ?, 1, 1, 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run(pid, stepId);

	const body = {
		activity: "execute",
		step_id: stepId,
		execution_id: "exec-pub-1",
		model: "m",
		input_tokens: 10,
		output_tokens: 5,
	};
	const first = await post(app, `/projects/${pid}/usage`, body);
	expect(first.status).toBe(201);
	expect((await first.json()).execution_id).toBe("exec-pub-1");

	// 迟到重传同一 execution_id 必须幂等，不叠加。
	const second = await post(app, `/projects/${pid}/usage`, { ...body, input_tokens: 999 });
	expect(second.status).toBe(201);
	expect((await second.json()).input_tokens).toBe(10);
	const count = db
		.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE execution_id = 'exec-pub-1'")
		.get() as { n: number };
	expect(count.n).toBe(1);
});

test("public usage endpoint rejects an execution owned by another project", async () => {
	const { app, db } = createTestServer();
	const a = await createProject(app);
	const b = await createProject(app);
	db.prepare(
		`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at, started_at)
		 VALUES ('exec-b', ?, 's001', 1, 1, 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run(b);

	const res = await post(app, `/projects/${a}/usage`, {
		activity: "execute",
		execution_id: "exec-b",
		model: "m",
		input_tokens: 1,
		output_tokens: 1,
	});
	expect(res.status).toBe(400);
});

test("public usage endpoint dedupes decide reports by source_file", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const body = {
		activity: "decide",
		source_file: "decide-decide-w1-1.jsonl",
		model: "deepseek-v4-flash",
		input_tokens: 120,
		output_tokens: 45,
	};
	const first = await post(app, `/projects/${pid}/usage`, body);
	expect(first.status).toBe(201);
	expect((await first.json()).source_file).toBeUndefined();

	// 同一次运行的重复上报（网络重试）不叠加。
	const second = await post(app, `/projects/${pid}/usage`, { ...body, input_tokens: 999 });
	expect(second.status).toBe(201);
	const rows = db
		.prepare("SELECT COUNT(*) AS n, MAX(input_tokens) AS input_tokens FROM usage_events")
		.get() as { n: number; input_tokens: number };
	expect(rows).toEqual({ n: 1, input_tokens: 999 });

	// 文件名必须落在会话轨迹命名约定里，否则拒绝：它不是自由文本字段。
	const bad = await post(app, `/projects/${pid}/usage`, {
		...body,
		source_file: "../../etc/passwd",
	});
	expect(bad.status).toBe(400);
});
