/**
 * Worker 协议的证据引用：Fact/Finding 引用的必须是同项目、已持久化的
 * execution 事件，身份由服务端从 execution 解析。
 */

import { expect, test } from "vitest";

import {
	claimExecutionWithProjectWorker,
	createProject,
	addStep,
	startExecutorTestServer,
} from "./helpers.js";

const EID = "10000000-0000-4000-8000-0000000000e1";

async function setup() {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk-long-term",
	});
	const pid = await createProject(server.client);
	const stepId = await addStep(server.client, pid);
	await server.client.claimStep(pid, stepId, EID);
	const created = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: EID,
	});
	if (!created.ok || !created.data)
		throw new Error(`createExecution failed: ${created.statusCode}`);
	const claimed = await claimExecutionWithProjectWorker(server, pid, EID);
	const token = claimed.task.token;
	const worker = (path: string, init?: RequestInit) =>
		fetch(`${server.url}${path}`, {
			...init,
			headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
		});
	return { server, pid, stepId, token, worker };
}

test("worker facts accept event evidence; unpersisted or foreign refs rejected", async () => {
	const { server, pid, worker } = await setup();
	try {
		const events = await worker(`/internal/executions/${EID}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events: [{ seq: 3, line: '{"type":"message"}' }] }),
		});
		expect(events.status).toBe(200);

		const submit = await worker(`/internal/executions/${EID}/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				confidence: "observed",
				description: "tool output confirmed",
				evidence: [{ kind: "event", execution_id: EID, seq: 3 }],
			}),
		});
		expect(submit.status).toBe(201);
		const fact = (await submit.json()) as { id: string };
		const node = (await (
			await fetch(`${server.url}/projects/${pid}/records/fact/${fact.id}`, {
				headers: { Authorization: "Bearer test-token" },
			})
		).json()) as { record: { evidence_refs: unknown[] } };
		expect(node.record.evidence_refs).toEqual([{ kind: "event", execution_id: EID, seq: 3 }]);

		// 未落盘 seq（超出已持久化游标）拒绝。
		const stale = await worker(`/internal/executions/${EID}/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				confidence: "observed",
				description: "future event",
				evidence: [{ kind: "event", execution_id: EID, seq: 999 }],
			}),
		});
		expect(stale.status).toBe(404);

		// 其他项目的事件不可引用。
		const pid2 = await createProject(server.client);
		server.db
			.prepare(
				"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('foreign-exec', ?, 's001', 1, 1, 'running', '2026-01-01')",
			)
			.run(pid2);
		server.db
			.prepare(
				"INSERT INTO execution_events (execution_id, seq, line) VALUES ('foreign-exec', 1, '{}')",
			)
			.run();
		const cross = await worker(`/internal/executions/${EID}/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				confidence: "observed",
				description: "cross project",
				evidence: [{ kind: "event", execution_id: "foreign-exec", seq: 1 }],
			}),
		});
		expect(cross.status).toBe(404);
	} finally {
		await server.close();
	}
});

test("worker findings carry evidence and can prove goals through the typed graph", async () => {
	const { server, pid, worker } = await setup();
	try {
		await worker(`/internal/executions/${EID}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events: [{ seq: 5, line: '{"type":"message"}' }] }),
		});
		const finding = await worker(`/internal/executions/${EID}/findings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "confirmed",
				description: "result",
				client_event_id: "evt-finding-1",
				evidence: [{ kind: "event", execution_id: EID, seq: 5 }],
			}),
		});
		expect(finding.status).toBe(201);
		const findingId = ((await finding.json()) as { id: string }).id;

		// 幂等重传不改变证据。
		const retry = await worker(`/internal/executions/${EID}/findings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "confirmed",
				description: "result",
				client_event_id: "evt-finding-1",
				evidence: [],
			}),
		});
		expect(retry.status).toBe(200);
		expect(((await retry.json()) as { duplicate: boolean }).duplicate).toBe(true);

		const achieved = await fetch(`${server.url}/projects/${pid}/goals/goal/achieve`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({
				actor: "human",
				from: [{ type: "finding", id: findingId }],
				description: "finding proves goal",
			}),
		});
		expect(achieved.status).toBe(200);
		const evidence = (await (
			await fetch(`${server.url}/projects/${pid}/goals/goal/evidence`, {
				headers: { Authorization: "Bearer test-token" },
			})
		).json()) as { evidence: Array<{ id: string }>; lineage: { nodes: Array<{ id: string }> } };
		expect(evidence.evidence.map((n: { id: string }) => n.id)).toEqual([`finding:${findingId}`]);
		expect(evidence.lineage.nodes.map((n: { id: string }) => n.id)).toContain(`execution:${EID}`);
	} finally {
		await server.close();
	}
});
