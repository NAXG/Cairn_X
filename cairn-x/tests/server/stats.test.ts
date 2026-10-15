import { expect, test } from "vitest";

import { UNHEALTHY_ERROR_MARKER } from "../../src/contracts/execution.js";
import { createProject, createTestServer, get, post } from "./helpers.js";

function iso(offsetSeconds: number): string {
	return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

test("project stats aggregates executions, usage, yield and benchmark", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app, {
		experiment_id: "prompt-v2",
		harness_variant: "web-v2",
	});
	const step = await (
		await post(app, "/projects/" + pid + "/steps", {
			actor: "human",
			from: ["origin"],
			description: "do work",
			creator: "decide",
		})
	).json();

	await post(app, "/projects/" + pid + "/usage", {
		activity: "decide",
		model: "qwen",
		input_tokens: 100,
		output_tokens: 20,
		cache_read_tokens: 10,
	});
	await post(app, "/projects/" + pid + "/usage", {
		activity: "execute",
		step_id: step.id,
		model: "qwen",
		input_tokens: 1000,
		output_tokens: 200,
		cache_write_tokens: 50,
	});

	db.prepare("INSERT INTO activity_configurations (id, body) VALUES (?, ?)").run(
		"exec-1",
		JSON.stringify({
			project_id: pid,
			created_at: iso(-100),
			profile_revision: 7,
			prompt_hash: "prompt-hash",
			tools_hash: "tools-hash",
			model_id: "qwen",
		}),
	);

	const insertExecution = db.prepare(
		"INSERT INTO executions " +
			"(id, project_id, step_id, attempt, lease_version, status, created_at, started_at, finished_at, error, dropped_events) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	insertExecution.run(
		"exec-1",
		pid,
		step.id,
		1,
		0,
		"succeeded",
		iso(-120),
		iso(-120),
		iso(-60),
		null,
		0,
	);
	insertExecution.run(
		"exec-2",
		pid,
		step.id,
		2,
		0,
		"failed",
		iso(-60),
		iso(-60),
		iso(-30),
		"deadline exceeded",
		1,
	);

	db.prepare(
		"INSERT INTO facts " +
			"(id, project_id, description, confidence, step_id, execution_id, client_event_id, created_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run("f-test-1", pid, "new fact", "observed", step.id, "exec-1", null, iso(-50));
	db.prepare(
		"INSERT INTO findings " +
			"(id, project_id, title, description, data, fact_ids, step_id, execution_id, client_event_id, created_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run("find-1", pid, "finding", "description", "{}", "[]", step.id, "exec-1", null, iso(-40));
	db.prepare(
		"INSERT INTO benchmark_tasks " +
			"(project_id, unique_code, title, description, difficulty, level, total_score, flag_count, " +
			"correct_flag_count, is_completed, container_status, container_addr, hint_used, created_at, updated_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
		0,
		"running",
		"[]",
		1,
		iso(-200),
		iso(-10),
	);

	const res = await get(app, "/projects/" + pid + "/stats");
	expect(res.status).toBe(200);
	const stats = await res.json();
	expect(stats.project_id).toBe(pid);
	expect(stats.experiment).toMatchObject({
		experiment_id: "prompt-v2",
		harness_variant: "web-v2",
		profile_revision: 7,
		prompt_hash: "prompt-hash",
		tools_hash: "tools-hash",
		model_id: "qwen",
	});
	expect(stats.executions.total).toBe(2);
	expect(stats.executions.by_status).toMatchObject({ succeeded: 1, failed: 1 });
	expect(stats.executions.dropped_events).toBe(1);
	expect(stats.executions.by_step).toHaveLength(1);
	expect(stats.executions.by_step[0]).toMatchObject({
		step_id: step.id,
		executions: 2,
		max_attempt: 2,
		succeeded: 1,
		failed: 1,
	});
	expect(stats.usage.decide.total_tokens).toBe(120);
	expect(stats.usage.execute.total_tokens).toBe(1200);
	expect(stats.usage.total.total_tokens).toBe(1320);
	expect(stats.yield.facts).toBe(2);
	expect(stats.yield.findings).toBe(1);
	expect(stats.reliability.timeout_failures).toBe(1);
	expect(stats.benchmark).toMatchObject({
		tasks: 1,
		flags_total: 2,
		flags_correct: 1,
		completion_ratio: 0.5,
		hint_used: 1,
	});
});

test("project stats returns null benchmark when no benchmark task is bound", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	const res = await get(app, "/projects/" + pid + "/stats");
	expect(res.status).toBe(200);
	const stats = await res.json();
	expect(stats.benchmark).toBe(null);
	expect(stats.executions.total).toBe(0);
	expect(stats.usage.total.total_tokens).toBe(0);
});

test("project stats classifies endpoint timeouts separately from execution timeouts", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const step = (await (
		await post(app, "/projects/" + pid + "/steps", {
			actor: "human",
			from: ["origin"],
			description: "do work",
			creator: "decide",
		})
	).json()) as { id: string };
	db.prepare(
		`INSERT INTO executions
		 (id, project_id, step_id, attempt, lease_version, status, created_at, started_at, finished_at, error, dropped_events)
		 VALUES ('endpoint-timeout', ?, ?, 1, 0, 'failed', ?, ?, ?, ?, 0)`,
	).run(
		pid,
		step.id,
		iso(-60),
		iso(-60),
		iso(-30),
		`${UNHEALTHY_ERROR_MARKER}: upstream request timeout`,
	);

	const response = await get(app, "/projects/" + pid + "/stats");
	const stats = await response.json();
	expect(stats.reliability.timeout_failures).toBe(0);
	expect(stats.reliability.unhealthy_failures).toBe(1);
});
