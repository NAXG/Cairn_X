import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "vitest";

import { buildExperimentMetrics, writeExperimentMetrics } from "../../src/regression/report.js";
import { parseRegressionSet } from "../../src/regression/set.js";
import { appendRecord } from "../../src/regression/store.js";

function fixtureRoot(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-regression-report-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function utc(): string {
	return new Date().toISOString();
}

test("builds manual metrics and writes metrics/per-challenge files", () => {
	const root = fixtureRoot();
	const set = parseRegressionSet({
		version: 1,
		platform: "tsecbench",
		smoke: { "b-01": { runs: 2 } },
		regression: { "b-02": { runs: 1 } },
	});

	appendRecord(root, "baseline", {
		type: "run_started",
		experiment_id: "baseline",
		unique_code: "b-01",
		run: 1,
		project_id: "p1",
		targets: ["10.0.0.1:80"],
		started_at: utc(),
	});
	appendRecord(root, "baseline", {
		type: "run_finished",
		experiment_id: "baseline",
		unique_code: "b-01",
		run: 1,
		project_id: "p1",
		agent_status: "concluded",
		step_id: "s1",
		seconds: 900,
		finished_at: utc(),
		stats_file: null,
		digest_file: null,
	});
	appendRecord(root, "baseline", {
		type: "run_result",
		experiment_id: "baseline",
		unique_code: "b-01",
		run: 1,
		result: "solved",
		flags_correct: 2,
		flags_total: 2,
		hints_used: false,
		notes: null,
		recorded_at: utc(),
	});
	appendRecord(root, "baseline", {
		type: "run_result",
		experiment_id: "baseline",
		unique_code: "b-01",
		run: 2,
		result: "failed",
		flags_correct: 0,
		flags_total: 2,
		hints_used: true,
		notes: "wrong path",
		recorded_at: utc(),
	});
	appendRecord(root, "baseline", {
		type: "run_result",
		experiment_id: "baseline",
		unique_code: "b-02",
		run: 1,
		result: "timeout",
		flags_correct: 0,
		flags_total: 1,
		hints_used: null,
		notes: null,
		recorded_at: utc(),
	});

	const metrics = buildExperimentMetrics(set, [], "baseline");
	expect(metrics.summary).toMatchObject({
		challenges: 2,
		configured_runs: 3,
		started_runs: 0,
		finished_runs: 0,
		recorded_runs: 0,
		solved_runs: 0,
		agent_concluded_runs: 0,
	});

	const loaded = buildExperimentMetrics(
		set,
		[
			{
				type: "run_started",
				experiment_id: "baseline",
				unique_code: "b-01",
				run: 1,
				project_id: "p1",
				targets: ["10.0.0.1:80"],
				started_at: utc(),
			},
			{
				type: "run_finished",
				experiment_id: "baseline",
				unique_code: "b-01",
				run: 1,
				project_id: "p1",
				agent_status: "concluded",
				step_id: "s1",
				seconds: 900,
				finished_at: utc(),
				stats_file: null,
				digest_file: null,
			},
			{
				type: "run_result",
				experiment_id: "baseline",
				unique_code: "b-01",
				run: 1,
				result: "solved",
				flags_correct: 2,
				flags_total: 2,
				hints_used: false,
				notes: null,
				recorded_at: utc(),
			},
		],
		"baseline",
	);
	expect(loaded.summary.solved_runs).toBe(1);
	expect(loaded.summary.recorded_runs).toBe(1);
	expect(loaded.summary.solve_rate).toBe(1);
	expect(loaded.challenges[0]?.solved_at_least_once).toBe(true);

	const files = writeExperimentMetrics(root, "baseline", loaded);
	expect(files.metricsFile).toContain("metrics.json");
	expect(files.perChallengeFile).toContain("per_challenge.jsonl");
});
