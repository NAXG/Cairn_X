import { sanitizeActivityId } from "../../control/store.js";
import type { Db } from "../db.js";
import type { ActivityRecord, SessionSummary } from "../../contracts/transcripts.js";
import type { ReadPage } from "../../contracts/workbench.js";
import { listExecutionSummaries } from "./execution-summaries.js";
import { nextCursor, pageCursor, pageScope } from "./workbench.js";
import { ApiError } from "./base.js";

export function activityPage(
	db: Db,
	pid: string,
	limit: number,
	cursor?: string,
	kind = "all",
	step = "",
): ReadPage<ActivityRecord> {
	if (!["all", "decide", "execute"].includes(kind))
		throw new ApiError(400, "Invalid activity kind");
	const scope = pageScope(pid, "activities", { kind, step });
	const after = pageCursor(cursor, scope);
	const rows = db
		.prepare(
			`WITH records AS (
	 SELECT 'e:'||id key,'execute' kind,created_at sort_at,COALESCE(finished_at,started_at,created_at) at,id execution_id,NULL file,step_id FROM executions WHERE project_id=@pid
	 UNION ALL
	 SELECT 's:'||s.file,s.activity,s.sort_at,s.modified_at,NULL,s.file,NULL FROM workbench_sessions s WHERE s.project_id=@pid
	 AND NOT EXISTS(SELECT 1 FROM executions e WHERE e.project_id=s.project_id AND e.step_id=s.step_id AND e.attempt=s.attempt)
	 ) SELECT * FROM records WHERE (@kind='all' OR kind=@kind) AND (@step='' OR kind='decide' OR step_id=@step)
	 ${after ? "AND (sort_at<@at OR (sort_at=@at AND key<@key))" : ""} ORDER BY sort_at DESC,key DESC LIMIT @limit`,
		)
		.all({
			pid,
			kind,
			step,
			...(after ? { at: after.at, key: after.key } : {}),
			limit: limit + 1,
		}) as Array<{
		key: string;
		kind: "execute" | "decide";
		sort_at: string;
		at: string;
		execution_id: string | null;
		file: string | null;
	}>;
	const selected = rows.slice(0, limit);
	const executions = new Map(
		listExecutionSummaries(
			db,
			pid,
			selected.flatMap((r) => (r.execution_id ? [r.execution_id] : [])),
			true,
		).map((e) => [e.id, e]),
	);
	const interruptedFiles = new Set(
		(
			db
				.prepare(
					"SELECT actor FROM decide_changes WHERE project_id=? AND kind='signal' AND detail='decide_interrupted' AND actor IS NOT NULL",
				)
				.all(pid) as Array<{ actor: string }>
		).map((r) => `decide-${sanitizeActivityId(r.actor)}.jsonl`),
	);
	const session = (
		file?: string,
		stepId?: string,
		attempt?: number,
	): SessionSummary | undefined => {
		const row = file
			? db.prepare("SELECT * FROM workbench_sessions WHERE project_id=? AND file=?").get(pid, file)
			: db
					.prepare(
						"SELECT * FROM workbench_sessions WHERE project_id=? AND step_id=? AND attempt=? ORDER BY modified_at DESC,file DESC LIMIT 1",
					)
					.get(pid, stepId!, attempt!);
		if (!row) return undefined;
		const s = row as {
			file: string;
			activity: "decide" | "execute";
			bytes: number;
			modified_at: string;
			entries: number;
			retry: number;
		};
		const interrupted = interruptedFiles.has(s.file);
		return {
			file: s.file,
			activity: s.activity,
			bytes: s.bytes,
			modified_at: s.modified_at,
			entries: s.entries,
			...(s.retry ? { retry: true } : {}),
			...(interrupted ? { interrupted: true } : {}),
		};
	};
	const items = selected.map((r) => {
		const e = r.execution_id ? executions.get(r.execution_id) : undefined;
		const s = session(r.file ?? undefined, e?.step_id, e?.attempt);
		return {
			key: r.key,
			kind: r.kind,
			at: r.at,
			...(e ? { execution: e } : {}),
			...(s ? { session: s } : {}),
		};
	});
	const last = selected.at(-1);
	return {
		items,
		next_cursor: rows.length > limit && last ? nextCursor(last.sort_at, last.key, scope) : null,
	};
}
