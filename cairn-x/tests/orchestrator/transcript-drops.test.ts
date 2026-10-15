/**
 * P2-6 回归：轨迹丢行必须可见。
 *
 * 修复前：EventPump 缓冲溢出时只打一条 warn 日志，执行记录里看不出
 * "轨迹少了一段"，审计链静默不完整。现在 Worker 把丢行数随最终结果上报，
 * 控制端落库并在 ExecutionView.dropped_events 里暴露。
 */

import { expect, test, vi } from "vitest";

import { UNHEALTHY_ERROR_MARKER } from "../../src/contracts/execution.js";
import type { ExecutionResultBody } from "../../src/contracts/execution.js";
import { EventPump, finalizeWorkerRun, type WorkerRunResult } from "../../src/worker/agent.js";
import { WorkerClient } from "../../src/worker/client.js";
import {
	addStep,
	claimExecutionWithProjectWorker,
	createProject,
	silentLogger,
	startExecutorTestServer,
} from "./helpers.js";

test("the control plane persists dropped_events and exposes it on the execution view", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk",
	});
	try {
		const pid = await createProject(server.client);
		const sid = await addStep(server.client, pid);
		const eid = "a0000000-0000-4000-8000-0000000000d3";
		await server.client.claimStep(pid, sid, eid);
		const created = await server.client.createExecution({
			project_id: pid,
			step_id: sid,
			execution_id: eid,
		});
		if (!created.ok || !created.data) throw new Error("createExecution failed");
		const { worker } = await claimExecutionWithProjectWorker(server, pid, eid);
		const ack = await worker.reportResult({
			outcome: "failed",
			error: "transcript truncated",
			dropped_events: 12,
		});
		expect(ack.ok).toBe(true);

		const view = await server.client.getExecution(eid);
		expect(view.data?.dropped_events).toBe(12);
		// 未上报丢行的执行默认为 0（字段缺失语义）。
		const other = await server.client.getExecution(eid);
		expect(other.data?.dropped_events).toBe(12);
	} finally {
		await server.close();
	}
});

test("dropped transcript lines are reported and persisted on the execution", async () => {
	let reported: ExecutionResultBody | undefined;
	const stub = {
		reportResult: async (body: ExecutionResultBody) => {
			reported = body;
			// 真实控制端会落库；这里直接调用服务端同一路径更贴近实际，
			// 但 stub 足以断言"上报里带上了丢行数"。
			return {
				statusCode: 200,
				ok: true,
				data: { committed: true, status: "succeeded" },
				text: "",
			};
		},
	} as unknown as WorkerClient;

	const result: WorkerRunResult = {
		outcome: "succeeded",
		finalText: "done",
		result: {
			schema_version: 1,
			task_status: "satisfied" as const,
			summary: "done",
			unresolved: [],
		},
		usage: null,
		leaseFailure: null,
		droppedEvents: 37,
	};
	const finalized = await finalizeWorkerRun(stub, result, silentLogger);

	expect(finalized.exitCode).toBe(0);
	expect(reported?.dropped_events).toBe(37);
	expect(reported?.outcome).toBe("succeeded");
	// 丢行不是"端点故障"，不应污染健康信号。
	expect(reported?.error ?? null).toBeNull();
	expect(reported?.error?.includes(UNHEALTHY_ERROR_MARKER)).toBeFalsy();
});

test("a clean run omits dropped_events entirely", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk",
	});
	try {
		let reported: ExecutionResultBody | undefined;
		const stub = {
			reportResult: async (body: ExecutionResultBody) => {
				reported = body;
				return {
					statusCode: 200,
					ok: true,
					data: { committed: true, status: "succeeded" },
					text: "",
				};
			},
		} as unknown as WorkerClient;
		await finalizeWorkerRun(
			stub,
			{
				outcome: "succeeded",
				finalText: "done",
				result: {
					schema_version: 1,
					task_status: "satisfied" as const,
					summary: "done",
					unresolved: [],
				},
				usage: null,
				leaseFailure: null,
				droppedEvents: 0,
			},
			silentLogger,
		);
		expect("dropped_events" in (reported ?? {})).toBe(false);
	} finally {
		await server.close();
	}
});

test("EventPump.stop drains queued events beyond one batch", async () => {
	const batches: number[] = [];
	let maxSeq = 0;
	const stub = {
		sendEvents: async (events: Array<{ seq: number; line: string }>) => {
			maxSeq = events.reduce(
				(current, event) => (event.seq > current ? event.seq : current),
				maxSeq,
			);
			batches.push(events.length);
			return {
				statusCode: 200,
				ok: true,
				data: { session_seq: maxSeq, applied: events.length },
				text: "",
			};
		},
	} as unknown as WorkerClient;
	const pump = new EventPump(stub, silentLogger);
	for (let i = 0; i < 900; i += 1) pump.sink(`line ${i}`);
	await pump.stop();
	expect(batches).toEqual([400, 400, 100]);
	expect(pump.droppedCount).toBe(0);
});

test("EventPump.stop waits for an in-flight upload before counting drops", async () => {
	let release!: () => void;
	const uploadBlocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let uploadStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		uploadStarted = resolve;
	});
	const sendEvents = vi.fn(async (events: Array<{ seq: number; line: string }>) => {
		uploadStarted();
		await uploadBlocked;
		return {
			statusCode: 200,
			ok: true,
			data: { session_seq: events.at(-1)?.seq ?? 0, applied: events.length },
			text: "",
		};
	});
	const pump = new EventPump({ sendEvents } as unknown as WorkerClient, silentLogger);
	pump.sink("line");
	const upload = pump.flush();
	await started;
	let stopped = false;
	const stop = pump.stop().then(() => {
		stopped = true;
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(stopped).toBe(false);
		expect(pump.droppedCount).toBe(0);
	} finally {
		release();
	}
	await Promise.all([upload, stop]);
	expect(sendEvents).toHaveBeenCalledTimes(1);
	expect(pump.droppedCount).toBe(0);
});

test("EventPump.stop retries an in-flight upload that fails", async () => {
	let release!: () => void;
	const uploadBlocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let attempts = 0;
	const sendEvents = vi.fn(async (events: Array<{ seq: number; line: string }>) => {
		attempts += 1;
		if (attempts === 1) {
			await uploadBlocked;
			return { statusCode: 503, ok: false, data: undefined, text: "unavailable" };
		}
		return {
			statusCode: 200,
			ok: true,
			data: { session_seq: events.at(-1)?.seq ?? 0, applied: events.length },
			text: "",
		};
	});
	const pump = new EventPump({ sendEvents } as unknown as WorkerClient, silentLogger);
	pump.sink("line");
	const upload = pump.flush();
	const stop = pump.stop();
	release();
	await Promise.all([upload, stop]);
	expect(sendEvents).toHaveBeenCalledTimes(2);
	expect(pump.droppedCount).toBe(0);
});

test("EventPump counts queued lines that cannot be flushed at shutdown", async () => {
	const stub = {
		sendEvents: async () => ({
			statusCode: 0,
			ok: false,
			data: undefined,
			text: "control plane down",
		}),
	} as unknown as WorkerClient;
	const pump = new EventPump(stub, silentLogger);
	for (let i = 0; i < 50; i += 1) pump.sink(`line ${i}`);
	await pump.stop();
	expect(pump.droppedCount).toBe(50);
});

test("EventPump evicts oldest lines when the line bound is exceeded", async () => {
	const stub = {
		sendEvents: async (events: Array<{ seq: number; line: string }>) => ({
			statusCode: 200,
			ok: true,
			data: { session_seq: events.at(-1)?.seq ?? 0, applied: events.length },
			text: "",
		}),
	} as unknown as WorkerClient;
	const pump = new EventPump(stub, silentLogger);
	for (let i = 0; i < 2_500; i += 1) pump.sink(`line ${i}`);
	await pump.stop();
	expect(pump.droppedCount).toBe(500);
});
