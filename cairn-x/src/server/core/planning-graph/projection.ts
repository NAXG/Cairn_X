import { parseCommittedExecutionResultJson } from "../../../contracts/execution.js";
import type { StepCost } from "../../../contracts/models.js";
import type { Db, FactRow, FindingRow, GoalRow, HintRow, RouteRow, StepRow } from "../../db.js";
import { type DecideChange } from "../decide-changes.js";
import { executionFailure, isFailureStatus } from "../execution-failure.js";
import { classifyStepOutcome, parseJsonStringArray } from "../model-mappers.js";
import { getProjectOr404 } from "../project-guards.js";

const TEXT = {
	origin: 2000,
	goal: 400,
	step: 350,
	fact: 500,
	finding: 700,
	hint: 600,
	route: 300,
};

function clip(value: string, limit: number, section: string, id: string): string {
	return value.length <= limit
		? value
		: `${value.slice(0, limit)}…[truncated; use get_graph({"view":"record","section":"${section}","id":"${id}"})]`;
}

function boundedUnknown(value: unknown, maxChars = 4000): unknown {
	const text = JSON.stringify(value);
	return text.length <= maxChars ? value : { truncated: true, chars: text.length };
}

function placeholders(values: readonly unknown[]): string {
	return values.map(() => "?").join(",");
}

export function factProjection(row: FactRow): Record<string, unknown> {
	return {
		id: row.id,
		description: clip(row.description, TEXT.fact, "facts", row.id),
		confidence: row.confidence,
		step_id: row.step_id,
	};
}

/**
 * 规划页只喂 pending 目标（见 readPendingGoals），而目标证据与达成描述只能在
 * achieve 时写入、写入后目标就不再是 pending —— 这两个字段在规划页里结构性
 * 不可能有值，故不再投影。
 */
function goalProjection(row: GoalRow): Record<string, unknown> {
	return {
		id: row.id,
		parent_goal_id: row.parent_goal_id,
		description: clip(row.description, TEXT.goal, "goals", row.id),
		status: row.status,
	};
}

function findingProjection(row: FindingRow): Record<string, unknown> {
	return {
		id: row.id,
		title: row.title,
		description: clip(row.description, TEXT.finding, "findings", row.id),
		fact_ids: JSON.parse(row.fact_ids) as string[],
		step_id: row.step_id,
	};
}

export function hintProjection(row: HintRow): Record<string, unknown> {
	return {
		id: row.id,
		content: clip(row.content, TEXT.hint, "hints", row.id),
		creator: row.creator,
	};
}

function readBenchmark(db: Db, projectId: string): unknown | undefined {
	const row = db
		.prepare(
			`SELECT unique_code, correct_flag_count, flag_count, is_completed,
			 container_status, container_addr, hint_used FROM benchmark_tasks WHERE project_id = ?`,
		)
		.get(projectId) as
		| {
				unique_code: string;
				correct_flag_count: number;
				flag_count: number;
				is_completed: number;
				container_status: string;
				container_addr: string;
				hint_used: number;
		  }
		| undefined;
	if (!row) return undefined;
	return {
		...row,
		is_completed: row.is_completed === 1,
		container_addr: JSON.parse(row.container_addr) as string[],
		hint_used: row.hint_used === 1,
	};
}

export function readProjectProjection(db: Db, projectId: string): Record<string, unknown> {
	const project = getProjectOr404(db, projectId);
	const origin = db
		.prepare("SELECT description FROM facts WHERE project_id = ? AND id = 'origin'")
		.get(projectId) as { description: string } | undefined;
	const goal = db
		.prepare("SELECT description FROM goals WHERE project_id = ? AND id = 'goal'")
		.get(projectId) as { description: string } | undefined;
	const benchmark = readBenchmark(db, projectId);
	return {
		status: project.status,
		origin: clip(origin?.description ?? "", TEXT.origin, "facts", "origin"),
		goal: clip(goal?.description ?? "", TEXT.goal, "goals", "goal"),
		finding_schema: boundedUnknown(
			project.finding_schema === null ? null : JSON.parse(project.finding_schema),
		),
		...(benchmark === undefined ? {} : { benchmark }),
	};
}

/**
 * 规划页只喂 pending 目标：完成证据与达成描述都在 achieve 时写入，写入后目标立即
 * 不再是 pending —— 这两个字段在规划页里结构性不可能有值（见 goalProjection）。
 */
export function readPendingGoals(db: Db, projectId: string): Array<Record<string, unknown>> {
	return (
		db
			.prepare(
				"SELECT * FROM goals WHERE project_id = ? AND status = 'pending' ORDER BY CASE WHEN id='goal' THEN 0 ELSE 1 END, LENGTH(id), id",
			)
			.all(projectId) as GoalRow[]
	).map((row) => goalProjection(row));
}

function compactResult(payload: string | undefined, stepId: string): unknown {
	if (payload === undefined) return null;
	const result = parseCommittedExecutionResultJson(payload);
	return {
		task_status: result.task_status,
		summary: clip(result.summary, 300, "steps", stepId),
		unresolved: result.unresolved.slice(0, 8).map((item) => item.slice(0, 300)),
		...(result.unresolved.length > 8 ? { omitted_unresolved: result.unresolved.length - 8 } : {}),
		produced: result.produced,
	};
}

export function readSteps(
	db: Db,
	projectId: string,
	where: string,
	args: unknown[] = [],
): Array<Record<string, unknown>> {
	const rows = db
		.prepare(
			`SELECT * FROM steps WHERE project_id = ? AND ${where}
			 ORDER BY priority DESC, created_at, LENGTH(id), id`,
		)
		.all(projectId, ...args) as StepRow[];
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);
	const sourceRows = db
		.prepare(
			`SELECT step_id, fact_id FROM step_sources WHERE project_id = ?
			 AND step_id IN (${placeholders(ids)}) ORDER BY rowid`,
		)
		.all(projectId, ...ids) as Array<{ step_id: string; fact_id: string }>;
	const sources = new Map<string, string[]>();
	for (const source of sourceRows) {
		const list = sources.get(source.step_id) ?? [];
		list.push(source.fact_id);
		sources.set(source.step_id, list);
	}
	const executionRows = db
		.prepare(
			`SELECT id, step_id, status, error, attempt FROM executions WHERE project_id = ?
			 AND step_id IN (${placeholders(ids)}) ORDER BY step_id, attempt`,
		)
		.all(projectId, ...ids) as Array<{
		id: string;
		step_id: string;
		status: string;
		error: string | null;
		attempt: number;
	}>;
	const stats = new Map<
		string,
		{ attempts: number; status: string; error: string | null; lastFailureId: string | null }
	>();
	for (const execution of executionRows) {
		const entry = stats.get(execution.step_id) ?? {
			attempts: 0,
			status: execution.status,
			error: execution.error,
			lastFailureId: null,
		};
		entry.attempts += 1;
		entry.status = execution.status;
		entry.error = execution.error;
		// ORDER BY attempt：最后一次赋值就是最高 attempt，因此这里留下的也是
		// 最近一次失败尝试。成功尝试不清空它——规划器关心的正是「上次为什么挂」。
		if (isFailureStatus(execution.status)) entry.lastFailureId = execution.id;
		stats.set(execution.step_id, entry);
	}
	// 步骤累计消耗（execute 活动）。与工作台 StepCost 同源同口径，一次 GROUP BY
	// 取回，避免规划器为判断「值不值得重试」再自己去翻用量。
	const usageRows = db
		.prepare(
			`SELECT step_id,
			        COUNT(*) AS executions,
			        COALESCE(SUM(input_tokens), 0) AS input_tokens,
			        COALESCE(SUM(output_tokens), 0) AS output_tokens,
			        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
			 FROM usage_events
			 WHERE project_id = ? AND activity = 'execute' AND step_id IN (${placeholders(ids)})
			 GROUP BY step_id`,
		)
		.all(projectId, ...ids) as Array<{
		step_id: string;
		executions: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_write_tokens: number;
	}>;
	const costs = new Map<string, StepCost>(
		usageRows.map((row) => [
			row.step_id,
			{
				executions: row.executions,
				input_tokens: row.input_tokens,
				output_tokens: row.output_tokens,
				cache_read_tokens: row.cache_read_tokens,
				cache_write_tokens: row.cache_write_tokens,
			},
		]),
	);
	const resultRows = db
		.prepare(
			`SELECT e.step_id, er.payload FROM executions e JOIN execution_results er ON er.execution_id=e.id
			 WHERE e.project_id = ? AND e.status='succeeded' AND e.step_id IN (${placeholders(ids)})
			 ORDER BY e.step_id, e.attempt`,
		)
		.all(projectId, ...ids) as Array<{ step_id: string; payload: string }>;
	const results = new Map(resultRows.map((row) => [row.step_id, row.payload]));
	return rows.map((row) => {
		const stat = stats.get(row.id);
		const result = compactResult(results.get(row.id), row.id);
		const summary = row.summary === null ? null : clip(row.summary, 300, "steps", row.id);
		const step: Record<string, unknown> = {
			id: row.id,
			description: clip(row.description, TEXT.step, "steps", row.id),
			status: row.status,
			priority: row.priority,
			from: sources.get(row.id) ?? [],
			waiting_on: parseJsonStringArray(row.waiting_on),
			goal_id: row.goal_id,
			route_id: row.route_id,
			attempts: stat?.attempts ?? 0,
			last_outcome: stat ? classifyStepOutcome(stat) : null,
			last_error: stat?.error?.slice(0, 200) ?? null,
		};
		// 失败归类按需物化（见 core/execution-failure.ts）：只在确有失败尝试时出现，
		// 成功步骤不带这个键，省下每步几十个字符的固定开销。
		const failure = stat?.lastFailureId == null ? null : executionFailure(db, stat.lastFailureId);
		if (failure !== null) {
			step.failure_class = failure.failure_class;
			step.failure_component = failure.component;
		}
		const cost = costs.get(row.id);
		if (cost !== undefined) step.cost = cost;
		if (result !== null) step.result = result;
		// 有结构化 result 时 steps.summary 就是 result.summary（收尾时由它写入），
		// 不再重复一遍；只有没有 result 的收尾（放弃、执行失联）才单独带上 summary。
		if (summary !== null && summary !== (result as { summary?: string } | null)?.summary)
			step.summary = summary;
		return step;
	});
}

export function readActiveRoutes(
	db: Db,
	projectId: string,
	worker: string,
	resultRouteIds: string[],
): Array<Record<string, unknown>> {
	return (
		db
			.prepare(
				`SELECT r.*, COALESCE(s.step_count,0) step_count,
				 COALESCE(s.open_step_count,0) open_step_count, COALESCE(s.concluded_step_count,0) concluded_step_count
				 FROM routes r LEFT JOIN (
				 SELECT route_id,COUNT(*) step_count,
				 SUM(status IN ('open','claimed')) open_step_count,SUM(status='concluded') concluded_step_count
				 FROM steps WHERE project_id=? GROUP BY route_id
				 ) s ON s.route_id=r.id
				 WHERE r.project_id=? AND (s.open_step_count>0 OR r.creator=?
				 OR r.created_at >= COALESCE((SELECT updated_at FROM decide_checkpoints WHERE project_id=?),'')
				 OR r.id IN (SELECT value FROM json_each(?))) ORDER BY LENGTH(r.id),r.id`,
			)
			.all(projectId, projectId, worker, projectId, JSON.stringify(resultRouteIds)) as Array<
			RouteRow & { step_count: number; open_step_count: number; concluded_step_count: number }
		>
	).map((row) => ({
		id: row.id,
		description: clip(row.description, TEXT.route, "routes", row.id),
		goal_id: row.goal_id,
		step_count: row.step_count,
		open_step_count: row.open_step_count,
		concluded_step_count: row.concluded_step_count,
	}));
}

export function selectRowsByIds<T>(db: Db, table: string, projectId: string, ids: string[]): T[] {
	if (ids.length === 0) return [];
	return db
		.prepare(`SELECT * FROM ${table} WHERE project_id=? AND id IN (${placeholders(ids)})`)
		.all(projectId, ...ids) as T[];
}

export function changeProjectionMaps(db: Db, projectId: string, changes: DecideChange[]) {
	const ids = (kind: DecideChange["kind"]) => [
		...new Set(changes.filter((c) => c.kind === kind && c.subject_id).map((c) => c.subject_id!)),
	];
	const facts = new Map(
		selectRowsByIds<FactRow>(db, "facts", projectId, ids("fact")).map((row) => [
			row.id,
			factProjection(row),
		]),
	);
	const goals = new Map(
		selectRowsByIds<GoalRow>(db, "goals", projectId, ids("goal")).map((row) => [
			row.id,
			goalProjection(row),
		]),
	);
	const findings = new Map(
		selectRowsByIds<FindingRow>(db, "findings", projectId, ids("finding")).map((row) => [
			row.id,
			findingProjection(row),
		]),
	);
	const hints = new Map(
		selectRowsByIds<HintRow>(db, "hints", projectId, ids("hint")).map((row) => [
			row.id,
			hintProjection(row),
		]),
	);
	const signalStepIds = [
		...new Set(
			changes.filter((c) => c.kind === "signal" && c.subject_id).map((c) => c.subject_id!),
		),
	];
	const steps = new Map(
		readSteps(
			db,
			projectId,
			signalStepIds.length ? `id IN (${placeholders(signalStepIds)})` : "0",
			signalStepIds,
		).map((row) => [String(row.id), row]),
	);
	return { facts, goals, findings, hints, steps };
}
