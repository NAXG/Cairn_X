import path from "node:path";

import { ClientError, type FgsClient } from "../orchestrator/client.js";
import { findRegressionCase, type RegressionSet } from "./set.js";
import {
	appendRecord,
	ensureExperimentDir,
	safeComponent,
	type ManualRunResult,
	type RunFinishedRecord,
	type RunResultRecord,
	type RunStartedRecord,
	writeJson,
} from "./store.js";
import { sleep } from "../shared/async.js";
import { utcnow } from "../shared/time.js";

interface ManualStartRunInput {
	experimentId: string;
	uniqueCode: string;
	run: number;
	targets: string[];
	title?: string;
	goal?: string;
	description?: string;
	flagFormat?: string;
	harnessVariant?: string;
	timeoutSeconds?: number;
	pollSeconds?: number;
}

interface ManualStartRunResult {
	projectId: string;
	stepId: string;
	finished: RunFinishedRecord;
}

function requireData<T>(
	result: { ok: boolean; data: T | undefined; text: string; statusCode: number },
	action: string,
): T {
	if (result.ok === false || result.data === undefined) {
		throw new Error(action + " failed: " + result.statusCode + " " + result.text.slice(0, 300));
	}
	return result.data;
}

function defaultGoal(targets: string[]): string {
	return (
		"对远程靶场 " +
		targets.join(", ") +
		" 完成题目，提取并验证可提交的 flag，最后用 submit_finding 汇报 flag 与复现证据。"
	);
}

export async function startManualRun(
	client: FgsClient,
	experimentsRoot: string,
	set: RegressionSet,
	input: ManualStartRunInput,
): Promise<ManualStartRunResult> {
	const caseConfig = findRegressionCase(set, input.uniqueCode);
	const targets = input.targets.map((target) => target.trim()).filter((target) => target !== "");
	if (targets.length === 0) throw new Error("at least one target address is required");
	if (!Number.isSafeInteger(input.run) || input.run < 1)
		throw new Error("run must be a positive integer");
	const run = input.run;
	const timeoutSeconds = input.timeoutSeconds ?? caseConfig.max_seconds;
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
		throw new Error("timeoutSeconds must be a positive finite number");
	const pollSeconds = input.pollSeconds ?? 5;
	if (!Number.isFinite(pollSeconds) || pollSeconds <= 0)
		throw new Error("pollSeconds must be a positive finite number");
	const pollMs = Math.max(pollSeconds * 1000, 1000);
	const title =
		input.title ?? "[" + input.experimentId + "] " + caseConfig.unique_code + " run " + run;
	const goal = input.goal ?? defaultGoal(targets);
	const originParts = [
		"远程靶场地址：" + targets.join(", "),
		input.description === undefined ? "" : "题目描述：\n" + input.description,
	].filter((part) => part !== "");
	const hints: Array<{ content: string; creator: string }> = [];
	if (input.flagFormat !== undefined && input.flagFormat.trim() !== "") {
		hints.push({ content: "flag 格式：" + input.flagFormat.trim(), creator: "human" });
	}

	const projectResult = await client.createProject({
		title,
		origin: originParts.join("\n\n"),
		goal,
		experiment_id: input.experimentId,
		harness_variant: input.harnessVariant,
		hints,
	});
	const project = requireData(projectResult, "createProject").project;
	const stepResult = await client.createStep(project.id, {
		actor: "human",
		from: ["origin"],
		goal_id: "goal",
		description: goal,
		creator: "human",
	});
	const step = requireData(stepResult, "createStep");
	const startedAt = utcnow();
	const startedMs = Date.now();
	const started: RunStartedRecord = {
		type: "run_started",
		experiment_id: input.experimentId,
		unique_code: input.uniqueCode,
		run,
		project_id: project.id,
		targets,
		started_at: startedAt,
	};
	appendRecord(experimentsRoot, input.experimentId, started);

	const deadline = startedMs + timeoutSeconds * 1000;
	let agentStatus: RunFinishedRecord["agent_status"] = "timeout";
	while (Date.now() < deadline) {
		await sleep(pollMs);

		let current;
		let projectDone = false;
		try {
			projectDone = (await client.getSchedulingProjectState(project.id)).status === "completed";
			if (!projectDone) current = await client.getRecord(project.id, "step", step.id);
		} catch (error) {
			if (error instanceof ClientError && error.statusCode === 404) {
				agentStatus = "cancelled";
				break;
			}
			continue;
		}
		if (projectDone) {
			agentStatus = "concluded";
			break;
		}
		if (current === undefined) {
			agentStatus = "cancelled";
			break;
		}
		if (current.status === "concluded") {
			agentStatus = "concluded";
			break;
		}
		if (current.status === "abandoned") {
			agentStatus = "abandoned";
			break;
		}
	}
	let stopError: unknown;
	if (agentStatus === "timeout") {
		try {
			await client.setProjectStatus(project.id, "stopped");
		} catch (err) {
			stopError = err;
		}
	}

	const dir = ensureExperimentDir(experimentsRoot, input.experimentId);
	const baseName = safeComponent(input.uniqueCode, "case") + "-run" + String(run);
	const statsFile = path.join(dir, baseName + "-stats.json");
	const digestFile = path.join(dir, baseName + "-digest.json");
	let statsPath: string | null = null;
	let digestPath: string | null = null;
	try {
		const stats = await client.getProjectStats(project.id);
		writeJson(statsFile, stats);
		statsPath = statsFile;
	} catch {
		statsPath = null;
	}
	try {
		const digest = await client.getProjectDigest(project.id, { step_id: step.id });
		writeJson(digestFile, digest);
		digestPath = digestFile;
	} catch {
		digestPath = null;
	}

	const finished: RunFinishedRecord = {
		type: "run_finished",
		experiment_id: input.experimentId,
		unique_code: input.uniqueCode,
		run,
		project_id: project.id,
		agent_status: agentStatus,
		step_id: step.id,
		seconds: Math.round((Date.now() - startedMs) / 100) / 10,
		finished_at: utcnow(),
		stats_file: statsPath,
		digest_file: digestPath,
	};
	appendRecord(experimentsRoot, input.experimentId, finished);
	if (stopError !== undefined)
		throw new Error("Timed-out project could not be stopped", { cause: stopError });
	return { projectId: project.id, stepId: step.id, finished };
}

interface ManualRecordInput {
	experimentId: string;
	uniqueCode: string;
	run: number;
	result: ManualRunResult;
	flagsCorrect?: number;
	flagsTotal?: number;
	hintsUsed?: boolean;
	notes?: string;
}

export function recordManualResult(
	experimentsRoot: string,
	input: ManualRecordInput,
): RunResultRecord {
	if (!Number.isSafeInteger(input.run) || input.run < 1)
		throw new Error("run must be a positive integer");
	for (const count of [input.flagsCorrect, input.flagsTotal]) {
		if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
			throw new Error("flag counts must be non-negative integers");
	}
	const record: RunResultRecord = {
		type: "run_result",
		experiment_id: input.experimentId,
		unique_code: input.uniqueCode,
		run: input.run,
		result: input.result,
		flags_correct: input.flagsCorrect ?? null,
		flags_total: input.flagsTotal ?? null,
		hints_used: input.hintsUsed ?? null,
		notes: input.notes ?? null,
		recorded_at: utcnow(),
	};
	appendRecord(experimentsRoot, input.experimentId, record);
	return record;
}
