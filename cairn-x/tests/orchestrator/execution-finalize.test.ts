import { inspectClientProject } from "../support/project-state.js";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { finalizeWorkerRun } from "../../src/worker/agent.js";
import {
	addStep,
	claimExecutionWithProjectWorker,
	createProject,
	readAllPlanningGraph,
	silentLogger,
	startExecutorTestServer,
} from "./helpers.js";

const usage = {
	model: "test",
	input_tokens: 12,
	output_tokens: 7,
	cache_read_tokens: 2,
	cache_write_tokens: 0,
};

async function fixture() {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "test",
	});
	const pid = await createProject(server.client);
	const sid = await addStep(server.client, pid);
	const eid = randomUUID();
	expect((await server.client.claimStep(pid, sid, eid)).ok).toBe(true);
	const created = await server.client.createExecution({
		project_id: pid,
		step_id: sid,
		execution_id: eid,
	});
	expect(created.ok).toBe(true);
	const claimed = await claimExecutionWithProjectWorker(server, pid, eid);
	const worker = claimed.worker;
	const state = () => ({
		step: server.db
			.prepare("SELECT status, summary FROM steps WHERE project_id=? AND id=?")
			.get(pid, sid),
		execution: server.db.prepare("SELECT status, summary FROM executions WHERE id=?").get(eid),
		usage: server.db
			.prepare("SELECT input_tokens, output_tokens FROM usage_events WHERE execution_id=?")
			.all(eid),
	});
	return { ...server, pid, sid, eid, worker, state };
}

test("one result request commits the step, usage and execution; retries do not overwrite or duplicate", async () => {
	const f = await fixture();
	const body = {
		outcome: "succeeded" as const,
		result: {
			schema_version: 1 as const,
			task_status: "satisfied" as const,
			summary: "done",
			unresolved: [] as string[],
		},
		usage,
	};
	expect((await f.worker.reportResult(body)).data).toMatchObject({
		committed: true,
		status: "succeeded",
	});
	expect(f.state()).toEqual({
		step: { status: "concluded", summary: "done" },
		execution: { status: "succeeded", summary: "done" },
		usage: [{ input_tokens: 12, output_tokens: 7 }],
	});
	expect(
		(
			await f.worker.reportResult({
				...body,
				result: { ...body.result, summary: "changed" },
				usage: { ...usage, input_tokens: 999 },
			})
		).data,
	).toMatchObject({ committed: false, status: "succeeded" });
	expect(f.state().usage).toEqual([{ input_tokens: 12, output_tokens: 7 }]);
	expect(f.state().step).toEqual({ status: "concluded", summary: "done" });
	expect((await f.worker.reportResult({ ...body, outcome: "failed" })).statusCode).toBe(409);
});

test("structured result atomically groups every product created by the execution", async () => {
	const f = await fixture();
	const fact = await f.worker.submitFact({
		description: "unauthenticated response exposed users",
		confidence: "observed",
		client_event_id: randomUUID(),
	});
	expect(fact.ok).toBe(true);
	const finding = await f.worker.submitFinding({
		title: "Unauthenticated user listing",
		description: "The endpoint returned user records without a session.",
		fact_ids: [fact.data!.id],
		client_event_id: randomUUID(),
	});
	expect(finding.ok).toBe(true);

	const result = {
		schema_version: 1 as const,
		task_status: "satisfied" as const,
		summary: "Confirmed unauthenticated user listing",
		unresolved: ["Individual user detail was not tested"],
	};
	const ack = await f.worker.reportResult({ outcome: "succeeded", result, usage });
	expect(ack.ok).toBe(true);
	expect(ack.data?.result).toEqual({
		...result,
		produced: {
			fact_ids: [fact.data!.id],
			finding_ids: [finding.data!.id],
		},
	});
	const project = await inspectClientProject(f.client, f.pid);
	expect(project.steps.find((step) => step.id === f.sid)?.result).toEqual(ack.data?.result);
	const view = await f.client.getExecution(f.eid);
	expect(view.data?.result).toEqual(ack.data?.result);
	expect(project.steps.find((step) => step.id === f.sid)?.result?.produced).toEqual({
		fact_ids: [fact.data!.id],
		finding_ids: [finding.data!.id],
	});
	// 服务端保存的是一份结果清单，不会再复制 Fact/Finding 的正文。
	expect(
		f.db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE execution_id = ?").get(f.eid),
	).toEqual({ n: 1 });
});

test("a structured result with unresolved items concludes the step and leaves replanning to Decide", async () => {
	const f = await fixture();
	const ack = await f.worker.reportResult({
		outcome: "succeeded",
		result: {
			schema_version: 1,
			task_status: "satisfied" as const,
			summary: "The endpoint requires credentials that were not provided",
			unresolved: ["A valid administrator credential is still required"],
		},
	});
	expect(ack.ok).toBe(true);
	expect(f.state().step).toEqual({
		status: "concluded",
		summary: "The endpoint requires credentials that were not provided",
	});
	const project = await inspectClientProject(f.client, f.pid);
	expect(project.steps.find((step) => step.id === f.sid)?.result?.unresolved).toEqual([
		"A valid administrator credential is still required",
	]);
});

test.each(["satisfied", "inconclusive", "blocked"] as const)(
	"task_status %s survives commit, reads and retries independently of execution success",
	async (task_status) => {
		const f = await fixture();
		const result = {
			schema_version: 1 as const,
			task_status,
			summary: "scoped result",
			unresolved: [],
		};
		const ack = await f.worker.reportResult({ outcome: "succeeded", result });
		expect(ack.ok).toBe(true);
		expect(ack.data).toMatchObject({ committed: true, status: "succeeded", result });
		expect(f.state().step).toEqual({ status: "concluded", summary: "scoped result" });
		expect((await f.client.getExecution(f.eid)).data?.result?.task_status).toBe(task_status);
		expect(
			(await inspectClientProject(f.client, f.pid)).steps.find((s) => s.id === f.sid)?.result
				?.task_status,
		).toBe(task_status);
		const retry = await f.worker.reportResult({
			outcome: "succeeded",
			result: { ...result, task_status: task_status === "satisfied" ? "blocked" : "satisfied" },
		});
		expect(retry.data).toMatchObject({ committed: false, result });
	},
);

test("unknown task_status is rejected without committing a result", async () => {
	const f = await fixture();
	const ack = await f.worker.reportResult({
		outcome: "succeeded",
		result: {
			schema_version: 1,
			// @ts-expect-error exercise runtime validation of untrusted input
			task_status: "done",
			summary: "done",
			unresolved: [],
		},
	});
	expect(ack.statusCode).toBe(400);
	expect(f.state().execution).toEqual({ status: "running", summary: null });
	expect((await f.client.getExecution(f.eid)).data?.result).toBeNull();
});

test("a failed final write rolls back step, usage and finding-gap signals together", async () => {
	const f = await fixture();
	for (let i = 0; i < 3; i++)
		expect(
			(
				await f.worker.submitFact({
					confidence: "observed",
					description: `fact ${i}`,
					client_event_id: randomUUID(),
				})
			).ok,
		).toBe(true);
	f.db.exec(`CREATE TRIGGER reject_final_result BEFORE UPDATE OF status ON executions
		WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'test final write failure'); END;`);
	const body = {
		outcome: "succeeded" as const,
		result: {
			schema_version: 1 as const,
			task_status: "satisfied" as const,
			summary: "done",
			unresolved: [] as string[],
		},
		usage,
	};
	expect((await f.worker.reportResult(body)).statusCode).toBe(500);
	expect(f.state()).toEqual({
		step: { status: "claimed", summary: null },
		execution: { status: "running", summary: null },
		usage: [],
	});
	expect(
		f.db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE execution_id = ?").get(f.eid),
	).toEqual({ n: 0 });
	expect(
		f.db
			.prepare(
				"SELECT COUNT(*) AS n FROM decide_changes WHERE project_id=? AND detail LIKE 'finding_gap:%'",
			)
			.get(f.pid),
	).toEqual({ n: 0 });
	f.db.exec("DROP TRIGGER reject_final_result");
	expect((await f.worker.reportResult(body)).ok).toBe(true);
	expect(
		f.db
			.prepare(
				"SELECT COUNT(*) AS n FROM decide_changes WHERE project_id=? AND detail LIKE 'finding_gap:%'",
			)
			.get(f.pid),
	).toEqual({ n: 1 });
});

test.each(["cancel-first", "result-first"] as const)(
	"cancel/result race preserves the first committed terminal state (%s)",
	async (order) => {
		const f = await fixture();
		const result = {
			schema_version: 1 as const,
			task_status: "satisfied" as const,
			summary: "done",
			unresolved: [],
		};
		const cancel = () => f.client.abandonStep(f.pid, f.sid, f.eid, "cancelled by controller");
		const submit = () => f.worker.reportResult({ outcome: "succeeded", result, usage });
		if (order === "cancel-first") {
			expect((await cancel()).ok).toBe(true);
			expect((await submit()).statusCode).toBe(409);
			expect(f.state().step).toEqual({ status: "abandoned", summary: "cancelled by controller" });
			expect(f.state().execution).toMatchObject({ status: "cancelled" });
			expect((await f.client.getExecution(f.eid)).data?.result).toBeNull();
		} else {
			expect((await submit()).ok).toBe(true);
			expect((await cancel()).statusCode).toBe(409);
			expect((await submit()).data?.committed).toBe(false);
			expect(f.state().step).toEqual({ status: "concluded", summary: "done" });
			expect(f.state().execution).toMatchObject({ status: "succeeded" });
			expect(f.state().usage).toHaveLength(1);
		}
	},
);

test("blocked delivery holds downstream work for Decide to cancel instead of treating it as business success", async () => {
	const f = await fixture();
	const downstream = await f.client.createStep(f.pid, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "use credentials from upstream",
		waiting_on: [f.sid],
	});
	expect(downstream.ok).toBe(true);
	expect(
		(
			await f.worker.reportResult({
				outcome: "succeeded",
				result: {
					schema_version: 1,
					task_status: "blocked",
					summary: "No credential was obtained",
					unresolved: ["A valid credential is required"],
				},
			})
		).ok,
	).toBe(true);
	expect((await f.client.claimStep(f.pid, downstream.data!.id, "next-worker")).statusCode).toBe(
		409,
	);
	const decide = await f.client.claimDecide(f.pid, "review", 0);
	expect(decide.ok).toBe(true);
	await readAllPlanningGraph(f.client, f.pid, "review");
	const graph = await inspectClientProject(f.client, f.pid);
	expect(graph.steps.find((s) => s.id === f.sid)?.result?.task_status).toBe("blocked");
	expect(graph.project.status).toBe("active");
	expect(
		(
			await f.client.abandonStep(
				f.pid,
				downstream.data!.id,
				"review",
				"required credential is missing",
			)
		).ok,
	).toBe(true);
	expect((await f.client.completeDecide(f.pid, "review", decide.data!.planning_version)).ok).toBe(
		true,
	);
	expect((await f.client.releaseDecide(f.pid, "review")).ok).toBe(true);
	expect((await f.client.claimStep(f.pid, downstream.data!.id, "next-worker")).statusCode).toBe(
		409,
	);
});

test("invalid usage cannot partially conclude a successful step", async () => {
	const f = await fixture();
	expect(
		(
			await f.worker.reportResult({
				outcome: "succeeded",
				result: {
					schema_version: 1,
					task_status: "satisfied" as const,
					summary: "done",
					unresolved: [],
				},
				usage: { ...usage, input_tokens: -1 },
			})
		).statusCode,
	).toBe(400);
	expect(f.state().step).toEqual({ status: "claimed", summary: null });
	expect(f.state().usage).toEqual([]);
});

test("stale lease cannot commit a step or telemetry via finalization", async () => {
	const f = await fixture();
	f.db
		.prepare("UPDATE steps SET lease_version=lease_version+1 WHERE project_id=? AND id=?")
		.run(f.pid, f.sid);
	expect(
		(
			await f.worker.reportResult({
				outcome: "succeeded",
				result: {
					schema_version: 1,
					task_status: "satisfied" as const,
					summary: "stale",
					unresolved: [],
				},
				usage,
			})
		).statusCode,
	).toBe(409);
	expect(f.state()).toEqual({
		step: { status: "claimed", summary: null },
		execution: { status: "running", summary: null },
		usage: [],
	});
});

test("failed executions save telemetry without concluding the step", async () => {
	const f = await fixture();
	expect(
		(await f.worker.reportResult({ outcome: "failed", error: "model failed", usage })).ok,
	).toBe(true);
	expect(f.state().step).toEqual({ status: "claimed", summary: null });
	expect(f.state().execution).toEqual({ status: "failed", summary: null });
	expect(f.db.prepare("SELECT error FROM executions WHERE id=?").get(f.eid)).toEqual({
		error: "model failed",
	});
	expect(f.state().usage).toHaveLength(1);
});

test("Worker retries the entire final submission after a lost acknowledgement with no separate writes", async () => {
	const f = await fixture();
	const submit = f.worker.reportResult.bind(f.worker);
	const report = vi.spyOn(f.worker, "reportResult").mockImplementationOnce(async (body) => {
		expect((await submit(body)).ok).toBe(true);
		return { ok: false, statusCode: 0, text: "ack lost", data: undefined };
	});
	const result = await finalizeWorkerRun(
		f.worker,
		{
			outcome: "succeeded",
			finalText: "done",
			result: {
				schema_version: 1,
				task_status: "satisfied" as const,
				summary: "done",
				unresolved: [],
			},
			usage: { ...usage, activity: "execute" },
			leaseFailure: null,
		},
		silentLogger,
	);
	expect(result.exitCode).toBe(0);
	expect(report).toHaveBeenCalledTimes(2);
	expect(f.state().usage).toHaveLength(1);
	expect(f.state().step).toEqual({ status: "concluded", summary: "done" });
});
