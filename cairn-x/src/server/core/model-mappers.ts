import type { EvidenceRef } from "../../contracts/evidence.js";
import {
	UNHEALTHY_ERROR_MARKER,
	parseCommittedExecutionResultJson,
} from "../../contracts/execution.js";
import type {
	DecideLease,
	FactModel,
	FindingModel,
	GoalModel,
	ProjectMeta,
	ProjectPlanning,
	ProjectUsage,
	RouteModel,
	StepCost,
	StepLastOutcome,
	StepModel,
	UsageEvent,
} from "../../contracts/models.js";
import type {
	Db,
	FactRow,
	FindingRow,
	GoalRow,
	ProjectRow,
	RouteRow,
	StepRow,
	UsageEventRow,
} from "../db.js";
import { MAX_CONSECUTIVE_DECIDE_INTERRUPTS, pendingDecideInterruptions } from "./decide.js";
import { listEvidenceRefs, listGoalEvidence } from "./evidence.js";
import { usageByActivity } from "./usage-aggregate.js";

function decideLeaseFromRow(row: ProjectRow): DecideLease | null {
	if (row.decide_worker === null) {
		return null;
	}
	return {
		worker: row.decide_worker,
		trigger: row.decide_trigger ?? "",
		started_at: row.decide_started_at ?? "",
		last_heartbeat_at: row.decide_last_heartbeat_at ?? "",
	};
}

export function projectMetaFromRow(row: ProjectRow): ProjectMeta {
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		created_at: row.created_at,
		finding_schema: row.finding_schema === null ? null : JSON.parse(row.finding_schema),
		experiment_id: row.experiment_id,
		harness_variant: row.harness_variant,
		decide: decideLeaseFromRow(row),
	};
}

export function factToModel(
	db: Db,
	row: FactRow,
	evidence = listEvidenceRefs(db, row.project_id, "fact", row.id),
): FactModel {
	return {
		id: row.id,
		description: row.description,
		confidence: row.confidence,
		step_id: row.step_id,
		evidence_refs: evidence,
		created_at: row.created_at,
	};
}

export function goalToModel(
	db: Db,
	row: GoalRow,
	evidence = listGoalEvidence(db, row.project_id, row.id),
): GoalModel {
	return {
		id: row.id,
		parent_goal_id: row.parent_goal_id,
		description: row.description,
		status: row.status,
		evidence,
		achieved_description: row.achieved_description,
		created_at: row.created_at,
		achieved_at: row.achieved_at,
	};
}

/** 每个步骤的执行统计（尝试数 / 最近结果 / 累计消耗）。 */
interface StepStats {
	attempts: number;
	last: { status: string; error: string | null } | null;
	cost: StepCost;
}

/** Read statistics only for the selected Step; there is no whole-project batch mode. */
function collectStepStats(db: Db, projectId: string, stepId: string): StepStats {
	const attempts = db
		.prepare(
			"SELECT status,error FROM executions WHERE project_id=? AND step_id=? ORDER BY attempt",
		)
		.all(projectId, stepId) as Array<{ status: string; error: string | null }>;
	const cost = db
		.prepare(
			`SELECT COUNT(*) executions,COALESCE(SUM(input_tokens),0) input_tokens,
 COALESCE(SUM(output_tokens),0) output_tokens,COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,
 COALESCE(SUM(cache_write_tokens),0) cache_write_tokens FROM usage_events
 WHERE project_id=? AND activity='execute' AND step_id=?`,
		)
		.get(projectId, stepId) as StepCost;
	return { attempts: attempts.length, last: attempts.at(-1) ?? null, cost };
}

/** 执行结果分类；error 前缀优先于状态，端点故障与超时分别单列。 */
export function classifyStepOutcome(last: {
	status: string;
	error: string | null;
}): StepLastOutcome {
	const error = last.error ?? "";
	if (error.startsWith(UNHEALTHY_ERROR_MARKER)) return "endpoint_unhealthy";
	if (error.toLowerCase().includes("deadline")) return "deadline_exceeded";
	switch (last.status) {
		case "succeeded":
			return "succeeded";
		case "cancelled":
			return "cancelled";
		case "lost":
			return "lost";
		case "failed":
			return "failed";
		default:
			return "running";
	}
}

export interface RouteStepStats {
	step_count: number;
	open_step_count: number;
	concluded_step_count: number;
}

export function routeToModel(row: RouteRow, stats?: RouteStepStats): RouteModel {
	return {
		id: row.id,
		description: row.description,
		goal_id: row.goal_id,
		creator: row.creator,
		created_at: row.created_at,
		step_count: stats?.step_count ?? 0,
		open_step_count: stats?.open_step_count ?? 0,
		concluded_step_count: stats?.concluded_step_count ?? 0,
	};
}

export function stepToModel(db: Db, row: StepRow, projectId: string): StepModel {
	const sources = (
		db
			.prepare("SELECT fact_id FROM step_sources WHERE step_id=? AND project_id=? ORDER BY rowid")
			.all(row.id, projectId) as Array<{ fact_id: string }>
	).map((source) => source.fact_id);
	const stat = collectStepStats(db, projectId, row.id);
	const stored = db
		.prepare(
			`SELECT er.payload FROM execution_results er JOIN executions e ON e.id=er.execution_id
 WHERE e.project_id=? AND e.step_id=? AND e.status='succeeded' ORDER BY e.attempt DESC LIMIT 1`,
		)
		.get(projectId, row.id) as { payload: string } | undefined;
	const structuredResult = stored ? parseCommittedExecutionResultJson(stored.payload) : null;
	return {
		id: row.id,
		from: sources,
		summary: row.summary,
		result: structuredResult,
		goal_id: row.goal_id,
		route_id: row.route_id ?? null,
		description: row.description,
		priority: row.priority,
		status: row.status,
		creator: row.creator,
		worker: row.worker,
		last_heartbeat_at: row.last_heartbeat_at,
		lease_version: row.lease_version,
		waiting_on: parseJsonStringArray(row.waiting_on),
		created_at: row.created_at,
		concluded_at: row.concluded_at,
		attempts: stat.attempts,
		last_outcome: stat.last === null ? null : classifyStepOutcome(stat.last),
		last_error: stat.last?.error ? stat.last.error.slice(0, 200) : null,
		cost: stat.cost,
	};
}

/** JSON 字符串数组列（steps.waiting_on / findings.fact_ids）的解析。 */
export function parseJsonStringArray(raw: string | null): string[] {
	return raw === null ? [] : (JSON.parse(raw) as string[]);
}

export function findingToModel(
	db: Db,
	row: FindingRow,
	evidence: EvidenceRef[] = listEvidenceRefs(db, row.project_id, "finding", row.id),
): FindingModel {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		data: row.data === null ? null : JSON.parse(row.data),
		fact_ids: JSON.parse(row.fact_ids) as string[],
		evidence_refs: evidence,
		created_at: row.created_at,
	};
}

export function usageEventToModel(row: UsageEventRow): UsageEvent {
	return {
		id: row.id,
		project_id: row.project_id,
		activity: row.activity,
		step_id: row.step_id,
		execution_id: row.execution_id ?? null,
		model: row.model,
		input_tokens: row.input_tokens,
		output_tokens: row.output_tokens,
		cache_read_tokens: row.cache_read_tokens,
		cache_write_tokens: row.cache_write_tokens,
		created_at: row.created_at,
	};
}

/** 按 activity 分组的 token 总计，数据来自 usage_events 表。 */
export function usageAggregates(db: Db, projectId: string): ProjectUsage {
	const rows = usageByActivity(db, projectId);
	const usage: ProjectUsage = {
		decide: {
			events: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		},
		execute: {
			events: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		},
	};
	for (const row of rows) {
		if (row.activity === "decide" || row.activity === "execute") {
			usage[row.activity] = {
				events: row.events,
				input_tokens: row.input_tokens,
				output_tokens: row.output_tokens,
				cache_read_tokens: row.cache_read_tokens,
				cache_write_tokens: row.cache_write_tokens,
			};
		}
	}
	return usage;
}

/** 项目规划 checkpoint 概要（无 checkpoint 时为 null）。 */
export function planningInfo(db: Db, projectId: string): ProjectPlanning {
	const row = db
		.prepare(
			"SELECT planning_version, last_trigger, updated_at FROM decide_checkpoints WHERE project_id = ?",
		)
		.get(projectId) as
		{ planning_version: number; last_trigger: string | null; updated_at: string } | undefined;
	if (row === undefined) return null;
	const interruptedRetries = pendingDecideInterruptions(db, projectId);
	return {
		version: row.planning_version,
		last_trigger: row.last_trigger,
		updated_at: row.updated_at,
		interrupted_retries: interruptedRetries,
		stalled: interruptedRetries >= MAX_CONSECUTIVE_DECIDE_INTERRUPTS,
	};
}
