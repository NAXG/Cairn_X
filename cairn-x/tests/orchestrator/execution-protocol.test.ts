import { inspectProject } from "../support/project-state.js";
/**
 * Executor 执行协议专项测试（服务端语义）：
 * - 租约绑定与版本拒绝（过期执行者的写入必须被 403/409 拒绝）
 * - 事件与事实提交的幂等重传
 * - 取消传播与凭据失效
 * - 受限模型代理（真实 HTTP 上游，注入长期 key，流式透传）
 */

import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import path from "node:path";
import type { FgsClient } from "../../src/orchestrator/client.js";
import {
	appendExecutionEvents,
	applyExecutionResult,
	escalateFromExecution,
	getExecutionRow,
} from "../../src/server/core/executions.js";
import {
	claimExecutionWithProjectWorker,
	createProject,
	addStep,
	startExecutorTestServer,
} from "./helpers.js";

const EID = "10000000-0000-4000-8000-000000000001";

interface Setup {
	url: string;
	token: string;
	pid: string;
	stepId: string;
	executionId: string;
	db: import("../../src/server/db.js").Db;
	client: FgsClient;
	authFetch: (path: string, init?: RequestInit) => Promise<Response>;
	machineFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

async function setup(): Promise<Setup> {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk-long-term",
	});
	const client = server.client;
	const pid = await createProject(client);
	const stepId = await addStep(client, pid);
	const claim = await client.claimStep(pid, stepId, EID);
	if (!claim.ok) {
		throw new Error(`claim failed: ${claim.statusCode}`);
	}
	const created = await client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: EID,
	});
	if (!created.ok || created.data === undefined) {
		throw new Error(`createExecution failed: ${created.statusCode} ${created.text}`);
	}
	const claimed = await claimExecutionWithProjectWorker(server, pid, EID);
	const token = claimed.task.token;
	const authFetch = (path: string, init?: RequestInit) =>
		fetch(`${server.url}${path}`, {
			...init,
			headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
		});
	const machineFetch = (path: string, init?: RequestInit) =>
		fetch(`${server.url}${path}`, {
			...init,
			headers: { ...(init?.headers ?? {}), Authorization: `Bearer test-token` },
		});
	return {
		client,
		url: server.url,
		token,
		pid,
		stepId,
		executionId: EID,
		authFetch,
		machineFetch,
		db: server.db,
	};
}

test("execution creation requires the step lease to be claimed by the execution id", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "k",
	});
	const pid = await createProject(server.client);
	const stepId = await addStep(server.client, pid);
	// 未认领直接创建 → 409
	const bad = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: EID,
	});
	expect(bad.ok).toBe(false);
	expect(bad.statusCode).toBe(409);
	// 用其他 worker 认领 → 409
	const other = await server.client.claimStep(pid, stepId, "some-other-worker");
	expect(other.ok).toBe(true);
	const bad2 = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: EID,
	});
	expect(bad2.ok).toBe(false);
});

test("execution creation is idempotent per execution_id and replays even after the lease is gone", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "k",
	});
	const pid = await createProject(server.client);
	const stepId = await addStep(server.client, pid);
	expect((await server.client.claimStep(pid, stepId, EID)).ok).toBe(true);
	const first = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: EID,
	});
	expect(first.statusCode).toBe(201);
	expect(first.data).toBeDefined();
	// 重复 POST = 幂等回放：不新增 attempt、不换租约代数、不改截止时间。
	const replay = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: EID,
	});
	expect(replay.statusCode).toBe(200);
	expect(replay.data).toMatchObject({
		execution_id: EID,
		attempt: first.data!.attempt,
		lease_version: first.data!.lease_version,
		deadline_at: first.data!.deadline_at,
	});
	// 首次响应回的是原始预算；回放时预算由落库时间戳反推，而 created_at 只精确到秒
	// （utcnow 会去掉毫秒），因此允许 ±1 秒。权威值始终是 deadline_at。
	expect(
		Math.abs(replay.data!.deadline_seconds - first.data!.deadline_seconds),
	).toBeLessThanOrEqual(1);
	const rows = server.db
		.prepare("SELECT COUNT(*) AS n FROM executions WHERE project_id = ? AND step_id = ?")
		.get(pid, stepId) as { n: number };
	expect(rows.n).toBe(1);
	// 重放检查必须早于租约校验：响应丢失后的重发可能晚于租约释放甚至步骤结束。
	server.db
		.prepare(
			"UPDATE steps SET status = 'open', worker = NULL, lease_version = lease_version + 1 WHERE id = ?",
		)
		.run(stepId);
	const lateReplay = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: EID,
	});
	expect(lateReplay.statusCode).toBe(200);
	expect(lateReplay.data).toMatchObject({ execution_id: EID, attempt: first.data!.attempt });
	// 同一个 id 指向别的 step 才是真正的冲突。
	const otherStep = await addStep(server.client, pid, { description: "another step" });
	const mismatch = await server.client.createExecution({
		project_id: pid,
		step_id: otherStep,
		execution_id: EID,
	});
	expect(mismatch.statusCode).toBe(409);
});

test("direct conclude atomically cancels queued execution and prevents subsequent claim or creation", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "k",
	});
	const pid = await createProject(server.client);
	const stepId = await addStep(server.client, pid);
	expect((await server.client.claimStep(pid, stepId, EID)).ok).toBe(true);
	expect(
		(await server.client.createExecution({ project_id: pid, step_id: stepId, execution_id: EID }))
			.ok,
	).toBe(true);
	const machinePost = (route: string, body: unknown) =>
		fetch(`${server.url}${route}`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const concluded = await machinePost(`/projects/${pid}/steps/${stepId}/conclude`, {
		worker: EID,
		description: "completed externally",
	});
	expect(concluded.status).toBe(200);
	expect(getExecutionRow(server.db, EID)).toMatchObject({
		status: "cancelled",
		cancel_requested: 1,
	});
	// 同一 execution_id 的重发是幂等回放（不是冲突）：dispatcher 会读到 cancelled。
	expect(
		(
			await server.client.createExecution({
				project_id: pid,
				step_id: stepId,
				execution_id: EID,
			})
		).statusCode,
	).toBe(200);
	// 已结束的步骤不允许再起新的执行尝试。
	expect(
		(
			await server.client.createExecution({
				project_id: pid,
				step_id: stepId,
				execution_id: "10000000-0000-4000-8000-0000000000ff",
			})
		).statusCode,
	).toBe(409);
	// No queued task can be claimed after conclusion.
	const projectWorker = await machinePost(`/internal/project-workers/${pid}/token`, {
		container_name: "cairn-pw-conclude-test",
	});
	expect(projectWorker.status).toBe(201);
	const { token } = (await projectWorker.json()) as { token: string };
	expect(
		(
			await fetch(`${server.url}/internal/project-workers/${pid}/next`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			})
		).status,
	).toBe(204);
	// A legacy queued record with an already-concluded Step must also be unclaimable.
	server.db.prepare("UPDATE executions SET status = 'queued' WHERE id = ?").run(EID);
	expect(
		(
			await fetch(`${server.url}/internal/project-workers/${pid}/next`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			})
		).status,
	).toBe(204);
});

test("direct conclude cancels running execution before it can write evidence or report success", async () => {
	const s = await setup();
	const concluded = await s.machineFetch(`/projects/${s.pid}/steps/${s.stepId}/conclude`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ worker: s.executionId, description: "completed externally" }),
	});
	expect(concluded.status).toBe(200);
	expect(getExecutionRow(s.db, s.executionId)).toMatchObject({
		status: "cancelled",
		cancel_requested: 1,
	});
	expect(
		(await s.authFetch(`/internal/executions/${s.executionId}/heartbeat`, { method: "POST" }))
			.status,
	).toBe(403);
	expect(
		(
			await s.authFetch(`/internal/executions/${s.executionId}/facts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					confidence: "observed",
					description: "late evidence",
					client_event_id: "late-conclude-fact",
				}),
			})
		).status,
	).toBe(403);
	expect(
		(
			await s.authFetch(`/internal/executions/${s.executionId}/result`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					outcome: "succeeded",
					result: {
						schema_version: 1,
						task_status: "satisfied",
						summary: "late",
						unresolved: [],
					},
				}),
			})
		).status,
	).toBe(409);
	expect((await s.client.getExecution(s.executionId)).data?.status).toBe("cancelled");
});

test("worker GET credentials expire at terminal status while machine reads and result ACK remain available", async () => {
	const s = await setup();
	const route = `/internal/executions/${s.executionId}`;
	expect((await s.authFetch(route)).status).toBe(200);
	const reported = await s.authFetch(`${route}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ outcome: "failed", error: "task failed" }),
	});
	expect(reported.status).toBe(200);
	expect((await s.authFetch(route)).status).toBe(403);
	const machineRead = await s.machineFetch(route);
	expect(machineRead.status).toBe(200);
	expect((await machineRead.json()) as { status: string }).toMatchObject({ status: "failed" });
	const repeated = await s.authFetch(`${route}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ outcome: "failed", error: "task failed" }),
	});
	expect(repeated.status).toBe(200);
	expect(await repeated.json()).toMatchObject({ committed: false, status: "failed" });
});

test("queued status transitions reject invalid legacy states and accept cancellation", async () => {
	const s = await setup();
	// starting 状态已退役：不再有“容器已建但未领取”的阶段。
	const res = await s.machineFetch(`/internal/executions/${s.executionId}/status`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "starting" }),
	});
	expect(res.status).toBe(400);
	const cancel = await s.machineFetch(`/internal/executions/${s.executionId}/status`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "cancelled", error: "stopped before claim" }),
	});
	expect(cancel.status).toBe(200);
	const view = (await (await s.machineFetch(`/internal/executions/${s.executionId}`)).json()) as {
		status: string;
	};
	expect(view.status).toBe("cancelled");
});

test("legacy single-execution claim endpoint is removed", async () => {
	const s = await setup();
	const response = await s.machineFetch(`/internal/executions/${s.executionId}/claim`, {
		method: "POST",
	});
	expect(response.status).toBe(404);
});

test("attempt numbers increment per step; executions of different steps are independent", async () => {
	const s = await setup();
	// 第一次尝试：创建时已确定 attempt=1（经 HTTP 视图读取，协议面核对）。
	const view = (await (await s.machineFetch(`/internal/executions/${s.executionId}`)).json()) as {
		attempt: number;
		step_id: string;
	};
	expect(view.attempt).toBe(1);
	expect(view.step_id).toBe(s.stepId);

	// 同一步骤的第二次执行：attempt 递增到 2（终态后释放租约再重试）。
	expect(
		(
			await s.authFetch(`/internal/executions/${s.executionId}/result`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ outcome: "failed", error: "retryable failure" }),
			})
		).status,
	).toBe(200);
	expect((await s.client.releaseStep(s.pid, s.stepId, s.executionId)).ok).toBe(true);
	const eid2 = "10000000-0000-4000-8000-000000000002";
	const retryClaim = await s.machineFetch(`/projects/${s.pid}/steps/${s.stepId}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ worker: eid2 }),
	});
	expect(retryClaim.status).toBe(200);
	const created = await s.machineFetch("/internal/executions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ project_id: s.pid, step_id: s.stepId, execution_id: eid2 }),
	});
	expect(created.status).toBe(201);
	const createdData = (await created.json()) as { attempt: number };
	expect(createdData.attempt).toBe(2);

	// 另一个步骤的首次尝试：attempt 独立从 1 开始，不受其它步骤影响。
	const stepId2 = await addStep(s.client, s.pid, { description: "independent work" });
	const claim2 = await s.machineFetch(`/projects/${s.pid}/steps/${stepId2}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ worker: "20000000-0000-4000-8000-000000000003" }),
	});
	expect(claim2.status).toBe(200);
	const created2 = await s.machineFetch("/internal/executions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			project_id: s.pid,
			step_id: stepId2,
			execution_id: "20000000-0000-4000-8000-000000000003",
		}),
	});
	expect(created2.status).toBe(201);
	expect(((await created2.json()) as { attempt: number }).attempt).toBe(1);
});

test("lease version rejection: re-claiming the step invalidates the old execution's writes", async () => {
	const s = await setup();
	// 让旧租约过期（等价于心跳停止 TTL 后被服务端回收），再用第二个
	// worker 重新认领 —— lease_version 递增，旧执行者的身份随之失效。
	// （直接抢认领会被 409 拒绝：租约仍在有效期内。）
	s.db
		.prepare(
			"UPDATE steps SET worker = 'second-worker', status = 'claimed', lease_version = lease_version + 1, lease_expires_at = ? WHERE id = ? AND project_id = ?",
		)
		.run(new Date(Date.now() + 120_000).toISOString(), s.stepId, s.pid);

	// 旧执行者的心跳被拒（409）
	const hb = await s.authFetch(`/internal/executions/${s.executionId}/heartbeat`, {
		method: "POST",
	});
	expect(hb.status).toBe(409);
	// 旧执行者的事实提交被拒
	const fact = await s.authFetch(`/internal/executions/${s.executionId}/facts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			confidence: "observed",
			description: "stale write",
			client_event_id: "evt-1",
		}),
	});
	expect(fact.status).toBe(409);
	// 旧执行者的结果上报被拒
	const result = await s.authFetch(`/internal/executions/${s.executionId}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			outcome: "succeeded",
			result: {
				schema_version: 1,
				task_status: "satisfied" as const,
				summary: "stale",
				unresolved: [],
			},
		}),
	});
	expect(result.status).toBe(409);
});

test("token is execution-scoped: another execution's endpoints reject it", async () => {
	const s = await setup();
	const otherEid = "20000000-0000-4000-8000-000000000002";
	const res = await s.authFetch(`/internal/executions/${otherEid}/heartbeat`, { method: "POST" });
	expect(res.status).toBe(403);
});

test("Worker facts require explicit confidence and preserve inferred claims", async () => {
	const s = await setup();
	const submit = (body: unknown) =>
		s.authFetch(`/internal/executions/${s.executionId}/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	for (const confidence of [undefined, null, "certain"]) {
		const rejected = await submit({ description: "not directly observed", confidence });
		expect(rejected.status).toBe(400);
		expect(((await rejected.json()) as { detail: string }).detail).toContain("confidence");
	}
	expect(
		s.db
			.prepare("SELECT COUNT(*) AS n FROM facts WHERE project_id=? AND id <> 'origin'")
			.get(s.pid),
	).toEqual({ n: 0 });
	const inferred = await submit({
		description: "  deduced from the response  ",
		confidence: "inferred",
	});
	expect(inferred.status).toBe(201);
	expect(await inferred.json()).toMatchObject({ id: "f001" });
	expect(
		s.db
			.prepare("SELECT confidence, description FROM facts WHERE project_id=? AND id='f001'")
			.get(s.pid),
	).toEqual({
		confidence: "inferred",
		description: "deduced from the response",
	});
});

test("facts are idempotent under retransmission (client_event_id)", async () => {
	const s = await setup();
	const body = JSON.stringify({
		description: "port 8080 closed",
		confidence: "inferred",
		client_event_id: "evt-42",
	});
	const first = await s.authFetch(`/internal/executions/${s.executionId}/facts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
	expect(first.status).toBe(201);
	const firstData = (await first.json()) as { id: string; duplicate: boolean };
	expect(firstData.duplicate).toBe(false);
	const retry = await s.authFetch(`/internal/executions/${s.executionId}/facts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
	expect(retry.status).toBe(200);
	const retryData = (await retry.json()) as { id: string; duplicate: boolean };
	expect(retryData.duplicate).toBe(true);
	expect(retryData.id).toBe(firstData.id);
	// 图里只有一条
	const project = inspectProject(s.db, s.pid);
	expect(project.facts.filter((f) => f.description === "port 8080 closed")).toHaveLength(1);
});

test("fact idempotency keys cannot acknowledge another execution's output", async () => {
	const s = await setup();
	const body = {
		description: "port 8080 closed",
		confidence: "inferred" as const,
		client_event_id: "evt-1",
	};
	const first = await s.authFetch(`/internal/executions/${s.executionId}/facts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(first.status).toBe(201);
	expect(await first.json()).toMatchObject({ id: "f001", duplicate: false });

	const otherId = "10000000-0000-4000-8000-000000000002";
	const otherStep = await addStep(s.client, s.pid, { description: "another inspection" });
	expect((await s.client.claimStep(s.pid, otherStep, otherId)).ok).toBe(true);
	expect(
		(
			await s.client.createExecution({
				project_id: s.pid,
				step_id: otherStep,
				execution_id: otherId,
			})
		).ok,
	).toBe(true);
	const otherBody = {
		...body,
		description: "port 8080 open on another host",
		worker: otherId,
		step_id: otherStep,
		execution_id: otherId,
	};
	const collision = await s.client.createFact(s.pid, otherBody);
	expect(collision.statusCode).toBe(409);
	expect(collision.text).toContain("different fact source");

	// The rejected collision neither burns an ID nor changes the original attribution.
	const retry = await s.client.createFact(s.pid, {
		...otherBody,
		client_event_id: "evt-other-1",
	});
	expect(retry.statusCode).toBe(201);
	expect(retry.data).toMatchObject({ id: "f002" });
	expect(
		s.db
			.prepare(
				"SELECT id, execution_id FROM facts WHERE project_id = ? AND id <> 'origin' ORDER BY id",
			)
			.all(s.pid),
	).toEqual([
		{ id: "f001", execution_id: s.executionId },
		{ id: "f002", execution_id: otherId },
	]);
});

test("events are idempotent: seq replay is ignored, no duplicate lines", async () => {
	const s = await setup();
	const post = (events: Array<{ seq: number; line: string }>) =>
		s.authFetch(`/internal/executions/${s.executionId}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events }),
		});
	const line = JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: 1,
		message: { role: "user", content: "hi" },
	});
	const first = await post([{ seq: 1, line }]);
	expect(first.status).toBe(200);
	expect(((await first.json()) as { session_seq: number }).session_seq).toBe(1);
	// 重传同一批（seq=1）→ 幂等忽略
	const replay = await post([{ seq: 1, line }]);
	expect(((await replay.json()) as { session_seq: number }).session_seq).toBe(1);
	// seq 回退 → 忽略（重发一个更小的合法 seq：seq 是 1 基的，0 属于非法输入）
	const ahead = await post([{ seq: 2, line }]);
	expect(((await ahead.json()) as { session_seq: number }).session_seq).toBe(2);
	const stale = await post([{ seq: 1, line }]);
	expect(((await stale.json()) as { session_seq: number }).session_seq).toBe(2);
});

test("cancel request propagates to the worker heartbeat; late result is rejected but worker token stays scoped", async () => {
	const s = await setup();
	await s.machineFetch(`/internal/executions/${s.executionId}/cancel`, { method: "POST" });
	const hb = (await (
		await s.authFetch(`/internal/executions/${s.executionId}/heartbeat`, { method: "POST" })
	).json()) as { cancel: boolean };
	expect(hb.cancel).toBe(true);
	// Worker 自报 cancelled → 终态持久化
	const result = await s.authFetch(`/internal/executions/${s.executionId}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ outcome: "cancelled", error: "stopped by request" }),
	});
	expect(result.status).toBe(200);
	expect(((await result.json()) as { committed: boolean }).committed).toBe(true);
	// 迟到的重复结果：终态一致 → 幂等确认（不改写）
	const late = await s.authFetch(`/internal/executions/${s.executionId}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ outcome: "cancelled", error: "stopped by request" }),
	});
	expect(late.status).toBe(200);
	expect(((await late.json()) as { committed: boolean }).committed).toBe(false);
	// 迟到的冲突结果：拒绝
	const conflict = await s.authFetch(`/internal/executions/${s.executionId}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			outcome: "succeeded",
			result: {
				schema_version: 1,
				task_status: "satisfied" as const,
				summary: "late",
				unresolved: [],
			},
		}),
	});
	expect(conflict.status).toBe(409);
	// 终态后凭据失效：事实/心跳全部拒绝
	expect(
		(await s.authFetch(`/internal/executions/${s.executionId}/heartbeat`, { method: "POST" }))
			.status,
	).toBe(403);
});

test("terminal execution flushes session transcript readable by the sessions API", async () => {
	const s = await setup();
	// setup 已通过项目 Worker 的 next() 将执行置为 running。
	// 上报一条含 epoch 毫秒时间戳的事件（Worker 事件格式）+ 终态结果。
	const line = JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: 1788693708924,
		message: { role: "user", content: "probe", timestamp: 1788693708924 },
	});
	await s.authFetch(`/internal/executions/${s.executionId}/events`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ events: [{ seq: 1, line }] }),
	});
	const result = await s.authFetch(`/internal/executions/${s.executionId}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			outcome: "succeeded",
			result: {
				schema_version: 1,
				task_status: "satisfied" as const,
				summary: "done",
				unresolved: [],
			},
		}),
	});
	expect(result.status).toBe(200);

	// sessions 列表必须包含终态刷写的文件（文件名含 step id 字母，
	// 回归防护：SESSION_FILE_PATTERN 曾过滤掉 execute-s001-…）。
	const list = (await (await s.machineFetch(`/projects/${s.pid}/activities/page`)).json()) as {
		items: Array<{ session?: { file: string; activity: string; entries: number } }>;
	};
	const exec = list.items.flatMap((x) =>
		x.session && x.session.activity === "execute" ? [x.session] : [],
	);
	expect(exec.length).toBe(1);
	expect(exec[0]!.file).toContain(s.stepId);
	expect(exec[0]!.entries).toBe(1);

	// 事件条目可读且 epoch 毫秒时间戳被归一化为 ISO 字符串：
	// 读取走原始 /messages 接口（旧解析接口已退役）。
	const detail = (await (
		await s.machineFetch(`/projects/${s.pid}/sessions/${exec[0]!.file}/messages`)
	).json()) as { entries: Array<{ record?: { message: { role: string; content: string } } }> };
	const messages = detail.entries.map((e) => e.record?.message).filter(Boolean) as Array<{
		role: string;
		content: string;
	}>;
	expect(messages).toHaveLength(1);
	expect(messages[0]!.role).toBe("user");
	expect(messages[0]!.content).toBe("probe");
}, 20_000);

test("execution results survive a server restart (persisted in SQLite)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-restart-"));
	const model = { api: "openai-completions" as const, base_url: "http://unused", api_key: "k" };
	let server: Awaited<ReturnType<typeof startExecutorTestServer>> | undefined;
	try {
		server = await startExecutorTestServer(model, { dataRoot: dir });
		const pid = await createProject(server.client);
		const stepId = await addStep(server.client, pid);
		expect((await server.client.claimStep(pid, stepId, EID)).ok).toBe(true);
		const created = await server.client.createExecution({
			project_id: pid,
			step_id: stepId,
			execution_id: EID,
		});
		expect(created.ok).toBe(true);
		const claimed = await claimExecutionWithProjectWorker(server, pid, EID);
		const token = claimed.task.token;
		const post = (endpoint: string, body?: unknown) =>
			fetch(`${server!.url}/internal/executions/${EID}/${endpoint}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const line = JSON.stringify({
			type: "message",
			message: { role: "user", content: "before restart" },
		});
		expect((await post("events", { events: [{ seq: 1, line }] })).status).toBe(200);
		const result = {
			outcome: "succeeded",
			result: {
				schema_version: 1,
				task_status: "satisfied",
				summary: "persisted result",
				unresolved: [],
			},
		};
		const committed = await post("result", result);
		expect(committed.status).toBe(200);
		expect(await committed.json()).toMatchObject({ committed: true });
		const before = (await server.client.getExecution(EID)).data!;
		expect(before).toMatchObject({
			status: "succeeded",
			attempt: 1,
			session_seq: 1,
			summary: "persisted result",
			result: result.result,
		});
		expect(before.finished_at).toBeTruthy();
		const oldDb = server.db;
		await server.close();
		expect(oldDb.open).toBe(false);
		server = await startExecutorTestServer(model, { dataRoot: dir });
		expect(server.db).not.toBe(oldDb);
		const after = await server.client.getExecution(EID);
		expect(after.ok).toBe(true);
		expect(after.data).toEqual(before);
		expect(
			server.db.prepare("SELECT seq, line FROM execution_events WHERE execution_id = ?").all(EID),
		).toEqual([{ seq: 1, line }]);
		const replay = await post("result", result);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ committed: false, result: result.result });
	} finally {
		await server?.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("event batches are validated before any row is applied", async () => {
	const s = await setup();
	const row = getExecutionRow(s.db, s.executionId);
	let message = "";
	try {
		appendExecutionEvents(s.db, row, [
			{ seq: 1, line: '{"type":"message"}' },
			{ seq: 2, line: "x".repeat(8_000_001) },
		]);
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	expect(message).toContain("8MB");
	const count = (
		s.db
			.prepare("SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = ?")
			.get(s.executionId) as {
			n: number;
		}
	).n;
	expect(count).toBe(0);
});

test("exhausted failed attempts abandon the step and trigger decide", async () => {
	const s = await setup();
	for (let attempt = 1; attempt <= 3; attempt++) {
		const id = attempt === 1 ? EID : `10000000-0000-4000-8000-00000000000${attempt}`;
		if (attempt > 1) {
			expect((await s.client.claimStep(s.pid, s.stepId, id)).ok).toBe(true);
			const created = await s.client.createExecution({
				project_id: s.pid,
				step_id: s.stepId,
				execution_id: id,
			});
			expect(created.ok).toBe(true);
			expect(created.data?.attempt).toBe(attempt);
		}
		s.db
			.prepare(
				"UPDATE executions SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
			.run(id);
		applyExecutionResult(s.db, getExecutionRow(s.db, id), {
			outcome: "failed",
			error: `failure ${attempt}`,
		});
		if (attempt < 3) {
			const midway = s.db
				.prepare("SELECT status FROM steps WHERE id = ? AND project_id = ?")
				.get(s.stepId, s.pid) as { status: string };
			expect(midway.status).toBe("claimed");
			expect((await s.client.releaseStep(s.pid, s.stepId, id)).ok).toBe(true);
		}
	}
	const exhausted = s.db
		.prepare("SELECT status, summary FROM steps WHERE id = ? AND project_id = ?")
		.get(s.stepId, s.pid) as { status: string; summary: string };
	expect(exhausted.status).toBe("abandoned");
	expect(exhausted.summary).toContain("最大尝试次数");
	const checkpoint = s.db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(s.pid) as { external_signal: string | null };
	expect(checkpoint.external_signal).toBe("step_failed");
});

test("a non-exhausted failed attempt wakes decide without abandoning the step", async () => {
	const s = await setup();
	s.db
		.prepare("UPDATE executions SET status = 'running', attempt = 1 WHERE id = ?")
		.run(s.executionId);
	const row = getExecutionRow(s.db, s.executionId);
	applyExecutionResult(s.db, row, { outcome: "failed", error: "endpoint flaked" });

	// 步骤没有被关闭（未放弃）：仍由本执行持有，交给调度器释放后可重试。
	const step = s.db
		.prepare("SELECT status FROM steps WHERE id = ? AND project_id = ?")
		.get(s.stepId, s.pid) as { status: string };
	expect(step.status).toBe("claimed");
	const checkpoint = s.db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(s.pid) as { external_signal: string | null };
	expect(checkpoint.external_signal).toBe("step_attempt_failed");
});

test.each([
	{
		name: "terminal execution",
		sql: "UPDATE executions SET status = 'cancelled' WHERE id = ?",
		message: "credentials are revoked",
	},
	{
		name: "replaced step lease",
		sql: "UPDATE steps SET lease_version = lease_version + 1 WHERE worker = ?",
		message: "lease version is stale",
	},
	{
		name: "expired execution lease",
		sql: "UPDATE executions SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?",
		message: "lease expired",
	},
])("escalation rechecks a $name after route authentication", async ({ sql, message }) => {
	const s = await setup();
	// Simulate the row captured by requireSelf before awaiting the request body.
	const authenticated = getExecutionRow(s.db, s.executionId);
	const checkpointBefore = s.db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(s.pid);
	s.db.prepare(sql).run(s.executionId);
	expect(() => escalateFromExecution(s.db, authenticated, "too late")).toThrow(message);
	expect(
		s.db
			.prepare(
				"SELECT COUNT(*) AS n FROM decide_changes WHERE project_id = ? AND operation = 'escalate'",
			)
			.get(s.pid),
	).toEqual({ n: 0 });
	expect(
		s.db.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?").get(s.pid),
	).toEqual(checkpointBefore);
});

/**
 * 执行者的升级上报：发现「当前计划的前提已经不成立」时立刻唤醒规划器。
 * 这里覆盖三件容易写错的事——重复理由去重、累计条数上限、以及终态后凭据立即失效。
 */
test("execution escalation wakes the planner, dedupes reasons and caps the count", async () => {
	const s = await setup();
	const signal = (reason: string) =>
		s.authFetch(`/internal/executions/${s.executionId}/signal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason }),
		});
	const reason = "target version does not match the task description";

	expect(await (await signal(reason)).json()).toEqual({
		status: "accepted",
		accepted: true,
		count: 1,
		limit: 3,
	});

	// 同一理由重复上报只记一次：不新增记录，也不重复唤醒。
	const duplicate = await signal(reason);
	expect(duplicate.status).toBe(200);
	expect(await duplicate.json()).toEqual({
		status: "duplicate",
		accepted: false,
		count: 1,
		limit: 3,
	});

	expect((await signal("second, different reason")).status).toBe(201);
	expect((await signal("third, different reason")).status).toBe(201);
	const overLimit = await signal("fourth, different reason");
	expect(overLimit.status).toBe(200);
	expect(await overLimit.json()).toEqual({
		status: "limit_reached",
		accepted: false,
		count: 3,
		limit: 3,
	});
	// A duplicate still has a recorded reason even after all three slots have been used.
	expect(await (await signal(reason)).json()).toEqual({
		status: "duplicate",
		accepted: false,
		count: 3,
		limit: 3,
	});

	// 记录带来源（execution）、归属步骤与结构化前缀，规划页据此渲染理由。
	const rows = s.db
		.prepare(
			"SELECT kind, operation, detail, subject_id, actor FROM decide_changes " +
				"WHERE project_id = ? AND operation = 'escalate' ORDER BY seq",
		)
		.all(s.pid) as any[];
	expect(rows).toHaveLength(3);
	expect(rows[0]).toMatchObject({
		kind: "signal",
		operation: "escalate",
		detail: `escalated:${reason}`,
		subject_id: s.stepId,
		actor: s.executionId,
	});
	// 与外部信号共用触发通道：下一次认领以 external_signal 唤醒规划器。
	const checkpoint = s.db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(s.pid) as { external_signal: string | null };
	// 被上限拒绝的那条连信号都没置：拒绝发生在写库之前。
	expect(checkpoint.external_signal).toBe("escalated:third, different reason");

	// 空理由被拒；终态执行的凭据立即失效，不能再上报。
	expect((await signal("   ")).status).toBe(400);
	const stopped = await s.authFetch(`/internal/executions/${s.executionId}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ outcome: "failed", error: "controller stopped it" }),
	});
	expect(stopped.status, await stopped.text()).toBe(200);
	const afterTerminal = await signal("too late");
	expect(afterTerminal.status).toBe(403);
});
