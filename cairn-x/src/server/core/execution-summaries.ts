import type { ExecutionSummary } from "../../contracts/transcripts.js";
import { isAutoInconclusiveError } from "../../contracts/execution.js";
import type { Db } from "../db.js";

/** 执行列表同时给出协议状态与业务验收结论，避免将 inconclusive 显示成成功。 */
export function listExecutionSummaries(
	db: Db,
	projectId: string,
	ids: string[],
	preview = false,
): ExecutionSummary[] {
	if (ids.length === 0) return [];
	const rows = db
		.prepare(
			`SELECT e.id, e.step_id, e.attempt, e.status, e.created_at, e.started_at,
			        e.finished_at, ${preview ? "substr(e.summary,1,400)" : "e.summary"} AS summary, ${preview ? "substr(e.error,1,400)" : "e.error"} AS error,
			        json_extract(r.payload, '$.task_status') AS task_status
			 FROM executions e
			 LEFT JOIN execution_results r ON r.execution_id = e.id
			 WHERE e.project_id = ? AND e.id IN (SELECT value FROM json_each(?)) ORDER BY e.step_id, e.attempt`,
		)
		.all(projectId, JSON.stringify(ids)) as Array<Omit<ExecutionSummary, "auto_inconclusive">>;
	return rows.map((row) => ({
		...row,
		auto_inconclusive:
			row.status === "succeeded" &&
			row.task_status === "inconclusive" &&
			isAutoInconclusiveError(row.error),
	}));
}
