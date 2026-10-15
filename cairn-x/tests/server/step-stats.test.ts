import { inspectProject } from "../support/project-state.js";
import { expect, test } from "vitest";

import { classifyStepOutcome } from "../../src/server/core/model-mappers.js";
import {
	claimDecideForRead,
	createProject,
	createTestServer,
	post,
	readPlanningGraph,
} from "./helpers.js";

test("step model exposes attempts, last outcome, error class and per-step cost", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const create = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "try the import endpoint",
		creator: "decider",
	});
	expect(create.status).toBe(201);

	const insert = db.prepare(
		`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at, error)
		 VALUES (?, ?, 's001', ?, 1, ?, ?, ?)`,
	);
	insert.run("e1", pid, 1, "failed", "2026-01-01T00:00:01Z", "502 from provider");
	insert.run(
		"e2",
		pid,
		2,
		"failed",
		"2026-01-01T00:00:02Z",
		"model endpoint unhealthy: 502 from provider",
	);
	db.prepare(
		`INSERT INTO usage_events (project_id, activity, step_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
		 VALUES (?, 'execute', 's001', 'm', 100, 200, 300, 0, '2026-01-01T00:00:02Z')`,
	).run(pid);

	const detail = inspectProject(db, pid);
	const step = detail.steps.find((s) => s.id === "s001")!;
	expect(step.attempts).toBe(2);
	// 最近一次是端点不健康：必须区别于普通 failed 与 deadline
	expect(step.last_outcome).toBe("endpoint_unhealthy");
	expect(step.last_error).toContain("model endpoint unhealthy");
	expect(step.cost).toEqual({
		executions: 1,
		input_tokens: 100,
		output_tokens: 200,
		cache_read_tokens: 300,
		cache_write_tokens: 0,
	});

	// 规划前沿也带上这些字段（Decide 直接看得到，不用翻执行轨迹）。
	await claimDecideForRead(app, pid, "reader");
	const pages = await readPlanningGraph(app, pid, "reader");
	expect(
		pages.flatMap((page) => page.frontier.steps).find((s: any) => s.id === "s001"),
	).toMatchObject({
		attempts: 2,
		last_outcome: "endpoint_unhealthy",
		last_error: "model endpoint unhealthy: 502 from provider",
	});
});

test("untried steps report zero attempts and null outcome", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "never ran",
		creator: "decider",
	});
	const step = inspectProject(db, pid).steps.find((s) => s.id === "s001")!;
	expect(step.attempts).toBe(0);
	expect(step.last_outcome).toBeNull();
	expect(step.last_error).toBeNull();
	expect(step.cost.executions).toBe(0);
});

test("classifyStepOutcome separates deadline, lost, running and success", () => {
	expect(
		classifyStepOutcome({
			status: "failed",
			error: "controller deadline exceeded; container reclaimed",
		}),
	).toBe("deadline_exceeded");
	expect(classifyStepOutcome({ status: "lost", error: null })).toBe("lost");
	expect(classifyStepOutcome({ status: "running", error: null })).toBe("running");
	expect(classifyStepOutcome({ status: "succeeded", error: null })).toBe("succeeded");
	expect(classifyStepOutcome({ status: "cancelled", error: null })).toBe("cancelled");
});
