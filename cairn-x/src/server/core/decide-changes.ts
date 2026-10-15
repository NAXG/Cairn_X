import type { Db } from "../db.js";

export const ESCALATION_DETAIL_PREFIX = "escalated:";
const ESCALATION_REASON_PREVIEW_CHARS = 500;

/** 升级信号的可见摘要；decide_changes.detail 保留完整理由供去重，普通信号不变。 */
export function decideSignalPreview(detail: string | null, operation: string): string | null {
	return operation === "escalate" && detail?.startsWith(ESCALATION_DETAIL_PREFIX)
		? detail.slice(0, ESCALATION_DETAIL_PREFIX.length + ESCALATION_REASON_PREVIEW_CHARS)
		: detail;
}

/** 只记录会唤醒规划的输入变更，不是完整图谱的事件溯源库。 */
interface DecideRead {
	observed_seq: number;
	last_fact_id: string | null;
	coverage_complete?: number;
	next_cursor?: string | null;
	cursor_state?: string | null;
}

export interface DecideChange {
	seq: number;
	kind: "fact" | "finding" | "hint" | "goal" | "signal";
	actor: string | null;
	detail: string | null;
	subject_id: string | null;
	operation: string;
}

export function latestDecideChange(db: Db, projectId: string): number {
	return (
		db
			.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM decide_changes WHERE project_id = ?")
			.get(projectId) as { seq: number }
	).seq;
}

/** 调用方已验证身份；仅包住同步图写入，不包住租约回收等外部变化。 */
export function withDecideChanges<T>(
	db: Db,
	projectId: string,
	worker: string | null | undefined,
	write: () => T,
): T {
	return db.transaction(() => {
		const before = latestDecideChange(db, projectId);
		const result = write();
		if (worker) {
			db.prepare(
				"UPDATE decide_changes SET actor = ? WHERE project_id = ? AND seq > ? AND actor IS NULL",
			).run(worker, projectId, before);
		}
		return result;
	})();
}

export function saveDecideRead(db: Db, projectId: string, worker: string, read: DecideRead): void {
	db.prepare(
		`INSERT INTO decide_reads
		 (project_id, worker, observed_seq, last_fact_id, coverage_complete, next_cursor, cursor_state)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET worker = excluded.worker,
		 observed_seq = excluded.observed_seq, last_fact_id = excluded.last_fact_id,
		 coverage_complete = excluded.coverage_complete,
		 next_cursor = excluded.next_cursor, cursor_state = excluded.cursor_state`,
	).run(
		projectId,
		worker,
		read.observed_seq,
		read.last_fact_id,
		read.coverage_complete ?? 0,
		read.next_cursor ?? null,
		read.cursor_state ?? null,
	);
}

export function getDecideRead(db: Db, projectId: string, worker: string): DecideRead | undefined {
	return db
		.prepare(
			`SELECT observed_seq, last_fact_id, coverage_complete, next_cursor, cursor_state
			 FROM decide_reads WHERE project_id = ? AND worker = ?`,
		)
		.get(projectId, worker) as DecideRead | undefined;
}

export function pendingDetailedDecideChanges(
	db: Db,
	projectId: string,
	afterSeq: number,
	throughSeq: number,
	ownWorker: string | null,
): DecideChange[] {
	const rows = db
		.prepare(
			`SELECT seq, kind, actor, detail, subject_id, operation FROM decide_changes
			 WHERE project_id = ? AND seq > ? AND seq <= ? AND (actor IS NULL OR actor <> ?)
			 ORDER BY seq`,
		)
		.all(projectId, afterSeq, throughSeq, ownWorker ?? "") as DecideChange[];
	return rows.map((row) => ({
		...row,
		detail: row.kind === "signal" ? decideSignalPreview(row.detail, row.operation) : row.detail,
	}));
}

export function pendingDecideChanges(
	db: Db,
	projectId: string,
	observedSeq: number,
	ownWorker: string | null,
): Array<{ kind: string; count: number }> {
	return db
		.prepare(
			`SELECT kind, COUNT(*) AS count FROM decide_changes
		 WHERE project_id = ? AND seq > ? AND (actor IS NULL OR actor <> ?)
		 GROUP BY kind`,
		)
		.all(projectId, observedSeq, ownWorker ?? "") as Array<{ kind: string; count: number }>;
}

export function pendingDecideSignals(
	db: Db,
	projectId: string,
	observedSeq: number,
	ownWorker: string | null,
): Array<{ seq: number; detail: string | null }> {
	const rows = db
		.prepare(
			`SELECT seq, detail, operation FROM decide_changes WHERE project_id = ? AND seq > ?
		 AND kind = 'signal' AND (actor IS NULL OR actor <> ?) ORDER BY seq`,
		)
		.all(projectId, observedSeq, ownWorker ?? "") as Array<{
		seq: number;
		detail: string | null;
		operation: string;
	}>;
	return rows.map(({ seq, detail, operation }) => ({
		seq,
		detail: decideSignalPreview(detail, operation),
	}));
}
