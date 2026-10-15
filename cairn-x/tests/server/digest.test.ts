import { expect, test } from "vitest";

import { createProject, createTestServer, get, post } from "./helpers.js";

test("historical Cairn failures are counted without reinterpreting native/plugin metadata", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const step = await (
		await post(app, `/projects/${pid}/steps`, {
			actor: "human",
			from: ["origin"],
			description: "probe",
			creator: "human",
		})
	).json();
	db.prepare(
		"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES(?,?,?,1,0,'succeeded',?)",
	).run("legacy-tools", pid, step.id, new Date().toISOString());
	const insert = db.prepare("INSERT INTO execution_events(execution_id,seq,line) VALUES(?,?,?)");
	for (const [index, name] of ["submit_fact", "get_graph", "bash", "plugin_custom"].entries())
		insert.run(
			"legacy-tools",
			index + 1,
			envelope(name, new Date().toISOString(), {
				role: "toolResult",
				toolCallId: name,
				toolName: name,
				isError: false,
				content: [{ type: "text", text: "ERROR 409: old returned failure" }],
				details: { error: true },
			}),
		);
	const digest = await (await get(app, `/projects/${pid}/digest`)).json();
	expect(digest.summary.tool_errors).toBe(2);
	expect(
		digest.executions[0].tool_calls.map((call: { name: string; result: string }) => [
			call.name,
			call.result,
		]),
	).toEqual([
		["submit_fact", "error"],
		["get_graph", "error"],
		["bash", "ok"],
		["plugin_custom", "ok"],
	]);
});

function iso(offsetSeconds: number): string {
	return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function envelope(id: string, timestamp: string, message: Record<string, unknown>): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message,
	});
}

function assistant(
	text: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
	stopReason: string,
): Record<string, unknown> {
	return {
		role: "assistant",
		content: text === "" ? [] : [{ type: "text", text }],
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

test("project digest classifies executions and aggregates transcript signals", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app, {
		experiment_id: "prompt-v2",
		harness_variant: "web-v2",
	});
	const step = await (
		await post(app, "/projects/" + pid + "/steps", {
			actor: "human",
			from: ["origin"],
			description: "probe target",
			creator: "decide",
		})
	).json();

	const insertExecution = db.prepare(
		"INSERT INTO executions " +
			"(id, project_id, step_id, attempt, lease_version, status, created_at, started_at, finished_at, result_outcome, summary, error, dropped_events) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	insertExecution.run(
		"exec-ok",
		pid,
		step.id,
		1,
		0,
		"succeeded",
		iso(-300),
		iso(-300),
		iso(-240),
		"succeeded",
		"done",
		null,
		0,
	);
	insertExecution.run(
		"exec-timeout",
		pid,
		step.id,
		2,
		0,
		"failed",
		iso(-220),
		iso(-220),
		iso(-180),
		"failed",
		"command stuck",
		"execution failed",
		0,
	);
	insertExecution.run(
		"exec-lost",
		pid,
		step.id,
		3,
		0,
		"lost",
		iso(-160),
		iso(-160),
		iso(-120),
		null,
		null,
		"deadline exceeded or heartbeat lost",
		2,
	);
	insertExecution.run(
		"exec-endpoint",
		pid,
		step.id,
		4,
		0,
		"failed",
		iso(-100),
		iso(-100),
		iso(-90),
		"failed",
		"endpoint failed",
		"model endpoint unhealthy: connection reset",
		0,
	);

	const insertEvent = db.prepare(
		"INSERT INTO execution_events (execution_id, seq, line) VALUES (?, ?, ?)",
	);
	insertEvent.run(
		"exec-ok",
		1,
		envelope("ok-1", iso(-299), {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-ok",
					name: "bash",
					arguments: { command: "id" },
				},
			],
			usage: { input: 1000, output: 100, cacheRead: 20, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: Date.now(),
		}),
	);
	insertEvent.run(
		"exec-ok",
		2,
		JSON.stringify({
			type: "message",
			id: "ok-2",
			parentId: "ok-1",
			timestamp: iso(-298),
			message: {
				role: "toolResult",
				toolCallId: "call-ok",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: Date.now(),
			},
		}),
	);
	insertEvent.run(
		"exec-ok",
		3,
		envelope(
			"ok-3",
			iso(-297),
			assistant("finished", { input: 100, output: 50, cacheRead: 0, cacheWrite: 5 }, "stop"),
		),
	);
	insertEvent.run("exec-ok", 4, "{malformed");

	insertEvent.run(
		"exec-timeout",
		1,
		JSON.stringify({
			type: "message",
			id: "timeout-1",
			parentId: null,
			timestamp: iso(-219),
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-timeout",
						name: "bash",
						arguments: { command: "sleep 400" },
					},
				],
				usage: { input: 700, output: 40, cacheRead: 10, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		}),
	);
	insertEvent.run(
		"exec-timeout",
		2,
		JSON.stringify({
			type: "message",
			id: "timeout-2",
			parentId: "timeout-1",
			timestamp: iso(-218),
			message: {
				role: "toolResult",
				toolCallId: "call-timeout",
				toolName: "bash",
				content: [{ type: "text", text: "Command timed out after 300 seconds" }],
				isError: true,
				timestamp: Date.now(),
			},
		}),
	);

	db.prepare(
		"INSERT INTO usage_events (project_id, activity, step_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(pid, "execute", step.id, "qwen", 200, 30, 4, 6, iso(-170));
	db.prepare(
		"INSERT INTO facts (id, project_id, description, confidence, step_id, execution_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run("f-digest", pid, "observed flag", "observed", step.id, "exec-ok", iso(-250));
	db.prepare(
		"INSERT INTO findings (id, project_id, title, description, data, fact_ids, step_id, execution_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run("r-digest", pid, "finding", "desc", "{}", "[]", step.id, "exec-ok", iso(-249));
	db.prepare(
		"INSERT INTO benchmark_tasks (project_id, unique_code, title, description, difficulty, level, total_score, flag_count, correct_flag_count, is_completed, container_status, container_addr, hint_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		pid,
		"b-01",
		"Web Login",
		"example",
		"web",
		1,
		100,
		2,
		1,
		1,
		"running",
		"[]",
		0,
		iso(-260),
		iso(-10),
	);

	const res = await get(app, "/projects/" + pid + "/digest");
	expect(res.status).toBe(200);
	const digest = await res.json();
	expect(digest.experiment).toMatchObject({
		experiment_id: "prompt-v2",
		harness_variant: "web-v2",
	});
	expect(digest.summary.executions).toBe(4);
	expect(digest.summary.by_status).toMatchObject({
		succeeded: 1,
		failed: 2,
		lost: 1,
		cancelled: 0,
	});
	expect(digest.summary.by_failure_class).toMatchObject({
		none: 1,
		tool_timeout: 1,
		execution_timeout: 1,
		endpoint_error: 1,
	});
	expect(digest.summary.tool_calls).toBe(2);
	expect(digest.summary.tool_errors).toBe(1);
	expect(digest.summary.tool_timeouts).toBe(1);
	expect(digest.summary.tokens.total).toBe(1990);

	const timeout = digest.executions.find(
		(item: { execution_id: string }) => item.execution_id === "exec-timeout",
	);
	expect(timeout.failure_class).toBe("tool_timeout");
	expect(timeout.component).toBe("tool:bash");
	expect(timeout.tool_calls[0]).toMatchObject({
		name: "bash",
		result: "error",
		timeout: true,
	});
	expect(timeout.tool_calls[0].error_excerpt).toContain("timed out");

	const ok = digest.executions.find(
		(item: { execution_id: string }) => item.execution_id === "exec-ok",
	);
	expect(ok.failure_class).toBe("none");
	expect(ok.transcript).toMatchObject({ messages: 3, malformed: 1, complete: false });
	expect(ok.tool_calls[0]).toMatchObject({ name: "bash", result: "ok" });
	expect(ok.produced).toEqual({ facts: 1, findings: 1 });
	expect(ok.step_usage).toMatchObject({ scope: "step", events: 1, total_tokens: 230 });
	expect(ok.benchmark).toMatchObject({
		unique_code: "b-01",
		is_completed: true,
		correct_flag_count: 1,
		flag_count: 2,
		hint_used: false,
	});

	const lost = digest.executions.find(
		(item: { execution_id: string }) => item.execution_id === "exec-lost",
	);
	expect(lost.failure_class).toBe("execution_timeout");
	expect(lost.transcript.dropped).toBe(2);

	const single = await get(app, "/projects/" + pid + "/executions/exec-endpoint/digest");
	expect(single.status).toBe(200);
	const exec = await single.json();
	expect(exec.failure_class).toBe("endpoint_error");
	expect(exec.component).toBe("model");
});

test("digest validates query limits and project ownership", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const other = await createProject(app);
	const step = await (
		await post(app, "/projects/" + pid + "/steps", {
			actor: "human",
			from: ["origin"],
			description: "probe target",
			creator: "decide",
		})
	).json();
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run("exec-only", pid, step.id, 1, 0, "failed", iso(-10));

	expect((await get(app, "/projects/" + pid + "/digest?limit=0")).status).toBe(400);
	expect((await get(app, "/projects/" + pid + "/digest?limit=abc")).status).toBe(400);
	expect((await get(app, "/projects/" + other + "/executions/exec-only/digest")).status).toBe(404);
	expect((await get(app, "/projects/" + pid + "/executions/missing/digest")).status).toBe(404);
});
