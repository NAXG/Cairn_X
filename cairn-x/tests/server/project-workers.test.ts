import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";

import type { ProjectWorkerTask } from "../../src/contracts/execution.js";
import type { ConfigurationControl } from "../../src/control/index.js";
import { getExecutionRow } from "../../src/server/core/executions.js";
import { getProjectWorker } from "../../src/server/core/project-workers.js";
import { WorkerClient } from "../../src/worker/client.js";
import { finalizeWorkerRun } from "../../src/worker/agent.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import {
	addStep,
	createProject,
	scriptConnectionWithFaux,
	startExecutorTestServer,
	type TestServer,
} from "../orchestrator/helpers.js";

const model = { api: "openai-completions" as const, base_url: "http://unused", api_key: "test" };
const MACHINE_TOKEN = "test-token";

function machineFetch(
	url: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<Response> {
	return fetch(`${url}${path}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${MACHINE_TOKEN}`,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

function projectFetch(url: string, token: string, path: string, body?: unknown): Promise<Response> {
	return fetch(`${url}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function setup(): Promise<TestServer & { pid: string; control: ConfigurationControl }> {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	return { ...server, pid };
}

/** dispatcher 侧：认领 step 并创建一个没有执行令牌的 queued execution。 */
async function queueExecution(
	s: TestServer & { pid: string },
	stepId: string,
): Promise<{ executionId: string }> {
	const executionId = randomUUID();
	expect((await s.client.claimStep(s.pid, stepId, executionId)).ok).toBe(true);
	const created = await s.client.createExecution({
		project_id: s.pid,
		step_id: stepId,
		execution_id: executionId,
	});
	expect(created.ok).toBe(true);
	expect(created.data).not.toHaveProperty("token");
	expect(s.db.prepare("SELECT token_hash FROM executions WHERE id = ?").get(executionId)).toEqual({
		token_hash: null,
	});
	return { executionId };
}

async function issueProjectToken(s: TestServer & { pid: string }, containerName?: string) {
	const res = await machineFetch(s.url, `/internal/project-workers/${s.pid}/token`, {
		method: "POST",
		body: { container_name: containerName },
	});
	expect(res.status).toBe(201);
	return (await res.json()) as { project_id: string; token: string; container_name: string | null };
}

test("next() mints an execution token when it claims a queued execution", async () => {
	const s = await setup();
	const sid = await addStep(s.client, s.pid);
	const { executionId } = await queueExecution(s, sid);
	const issued = await issueProjectToken(s, "cairn-pw-test");
	expect(issued.project_id).toBe(s.pid);

	const next = await projectFetch(s.url, issued.token, `/internal/project-workers/${s.pid}/next`);
	expect(next.status).toBe(200);
	const task = (await next.json()) as ProjectWorkerTask;
	expect(task.execution_id).toBe(executionId);
	expect(task.project_id).toBe(s.pid);
	expect(task.step_description).toBe("do work");
	expect(task.finding_schema).toBeNull();
	expect(task.token).toBeTruthy();
	expect(getExecutionRow(s.db, executionId).status).toBe("running");

	// 现签令牌可以驱动既有的 /internal/executions/:id/* 接口。
	const fresh = new WorkerClient(s.url, executionId, task.token);
	expect((await fresh.heartbeat()).ok).toBe(true);
	// 随机旧令牌不能访问执行协议。
	const stale = new WorkerClient(s.url, executionId, "stale-execution-token");
	expect((await stale.heartbeat()).statusCode).toBe(401);

	// 没有更多 queued execution → 204，循环自行退避。
	const empty = await projectFetch(s.url, issued.token, `/internal/project-workers/${s.pid}/next`);
	expect(empty.status).toBe(204);

	// 心跳把注册行推进到 running，且视图不泄漏 token_hash。
	const row = getProjectWorker(s.db, s.pid)!;
	expect(row.status).toBe("running");
	expect(row.container_name).toBe("cairn-pw-test");
	const view = await (await machineFetch(s.url, `/internal/project-workers/${s.pid}`)).json();
	expect(view).toMatchObject({
		project_id: s.pid,
		status: "running",
		container_name: "cairn-pw-test",
	});
	expect(view).not.toHaveProperty("token_hash");
});

test("next() sends the complete Finding schema only for the claimed project", async () => {
	const s = await setup();
	const schema = {
		type: "object",
		required: ["severity"],
		properties: { severity: { type: "string", description: "完整结构".repeat(1000) } },
	};
	s.db
		.prepare("UPDATE projects SET finding_schema=? WHERE id=?")
		.run(JSON.stringify(schema), s.pid);
	await createProject(s.client, { finding_schema: { description: "foreign contract" } });
	const sid = await addStep(s.client, s.pid);
	await queueExecution(s, sid);
	const { token } = await issueProjectToken(s);
	const response = await projectFetch(s.url, token, `/internal/project-workers/${s.pid}/next`);
	expect(response.status).toBe(200);
	const task = (await response.json()) as ProjectWorkerTask;
	expect(task.finding_schema).toEqual(schema);
	expect(JSON.stringify(task)).not.toContain("foreign contract");
	expect(task).not.toHaveProperty("goals");
	expect(task).not.toHaveProperty("hints");
});

test("next() hands each queued execution to exactly one caller", async () => {
	const s = await setup();
	const sidA = await addStep(s.client, s.pid, { description: "do work A" });
	const sidB = await addStep(s.client, s.pid, { description: "do work B" });
	const a = await queueExecution(s, sidA);
	const b = await queueExecution(s, sidB);
	const { token } = await issueProjectToken(s);

	const responses = await Promise.all(
		[0, 1, 2].map(() => projectFetch(s.url, token, `/internal/project-workers/${s.pid}/next`)),
	);
	const claimed: string[] = [];
	for (const res of responses) {
		if (res.status === 200) {
			claimed.push(((await res.json()) as ProjectWorkerTask).execution_id);
		} else {
			expect(res.status).toBe(204);
		}
	}
	expect(new Set(claimed)).toEqual(new Set([a.executionId, b.executionId]));
	expect(responses.filter((r) => r.status === 204)).toHaveLength(1);
});

test("next() leaves the execution queued when the task payload cannot be built", async () => {
	const s = await setup();
	const sid = await addStep(s.client, s.pid);
	const { executionId } = await queueExecution(s, sid);
	const { token } = await issueProjectToken(s);

	// 任务载荷依赖执行的活动配置快照；快照缺失时组装必须失败。
	s.db.prepare("DELETE FROM activity_configurations WHERE id = ?").run(executionId);
	const failed = await projectFetch(s.url, token, `/internal/project-workers/${s.pid}/next`);
	expect(failed.status).toBe(409);
	// execution 保持 queued：没有令牌被发给任何一方，不得卡在 running。
	expect(getExecutionRow(s.db, executionId).status).toBe("queued");

	// 快照恢复（重新签发同样的 id）后可以正常领取。
	s.control.store.snapshot(executionId, "execute", s.pid);
	const retry = await projectFetch(s.url, token, `/internal/project-workers/${s.pid}/next`);
	expect(retry.status).toBe(200);
	expect(((await retry.json()) as ProjectWorkerTask).execution_id).toBe(executionId);
	expect(getExecutionRow(s.db, executionId).status).toBe("running");
});

test("next() skips an unbuildable candidate instead of blocking the queue", async () => {
	const s = await setup();
	const sidA = await addStep(s.client, s.pid, { description: "do work A" });
	const sidB = await addStep(s.client, s.pid, { description: "do work B" });
	const a = await queueExecution(s, sidA);
	const b = await queueExecution(s, sidB);
	const { token } = await issueProjectToken(s);
	// created_at 精度到秒，先固定 A 更早，确保 A 是队首（被阻塞的候选）。
	s.db
		.prepare("UPDATE executions SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?")
		.run(a.executionId);

	// 队首执行 A 的快照缺失（组装必失败）；后面的 B 必须仍能被领取。
	s.db.prepare("DELETE FROM activity_configurations WHERE id = ?").run(a.executionId);
	const next = await projectFetch(s.url, token, `/internal/project-workers/${s.pid}/next`);
	expect(next.status).toBe(200);
	const task = (await next.json()) as ProjectWorkerTask;
	expect(task.execution_id).toBe(b.executionId);
	expect(getExecutionRow(s.db, a.executionId).status).toBe("queued");
	expect(getExecutionRow(s.db, b.executionId).status).toBe("running");
});

test("a stopped project worker token cannot claim more tasks", async () => {
	const s = await setup();
	const sid = await addStep(s.client, s.pid);
	await queueExecution(s, sid);
	const { token } = await issueProjectToken(s);

	const stop = await machineFetch(s.url, `/internal/project-workers/${s.pid}/stop`, {
		method: "POST",
	});
	expect(stop.status).toBe(200);
	const stopped = (await stop.json()) as { status: string };
	expect(stopped.status).toBe("stopped");

	const next = await projectFetch(s.url, token, `/internal/project-workers/${s.pid}/next`);
	expect(next.status).toBe(403);
});

test("a project worker token is rejected for another project", async () => {
	const s = await setup();
	const otherPid = await createProject(s.client);
	const { token } = await issueProjectToken(s);
	const res = await projectFetch(s.url, token, `/internal/project-workers/${otherPid}/next`);
	expect(res.status).toBe(403);
});

test("machine can list project workers without leaking token hashes", async () => {
	const s = await setup();
	await issueProjectToken(s, "cairn-pw-list");
	const res = await machineFetch(s.url, "/internal/project-workers");
	expect(res.status).toBe(200);
	const list = (await res.json()) as Array<Record<string, unknown>>;
	expect(list).toHaveLength(1);
	expect(list[0]).toMatchObject({
		project_id: s.pid,
		status: "pending",
		container_name: "cairn-pw-list",
	});
	expect(list[0]).not.toHaveProperty("token_hash");
});

test("project worker token issuance requires the machine token", async () => {
	const s = await setup();
	const res = await fetch(`${s.url}/internal/project-workers/${s.pid}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	expect(res.status).toBe(401);
});

test("abandoning a step immediately cancels its queued and running executions", async () => {
	const s = await setup();
	const queuedStep = await addStep(s.client, s.pid, { description: "queued work" });
	const runningStep = await addStep(s.client, s.pid, { description: "running work" });
	const queued = await queueExecution(s, queuedStep);
	const running = await queueExecution(s, runningStep);

	// 项目 Worker 只领走其中一个（queued 里最早的那条），另一个保持 queued。
	const a = { step: queuedStep, exec: queued.executionId };
	const b = { step: runningStep, exec: running.executionId };
	const { token: projectToken } = await issueProjectToken(s);
	const next = await projectFetch(s.url, projectToken, `/internal/project-workers/${s.pid}/next`);
	expect(next.status).toBe(200);
	const task = (await next.json()) as ProjectWorkerTask;
	const active = task.step_id === a.step ? a : b;
	const idle = active === a ? b : a;
	expect(task.execution_id).toBe(active.exec);
	expect(getExecutionRow(s.db, active.exec).status).toBe("running");
	expect(getExecutionRow(s.db, idle.exec).status).toBe("queued");

	// Decide 放弃这两步。
	expect((await s.client.abandonStep(s.pid, active.step, active.exec)).ok).toBe(true);
	expect((await s.client.abandonStep(s.pid, idle.step, idle.exec)).ok).toBe(true);

	// 在途执行必须当场终态化。否则 worker 的模型流会被 activity guard 掐断，
	// 结果上报与事件上传又都被 409 拒绝，执行只能挂满 deadline 才判 lost ——
	// 白占 28 分钟预算、丢掉轨迹尾部，还用 execution_lost 唤醒 Decide。
	for (const id of [idle.exec, active.exec]) {
		const row = getExecutionRow(s.db, id);
		expect(row.status).toBe("cancelled");
		expect(row.finished_at).not.toBeNull();
	}

	// 已被控制器终结：worker 的迟到结果被拒绝，而不是被当成"已确认"。
	const late = await new WorkerClient(s.url, active.exec, task.token).reportResult({
		outcome: "failed",
		error: "late",
	});
	expect(late.statusCode).toBe(409);
});

test("a 409 result report is surfaced instead of being silently treated as confirmed", async () => {
	const s = await setup();
	const sid = await addStep(s.client, s.pid);
	const { executionId } = await queueExecution(s, sid);
	const { token: projectToken } = await issueProjectToken(s);
	const next = await projectFetch(s.url, projectToken, `/internal/project-workers/${s.pid}/next`);
	const task = (await next.json()) as ProjectWorkerTask;

	// 步骤被放弃 → 执行被控制端终结 → worker 之后的上报必然 409。
	expect((await s.client.abandonStep(s.pid, sid, executionId)).ok).toBe(true);

	const logs: string[] = [];
	const logger = {
		debug: () => {},
		info: () => {},
		warn: (m: string) => void logs.push(m),
		error: (m: string) => void logs.push(`error: ${m}`),
	};
	const result = await finalizeWorkerRun(
		new WorkerClient(s.url, executionId, task.token),
		{ outcome: "failed", finalText: "done", usage: null, leaseFailure: null },
		logger,
	);

	// 回归点：以前 409 被当作"控制端已归档，视为确认"，既不重试也不留日志，
	// 于是"结果从未落库"在运维视角完全不可见，只能等 deadline 判 lost 才暴露。
	expect(result.exitCode).toBe(1);
	expect(logs.join("\n")).toContain("409");
	expect(logs.filter((l) => l.startsWith("error:"))).toHaveLength(0);
});

test("a model stream revoked by the controller is marked revoked, not as an endpoint failure", async () => {
	const s = await setup();
	const sid = await addStep(s.client, s.pid);
	const queued = await queueExecution(s, sid);
	const { token: projectToken } = await issueProjectToken(s);
	const next = await projectFetch(s.url, projectToken, `/internal/project-workers/${s.pid}/next`);
	expect(next.status).toBe(200);
	const task = (await next.json()) as ProjectWorkerTask;

	// 连接 id 从该执行的活动快照里取，避免写死 imported-execute 这种实现细节。
	const connectionId = s.control.store.readSnapshot(queued.executionId)!.provider.id;

	// faux provider：流保持打开，随后"干净结束"（不推任何终止事件）—— 刻意走
	// provider 不抛错的那条路径，回收原因必须由控制端在循环之后补发。
	const aborted = () => ({
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "faux",
		model: "faux-execute",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "upstream aborted",
		timestamp: Date.now(),
	});
	await scriptConnectionWithFaux(s.control, connectionId, {
		provider: {
			streamSimple: (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
				const stream = createAssistantMessageEventStream();
				const finish = () => {
					stream.push({ type: "error", reason: "error", error: aborted() } as never);
					stream.end();
				};
				// 真实 provider 在 signal abort 时会终止自己的流（推终止事件或抛错）。
				options?.signal?.addEventListener("abort", finish, { once: true });
				setTimeout(finish, 8000);
				return stream;
			},
		},
	});

	const res = await fetch(`${s.url}/internal/activities/model`, {
		method: "POST",
		headers: { Authorization: `Bearer ${task.token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ context: { messages: [] } }),
	});
	expect(res.status).toBe(200);

	// 流已经打开，此时放弃步骤：activity guard 下一次 tick 会撤销这次执行。
	const chunks: string[] = [];
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	const reading = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(decoder.decode(value, { stream: true }));
		}
	})();
	// 等 guard 至少走过一个 tick，再放弃步骤（guard 每 1000ms 校验一次）。
	await new Promise((resolve) => setTimeout(resolve, 1500));
	expect((await s.client.abandonStep(s.pid, sid, task.execution_id)).ok).toBe(true);
	await reading;

	// 回归点：被回收的流必须显式标记 revoked。否则 worker 会把它当成上游模型
	// 故障（unhealthy），进而冷却一个健康的端点、把自伤伪装成供应商故障。
	const sse = chunks.join("");
	expect(sse).toContain('"reason":"revoked"');
}, 20_000);
