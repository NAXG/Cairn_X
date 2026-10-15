import { expect, test, vi } from "vitest";
import { HeartbeatLease } from "../../src/shared/heartbeat.js";
import { DispatcherLoop } from "../../src/scheduler/loop.js";
import { containerNameForProject } from "../../src/scheduler/launcher.js";
import { getExecutionRow, heartbeatExecution } from "../../src/server/core/executions.js";
import { expireWorkers } from "../../src/server/core/lease-expiry.js";
import { getStepOr404 } from "../../src/server/core/project-guards.js";
import {
	addStep,
	claimExecutionWithProjectWorker,
	createProject,
	FakeLauncher,
	silentLogger,
	startExecutorTestServer,
	testConfig,
} from "./helpers.js";

const EID = "10000000-0000-4000-8000-000000000001";
const model = { api: "openai-completions" as const, base_url: "http://unused", api_key: "test" };

async function setup() {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const sid = await addStep(server.client, pid);
	expect((await server.client.claimStep(pid, sid, EID)).ok).toBe(true);
	const created = await server.client.createExecution({
		project_id: pid,
		step_id: sid,
		execution_id: EID,
	});
	expect(created.ok).toBe(true);
	const claimed = await claimExecutionWithProjectWorker(server, pid, EID);
	return { ...server, pid, sid, worker: claimed.worker, task: claimed.task };
}

test("a crash between claimStep and createExecution can be reclaimed without accepting the old owner", async () => {
	const s = await startExecutorTestServer(model);
	const pid = await createProject(s.client);
	const sid = await addStep(s.client, pid);
	expect((await s.client.claimStep(pid, sid, EID)).ok).toBe(true);
	const firstLease = getStepOr404(s.db, pid, sid).lease_version;
	s.db
		.prepare(
			"UPDATE steps SET lease_expires_at = '2020-01-01T00:00:00Z' WHERE project_id = ? AND id = ?",
		)
		.run(pid, sid);
	const replacement = "10000000-0000-4000-8000-000000000002";
	expect((await s.client.claimStep(pid, sid, replacement)).ok).toBe(true);
	expect(getStepOr404(s.db, pid, sid).lease_version).toBeGreaterThan(firstLease);
	expect(
		(await s.client.createExecution({ project_id: pid, step_id: sid, execution_id: EID }))
			.statusCode,
	).toBe(409);
	expect(
		(await s.client.createExecution({ project_id: pid, step_id: sid, execution_id: replacement }))
			.ok,
	).toBe(true);
	expect(s.db.prepare("SELECT id FROM executions WHERE project_id = ?").all(pid)).toEqual([
		{ id: replacement },
	]);
});

test("claim task carries step input without duplicate prompt fields", async () => {
	const s = await setup();
	expect(s.task.execution_id).toBe(EID);
	expect(s.task.step_description).toBe("do work");
	expect(s.task).not.toHaveProperty("project_title");
	expect(s.task).not.toHaveProperty("uploads");
	expect(s.task.prompt).toEqual({});
	expect(s.task.source_facts).toEqual([
		expect.objectContaining({ id: "origin", confidence: "observed" }),
	]);
});

test("claim grants a full TTL and a healthy worker survives multiple heartbeat intervals", async () => {
	const s = await setup();
	expect(s.task.heartbeat_interval_s).toBe(10);
	expect(s.task.lease_timeout_s).toBe(120);
	const heartbeat = vi.spyOn(s.worker, "heartbeat").mockResolvedValue({
		ok: true,
		statusCode: 200,
		text: "",
		data: {
			lease_timeout_s: 120,
			heartbeat_interval_s: 10,
			cancel: false,
			deadline_at: s.task.deadline_at,
		},
	});
	const failure = vi.fn();
	const lease = HeartbeatLease.forExecution(s.worker, EID, s.task.heartbeat_interval_s, {
		leaseTimeoutSeconds: s.task.lease_timeout_s,
		onFailure: failure,
	});
	vi.useFakeTimers();
	try {
		lease.start();
		await vi.advanceTimersByTimeAsync(65_000);
		expect(heartbeat).toHaveBeenCalledTimes(6);
		expect(failure).not.toHaveBeenCalled();
	} finally {
		lease.stop();
		vi.useRealTimers();
		heartbeat.mockRestore();
	}
	expect((await s.worker.heartbeat()).data?.lease_timeout_s).toBe(120);
});

test("heartbeat interval is decoupled from the lease TTL", async () => {
	// TTL 拉大到 120s 时，心跳间隔必须保持短周期（10s）；否则续租频率与
	// 取消感知延迟会随 TTL 一起劣化。
	const s = await setup();
	s.db.prepare("UPDATE settings SET lease_timeout = 120 WHERE rowid = 1").run();
	const beat = await s.worker.heartbeat();
	expect(beat.ok).toBe(true);
	expect(beat.data?.lease_timeout_s).toBe(120);
	expect(beat.data?.heartbeat_interval_s).toBe(10);
});

test("explicit server heartbeat interval overrides lease TTL / 3", async () => {
	const s = await setup();
	const heartbeat = vi.spyOn(s.worker, "heartbeat").mockResolvedValue({
		ok: true,
		statusCode: 200,
		text: "",
		data: {
			lease_timeout_s: 120,
			heartbeat_interval_s: 10,
			cancel: false,
			deadline_at: s.task.deadline_at,
		},
	});
	const failure = vi.fn();
	const lease = HeartbeatLease.forExecution(s.worker, EID, s.task.heartbeat_interval_s, {
		leaseTimeoutSeconds: 120,
		onFailure: failure,
	});
	vi.useFakeTimers();
	try {
		lease.start();
		await vi.advanceTimersByTimeAsync(65_000);
		// 若按 TTL/3=40s 续租，65 秒内只会有 1-2 次；解耦后应为 6 次。
		expect(heartbeat).toHaveBeenCalledTimes(6);
		expect(failure).not.toHaveBeenCalled();
	} finally {
		lease.stop();
		vi.useRealTimers();
		heartbeat.mockRestore();
	}
});

test("heartbeats renew both leases past the original Step deadline", async () => {
	const s = await setup();
	const original = getStepOr404(s.db, s.pid, s.sid).lease_expires_at!;
	const start = Date.now();
	vi.useFakeTimers();
	try {
		for (let elapsed = 10_000; elapsed <= 60_000; elapsed += 10_000) {
			vi.setSystemTime(start + elapsed);
			heartbeatExecution(s.db, getExecutionRow(s.db, EID));
			expireWorkers(s.db);
			const step = getStepOr404(s.db, s.pid, s.sid);
			expect(step.status).toBe("claimed");
			expect(step.worker).toBe(EID);
			expect(Date.parse(step.lease_expires_at!)).toBeGreaterThan(Date.parse(original));
			expect(step.lease_expires_at).toBe(getExecutionRow(s.db, EID).lease_expires_at);
		}
	} finally {
		vi.useRealTimers();
	}
});

test("an expired Step cannot be revived by heartbeat and is closed instead of retried", async () => {
	const s = await setup();
	s.db
		.prepare(
			"UPDATE steps SET lease_expires_at = '2020-01-01T00:00:00Z' WHERE project_id = ? AND id = ?",
		)
		.run(s.pid, s.sid);
	expect((await s.worker.heartbeat()).statusCode).toBe(409);
	await s.client.listSchedulingProjects();
	expect(getStepOr404(s.db, s.pid, s.sid).status).toBe("abandoned");
	expect(getExecutionRow(s.db, EID).status).toBe("lost");
	expect((await s.client.claimStep(s.pid, s.sid, "replacement")).statusCode).toBe(409);
});

test("a running execution cannot report results or events after its Step is reassigned", async () => {
	const s = await setup();
	expect((await s.client.releaseStep(s.pid, s.sid, EID)).ok).toBe(true);
	expect((await s.client.claimStep(s.pid, s.sid, "replacement")).ok).toBe(true);
	expect(
		(
			await s.worker.reportResult({
				outcome: "succeeded",
				result: {
					schema_version: 1,
					task_status: "satisfied" as const,
					summary: "stale",
					unresolved: [],
				},
			})
		).statusCode,
	).toBe(409);
	expect((await s.worker.sendEvents([{ seq: 1, line: "stale" }])).statusCode).toBe(409);
	expect((await s.worker.heartbeat()).statusCode).toBe(409);
	expect(getExecutionRow(s.db, EID).status).toBe("running");
});

test("expired execution results are rejected and retries stay idempotent", async () => {
	const s = await setup();
	const expires = getExecutionRow(s.db, EID).lease_expires_at;
	s.db
		.prepare("UPDATE executions SET lease_expires_at = '2020-01-01T00:00:00Z' WHERE id = ?")
		.run(EID);
	expect(
		(
			await s.worker.reportResult({
				outcome: "succeeded",
				result: {
					schema_version: 1,
					task_status: "satisfied" as const,
					summary: "expired",
					unresolved: [],
				},
			})
		).statusCode,
	).toBe(409);
	s.db.prepare("UPDATE executions SET lease_expires_at = ? WHERE id = ?").run(expires, EID);
	const result = {
		outcome: "succeeded" as const,
		result: {
			schema_version: 1 as const,
			task_status: "satisfied" as const,
			summary: "done",
			unresolved: [] as string[],
		},
	};
	expect((await s.worker.reportResult(result)).data).toMatchObject({
		committed: true,
		status: "succeeded",
	});
	expect((await s.worker.reportResult(result)).data).toMatchObject({
		committed: false,
		status: "succeeded",
	});
});

test.each(["succeeded", "failed", "cancelled", "lost"] as const)(
	"%s execution token is revoked for every Worker write",
	async (status) => {
		const s = await setup();
		if (status === "lost") await s.client.setExecutionStatus(EID, { status });
		else {
			const body =
				status === "succeeded"
					? {
							outcome: status,
							result: {
								schema_version: 1 as const,
								task_status: "satisfied" as const,
								summary: "done",
								unresolved: [],
							},
						}
					: { outcome: status, error: "done" };
			expect((await s.worker.reportResult(body)).ok).toBe(true);
		}
		expect((await s.worker.searchEvents({ q: "x" })).statusCode).toBe(403);
		expect(
			(
				await s.worker.submitFact({
					confidence: "observed",
					description: "written after the execution reached a terminal status",
					client_event_id: "evt-after-terminal",
				})
			).statusCode,
		).toBe(403);
	},
);

test("Worker findings use the same JSON Schema validation as public findings", async () => {
	const s = await setup();
	s.db.prepare("UPDATE projects SET finding_schema = ? WHERE id = ?").run(
		JSON.stringify({
			type: "object",
			required: ["severity"],
			properties: { severity: { type: "string" } },
		}),
		s.pid,
	);
	const body = {
		title: "finding",
		description: "description",
		data: { severity: 123 },
		client_event_id: "finding-1",
	};
	const external = await fetch(`${s.url}/projects/${s.pid}/findings`, {
		method: "POST",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
		body: JSON.stringify({ ...body, actor: "human" }),
	});
	expect(external.status).toBe(400);
	expect((await s.worker.submitFinding(body)).statusCode).toBe(400);
	const valid = { ...body, data: { severity: "high" } };
	expect((await s.worker.submitFinding(valid)).statusCode).toBe(201);
	expect((await s.worker.submitFinding(valid)).data?.duplicate).toBe(true);
});

test("lost executions are not dispatched again, including after dispatcher restart", async () => {
	const s = await startExecutorTestServer(model);
	const pid = await createProject(s.client);
	const sid = await addStep(s.client, pid);
	let runs = 0;
	const options = {
		client: s.client,
		config: testConfig(s.url, { runtime: { max_workers: 1 } }),
		launcher: new FakeLauncher(),
		logger: silentLogger,
		runners: {
			decide: async () => "success" as const,
			execute: async (ctx: import("../../src/scheduler/types.js").ExecuteContext) => {
				runs++;
				await s.client.createExecution({
					project_id: pid,
					step_id: ctx.stepId,
					execution_id: ctx.worker,
				});
				await s.client.setExecutionStatus(ctx.worker, {
					status: "lost",
					error: "worker lost after side effect",
				});
				return "failed" as const;
			},
		},
	};
	const loop = new DispatcherLoop(options);
	try {
		await loop.tick();
		await loop.whenIdle();
		expect(runs).toBe(1);
		await loop.tick();
		await loop.whenIdle();
		expect(runs).toBe(1);
		const lostStep = getStepOr404(s.db, pid, sid);
		expect(lostStep.status).toBe("abandoned");
		// 说明必须是运维能读懂的（与其它自动取消原因一致的中文文案），
		// 且明确"结果未知、副作用可能已发生"这一关键语义。
		expect(lostStep.summary).toContain("执行失联，结果未知");
		expect(lostStep.summary).toContain("副作用可能已经发生");
	} finally {
		await loop.close();
	}
	const restarted = new DispatcherLoop(options);
	try {
		await restarted.tick();
		await restarted.whenIdle();
		expect(runs).toBe(1);
	} finally {
		await restarted.close();
	}
});

test("deadline reaper closes the Step as well as the execution", async () => {
	const s = await setup();
	s.db.prepare("UPDATE executions SET deadline_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(EID);
	expect((await s.client.reapExecutions()).data?.reaped).toBe(1);
	expect(getStepOr404(s.db, s.pid, s.sid).status).toBe("abandoned");
	const checkpoint = s.db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(s.pid) as { external_signal: string | null } | undefined;
	expect(checkpoint?.external_signal).toBe("execution_lost");
	expect((await s.client.reapExecutions()).data?.reaped).toBe(0);
});

test("a second dispatcher preserves live project containers but removes confirmed orphans", async () => {
	const s = await setup();
	const launcher = new FakeLauncher();
	const live = containerNameForProject(s.pid);
	launcher.states.set(live, "running");
	launcher.states.set("cairn-pw-orphan", "exited");
	const loop = new DispatcherLoop({
		client: s.client,
		config: testConfig(s.url),
		launcher,
		logger: silentLogger,
		runners: { decide: async () => "success", execute: async () => "success" },
	});
	try {
		await loop.tick();
		expect(launcher.removed).toEqual(["cairn-pw-orphan"]);
		expect(launcher.states.get(live)).toBe("running");
		// 活跃项目（有在途 step）的容器多轮对账后仍保留；新的无主容器被回收。
		launcher.states.set("cairn-pw-orphan2", "running");
		await loop.tick();
		expect(launcher.removed).toEqual(["cairn-pw-orphan", "cairn-pw-orphan2"]);
		expect(launcher.states.get(live)).toBe("running");
	} finally {
		await loop.close();
	}
});

test("a queued execution whose Step lease expires fails without consuming the attempt budget", async () => {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const sid = await addStep(server.client, pid);
	expect((await server.client.claimStep(pid, sid, EID)).ok).toBe(true);
	expect(
		(await server.client.createExecution({ project_id: pid, step_id: sid, execution_id: EID })).ok,
	).toBe(true);
	// Worker 没来得及领取，Step 租约先过期。
	server.db
		.prepare(
			"UPDATE steps SET lease_expires_at = '2020-01-01T00:00:00Z' WHERE project_id = ? AND id = ?",
		)
		.run(pid, sid);
	expireWorkers(server.db, pid);

	const execution = getExecutionRow(server.db, EID);
	expect(execution.status).toBe("failed");
	expect(execution.started_at).toBeNull();
	expect(getStepOr404(server.db, pid, sid).status).toBe("open");
	// Step 可以立即重新派发。
	expect((await server.client.claimStep(pid, sid, "20000000-0000-4000-8000-000000000002")).ok).toBe(
		true,
	);
});
