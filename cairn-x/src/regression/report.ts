import { writeFileSync } from "node:fs";
import path from "node:path";

import type { RegressionCase, RegressionSet } from "./set.js";
import {
	ensureExperimentDir,
	latestRuns,
	readRecords,
	type ManualRunResult,
	type RegressionRecord,
	type RunState,
	writeJson,
} from "./store.js";
import { utcnow } from "../shared/time.js";

interface PerRunMetric {
	run: number;
	result: ManualRunResult;
	flags_correct: number | null;
	flags_total: number | null;
	hints_used: boolean | null;
	notes: string | null;
	recorded_at: string;
}

interface PerChallengeMetric {
	unique_code: string;
	section: RegressionCase["section"];
	configured_runs: number;
	started_runs: number;
	finished_runs: number;
	recorded_runs: number;
	solved_runs: number;
	failed_runs: number;
	timeout_runs: number;
	skipped_runs: number;
	missing_runs: number;
	solved_at_least_once: boolean;
	runs: PerRunMetric[];
}

interface ExperimentMetrics {
	experiment_id: string;
	generated_at: string;
	set_version: number;
	summary: {
		challenges: number;
		configured_runs: number;
		started_runs: number;
		finished_runs: number;
		recorded_runs: number;
		solved_runs: number;
		failed_runs: number;
		timeout_runs: number;
		skipped_runs: number;
		missing_runs: number;
		solve_rate: number;
		challenge_pass_rate: number;
		agent_concluded_runs: number;
		agent_timeout_runs: number;
	};
	challenges: PerChallengeMetric[];
}

function resultMetric(state: RunState): PerRunMetric | null {
	if (state.result === null) return null;
	return {
		run: state.result.run,
		result: state.result.result,
		flags_correct: state.result.flags_correct,
		flags_total: state.result.flags_total,
		hints_used: state.result.hints_used,
		notes: state.result.notes,
		recorded_at: state.result.recorded_at,
	};
}

function summarizeCase(caseConfig: RegressionCase, states: RunState[]): PerChallengeMetric {
	const configuredRuns = caseConfig.runs;
	const byRun = new Map<number, RunState>();
	for (const state of states) byRun.set(state.run, state);
	const runs: PerRunMetric[] = [];
	let startedRuns = 0;
	let finishedRuns = 0;
	let solvedRuns = 0;
	let failedRuns = 0;
	let timeoutRuns = 0;
	let skippedRuns = 0;

	for (let run = 1; run <= configuredRuns; run += 1) {
		const state = byRun.get(run);
		if (state?.started !== null && state?.started !== undefined) startedRuns += 1;
		if (state?.finished !== null && state?.finished !== undefined) finishedRuns += 1;
		const metric = state === undefined ? null : resultMetric(state);
		if (metric === null) continue;
		runs.push(metric);
		if (metric.result === "solved") solvedRuns += 1;
		if (metric.result === "failed") failedRuns += 1;
		if (metric.result === "timeout") timeoutRuns += 1;
		if (metric.result === "skipped") skippedRuns += 1;
	}

	return {
		unique_code: caseConfig.unique_code,
		section: caseConfig.section,
		configured_runs: configuredRuns,
		started_runs: startedRuns,
		finished_runs: finishedRuns,
		recorded_runs: runs.length,
		solved_runs: solvedRuns,
		failed_runs: failedRuns,
		timeout_runs: timeoutRuns,
		skipped_runs: skippedRuns,
		missing_runs: Math.max(configuredRuns - runs.length, 0),
		solved_at_least_once: solvedRuns > 0,
		runs,
	};
}

export function buildExperimentMetrics(
	set: RegressionSet,
	records: RegressionRecord[],
	experimentId: string,
): ExperimentMetrics {
	const statesByKey = latestRuns(records);
	const latestFinished = [...statesByKey.values()].flatMap((state) =>
		state.finished ? [state.finished] : [],
	);
	const challenges = set.cases.map((caseConfig) => {
		const states: RunState[] = [];
		for (let run = 1; run <= caseConfig.runs; run += 1) {
			const state = statesByKey.get(caseConfig.unique_code + "#" + String(run));
			if (state !== undefined) states.push(state);
		}
		return summarizeCase(caseConfig, states);
	});

	const summary = {
		challenges: challenges.length,
		configured_runs: challenges.reduce((total, item) => total + item.configured_runs, 0),
		started_runs: challenges.reduce((total, item) => total + item.started_runs, 0),
		finished_runs: challenges.reduce((total, item) => total + item.finished_runs, 0),
		recorded_runs: challenges.reduce((total, item) => total + item.recorded_runs, 0),
		solved_runs: challenges.reduce((total, item) => total + item.solved_runs, 0),
		failed_runs: challenges.reduce((total, item) => total + item.failed_runs, 0),
		timeout_runs: challenges.reduce((total, item) => total + item.timeout_runs, 0),
		skipped_runs: challenges.reduce((total, item) => total + item.skipped_runs, 0),
		missing_runs: challenges.reduce((total, item) => total + item.missing_runs, 0),
		solve_rate: 0,
		challenge_pass_rate: 0,
		agent_concluded_runs: latestFinished.filter(
			(record) => record.type === "run_finished" && record.agent_status === "concluded",
		).length,
		agent_timeout_runs: latestFinished.filter(
			(record) => record.type === "run_finished" && record.agent_status === "timeout",
		).length,
	};

	const withResults = challenges.filter((item) => item.recorded_runs > 0);
	summary.solve_rate =
		summary.recorded_runs === 0 ? 0 : summary.solved_runs / summary.recorded_runs;
	summary.challenge_pass_rate =
		withResults.length === 0
			? 0
			: withResults.filter((item) => item.solved_at_least_once).length / withResults.length;

	return {
		experiment_id: experimentId,
		generated_at: utcnow(),
		set_version: set.version,
		summary,
		challenges,
	};
}

export function writeExperimentMetrics(
	root: string,
	experimentId: string,
	metrics: ExperimentMetrics,
): { metricsFile: string; perChallengeFile: string } {
	const dir = ensureExperimentDir(root, experimentId);
	const metricsFile = path.join(dir, "metrics.json");
	const perChallengeFile = path.join(dir, "per_challenge.jsonl");
	writeJson(metricsFile, metrics);
	writeFileSync(
		perChallengeFile,
		metrics.challenges.length === 0
			? ""
			: metrics.challenges.map((item) => JSON.stringify(item)).join("\n") + "\n",
		"utf8",
	);
	return { metricsFile, perChallengeFile };
}

export function loadExperimentMetrics(
	set: RegressionSet,
	root: string,
	experimentId: string,
): ExperimentMetrics {
	return buildExperimentMetrics(set, readRecords(root, experimentId), experimentId);
}
