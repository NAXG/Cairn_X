import { UNHEALTHY_ERROR_MARKER, type ExecutionStatus } from "../../contracts/execution.js";
import { compareScopedIds } from "../../contracts/graph.js";
import type { ProjectStats, StepExecutionStats, UsageStats } from "../../contracts/stats.js";
import type { Db } from "../db.js";
import { utcnow } from "./base.js";
import { executionSeconds } from "./execution-duration.js";
import { projectExperimentMetadata } from "./experiment-metadata.js";
import { executionFailure } from "./execution-failure.js";
import { getProjectOr404 } from "./project-guards.js";
import { usageByActivity } from "./usage-aggregate.js";

const EXECUTION_STATUSES: ExecutionStatus[] = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"lost",
];

interface ExecutionStatsRow {
	id: string;
	step_id: string;
	attempt: number;
	status: ExecutionStatus;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	error: string | null;
	dropped_events: number;
}

interface UsageStatsRow {
	activity: string;
	events: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

interface CountRow {
	n: number;
}

function emptyUsage(): UsageStats {
	return {
		events: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		total_tokens: 0,
	};
}

function usageFromRow(row: UsageStatsRow | undefined): UsageStats {
	if (row === undefined) return emptyUsage();
	return {
		events: row.events,
		input_tokens: row.input_tokens,
		output_tokens: row.output_tokens,
		cache_read_tokens: row.cache_read_tokens,
		cache_write_tokens: row.cache_write_tokens,
		total_tokens: row.input_tokens + row.output_tokens,
	};
}

function addUsage(a: UsageStats, b: UsageStats): UsageStats {
	return {
		events: a.events + b.events,
		input_tokens: a.input_tokens + b.input_tokens,
		output_tokens: a.output_tokens + b.output_tokens,
		cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
		cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
		total_tokens: a.total_tokens + b.total_tokens,
	};
}

function round(value: number, digits = 2): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/** 最近秩百分位；空数组返回 null。 */
function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return round(sorted[index], 1);
}

export function buildProjectStats(db: Db, projectId: string): ProjectStats {
	const project = getProjectOr404(db, projectId);

	const executions = db
		.prepare(
			`SELECT id, step_id, attempt, status, created_at, started_at, finished_at, error, dropped_events
 FROM executions WHERE project_id = ? ORDER BY step_id, attempt`,
		)
		.all(projectId) as ExecutionStatsRow[];
	const classifiedFailures = executions
		.filter((row) => row.status === "failed")
		.map((row) => ({ row, failure: executionFailure(db, row.id) }));

	const byStatus = Object.fromEntries(EXECUTION_STATUSES.map((status) => [status, 0])) as Record<
		ExecutionStatus,
		number
	>;
	const byStep = Map.groupBy(executions, (execution) => execution.step_id);
	const durations: number[] = [];
	for (const execution of executions) {
		byStatus[execution.status] += 1;
		const duration = executionSeconds(execution);
		if (duration != null) durations.push(duration);
	}

	const stepStats: StepExecutionStats[] = [...byStep.entries()]
		.map(([stepId, rows]) => {
			const stepDurations = rows
				.map((row) => executionSeconds(row))
				.filter((value): value is number => value != null);
			const statusCount = (status: ExecutionStatus) =>
				rows.filter((row) => row.status === status).length;
			return {
				step_id: stepId,
				executions: rows.length,
				max_attempt: rows.reduce((max, row) => Math.max(max, row.attempt), 0),
				succeeded: statusCount("succeeded"),
				failed: statusCount("failed"),
				cancelled: statusCount("cancelled"),
				lost: statusCount("lost"),
				avg_seconds:
					stepDurations.length === 0
						? null
						: round(stepDurations.reduce((sum, value) => sum + value, 0) / stepDurations.length, 1),
				p95_seconds: percentile(stepDurations, 0.95),
			};
		})
		.sort((a, b) => compareScopedIds(a.step_id, b.step_id));

	const usageRows: UsageStatsRow[] = usageByActivity(db, projectId);
	const decide = usageFromRow(usageRows.find((row) => row.activity === "decide"));
	const execute = usageFromRow(usageRows.find((row) => row.activity === "execute"));
	const totalUsage = addUsage(decide, execute);

	const facts = (
		db.prepare("SELECT COUNT(*) AS n FROM facts WHERE project_id = ?").get(projectId) as CountRow
	).n;
	const findings = (
		db.prepare("SELECT COUNT(*) AS n FROM findings WHERE project_id = ?").get(projectId) as CountRow
	).n;
	const distinctSteps = stepStats.length;
	const totalExecutions = executions.length;

	const benchmarkRow = db
		.prepare(
			`SELECT COUNT(*) AS tasks,
        COALESCE(SUM(flag_count), 0) AS flags_total,
        COALESCE(SUM(correct_flag_count), 0) AS flags_correct,
        COALESCE(SUM(hint_used), 0) AS hint_used,
        COALESCE(SUM(is_completed), 0) AS completed
 FROM benchmark_tasks WHERE project_id = ?`,
		)
		.get(projectId) as {
		tasks: number;
		flags_total: number;
		flags_correct: number;
		hint_used: number;
		completed: number;
	};

	const experiment = projectExperimentMetadata(db, project);

	return {
		experiment,
		project_id: projectId,
		generated_at: utcnow(),
		executions: {
			total: totalExecutions,
			by_status: byStatus,
			avg_attempts: distinctSteps === 0 ? 0 : round(totalExecutions / distinctSteps, 2),
			p95_seconds: percentile(durations, 0.95),
			dropped_events: executions.reduce((sum, row) => sum + row.dropped_events, 0),
			by_step: stepStats,
		},
		usage: { decide, execute, total: totalUsage },
		yield: {
			facts,
			findings,
			facts_per_execution: totalExecutions === 0 ? 0 : round(facts / totalExecutions, 2),
			findings_per_execution: totalExecutions === 0 ? 0 : round(findings / totalExecutions, 2),
			tokens_per_fact: facts === 0 ? null : round(totalUsage.total_tokens / facts, 1),
		},
		reliability: {
			lost: byStatus.lost,
			cancelled: byStatus.cancelled,
			failed: byStatus.failed,
			timeout_failures: classifiedFailures.filter(
				({ failure }) =>
					failure?.failure_class === "execution_timeout" ||
					failure?.failure_class === "tool_timeout",
			).length,
			unhealthy_failures: classifiedFailures.filter(({ row }) =>
				row.error?.includes(UNHEALTHY_ERROR_MARKER),
			).length,
			lease_failures: classifiedFailures.filter(
				({ failure }) => failure?.failure_class === "lease_failure",
			).length,
		},
		benchmark:
			benchmarkRow.tasks === 0
				? null
				: {
						tasks: benchmarkRow.tasks,
						flags_total: benchmarkRow.flags_total,
						flags_correct: benchmarkRow.flags_correct,
						completion_ratio:
							benchmarkRow.flags_total === 0
								? 0
								: round(benchmarkRow.flags_correct / benchmarkRow.flags_total, 3),
						hint_used: benchmarkRow.hint_used,
						completed: benchmarkRow.completed,
					},
	};
}
