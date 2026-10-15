import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

type AgentRunStatus = "concluded" | "abandoned" | "timeout" | "cancelled";
export type ManualRunResult = "solved" | "failed" | "timeout" | "skipped";

export interface RunStartedRecord {
	type: "run_started";
	experiment_id: string;
	unique_code: string;
	run: number;
	project_id: string;
	targets: string[];
	started_at: string;
}

export interface RunFinishedRecord {
	type: "run_finished";
	experiment_id: string;
	unique_code: string;
	run: number;
	project_id: string;
	agent_status: AgentRunStatus;
	step_id: string | null;
	seconds: number;
	finished_at: string;
	stats_file: string | null;
	digest_file: string | null;
}

export interface RunResultRecord {
	type: "run_result";
	experiment_id: string;
	unique_code: string;
	run: number;
	result: ManualRunResult;
	flags_correct: number | null;
	flags_total: number | null;
	hints_used: boolean | null;
	notes: string | null;
	recorded_at: string;
}

export type RegressionRecord = RunStartedRecord | RunFinishedRecord | RunResultRecord;

const recordBase = {
	experiment_id: z.string(),
	unique_code: z.string().min(1),
	run: z.number().int().positive(),
};
const regressionRecordSchema = z.discriminatedUnion("type", [
	z.object({
		...recordBase,
		type: z.literal("run_started"),
		project_id: z.string(),
		targets: z.array(z.string()),
		started_at: z.string(),
	}),
	z.object({
		...recordBase,
		type: z.literal("run_finished"),
		project_id: z.string(),
		agent_status: z.enum(["concluded", "abandoned", "timeout", "cancelled"]),
		step_id: z.string().nullable(),
		seconds: z.number().finite(),
		finished_at: z.string(),
		stats_file: z.string().nullable(),
		digest_file: z.string().nullable(),
	}),
	z.object({
		...recordBase,
		type: z.literal("run_result"),
		result: z.enum(["solved", "failed", "timeout", "skipped"]),
		flags_correct: z.number().nullable(),
		flags_total: z.number().nullable(),
		hints_used: z.boolean().nullable(),
		notes: z.string().nullable(),
		recorded_at: z.string(),
	}),
]);

export interface RunState {
	run: number;
	started: RunStartedRecord | null;
	finished: RunFinishedRecord | null;
	result: RunResultRecord | null;
}

export function safeComponent(value: string, fallback = "experiment"): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
	return safe === "" || safe === "." || safe === ".." ? fallback : safe;
}

function experimentDir(root: string, experimentId: string): string {
	return path.join(root, safeComponent(experimentId));
}

function recordFile(root: string, experimentId: string): string {
	return path.join(experimentDir(root, experimentId), "runs.jsonl");
}

export function ensureExperimentDir(root: string, experimentId: string): string {
	const dir = experimentDir(root, experimentId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function appendRecord(root: string, experimentId: string, record: RegressionRecord): void {
	ensureExperimentDir(root, experimentId);
	appendFileSync(recordFile(root, experimentId), JSON.stringify(record) + "\n", "utf8");
}

export function readRecords(root: string, experimentId: string): RegressionRecord[] {
	const file = recordFile(root, experimentId);
	if (existsSync(file) === false) return [];
	const lines = readFileSync(file, "utf8").split("\n");
	const records: RegressionRecord[] = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		try {
			const parsed = regressionRecordSchema.safeParse(JSON.parse(line));
			if (parsed.success) records.push(parsed.data);
		} catch {
			// A malformed line should not hide the rest of the experiment ledger.
		}
	}
	return records;
}

function runKey(uniqueCode: string, run: number): string {
	return uniqueCode + "#" + String(run);
}

export function latestRuns(records: RegressionRecord[]): Map<string, RunState> {
	const states = new Map<string, RunState>();
	for (const record of records) {
		const key = runKey(record.unique_code, record.run);
		const state =
			states.get(key) ??
			({
				run: record.run,
				started: null,
				finished: null,
				result: null,
			} satisfies RunState);
		if (record.type === "run_started") state.started = record;
		if (record.type === "run_finished") state.finished = record;
		if (record.type === "run_result") state.result = record;
		states.set(key, state);
	}
	return states;
}

export function writeJson(file: string, value: unknown): void {
	writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}
