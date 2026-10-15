/**
 * 证据引用的写入与读取服务（阶段二）。
 *
 * 校验规则：
 * - event 引用：execution 属于同一项目，且 (execution_id, seq) 已落盘。
 * - subject 必须存在且类型正确；所有写入在调用方事务内完成。
 */

import type { Db } from "../db.js";
import {
	evidenceRefKey,
	typedRefKey,
	type EvidenceRef,
	type TypedEvidenceRef,
} from "../../contracts/evidence.js";
import { ApiError, utcnow } from "./base.js";

interface EvidenceRefRow {
	execution_id: string;
	event_seq: number;
}

function validateTypedEvidence(db: Db, projectId: string, refs: TypedEvidenceRef[]): void {
	for (const ref of refs) {
		const table = ref.type === "fact" ? "facts" : "findings";
		const row = db
			.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND project_id = ?`)
			.get(ref.id, projectId);
		if (row === undefined) {
			throw new ApiError(404, `${ref.type === "fact" ? "Fact" : "Finding"} ${ref.id} not found`);
		}
	}
}

function validateEvidenceRef(db: Db, projectId: string, ref: EvidenceRef): void {
	const execution = db
		.prepare("SELECT 1 AS ok FROM executions WHERE id = ? AND project_id = ?")
		.get(ref.execution_id, projectId);
	if (execution === undefined) {
		throw new ApiError(404, `Execution ${ref.execution_id} not found`);
	}
	// 事件必须已落盘：未持久化的 seq（含超出当前游标的未来序号）一律拒绝。
	const event = db
		.prepare("SELECT 1 AS ok FROM execution_events WHERE execution_id = ? AND seq = ?")
		.get(ref.execution_id, ref.seq);
	if (event === undefined) {
		throw new ApiError(404, `Event ${ref.execution_id}#${ref.seq} not found`);
	}
}

export function validateEvidenceRefs(db: Db, projectId: string, refs: EvidenceRef[]): void {
	for (const ref of refs) validateEvidenceRef(db, projectId, ref);
}

/** 在调用方事务内为 Fact/Finding 写入证据引用；重复引用幂等去重。 */
export function addEvidenceRefs(
	db: Db,
	projectId: string,
	subjectType: "fact" | "finding",
	subjectId: string,
	refs: EvidenceRef[] | undefined | null,
): void {
	if (!refs?.length) return;
	const insert = db.prepare(
		`INSERT OR IGNORE INTO evidence_refs
		 (project_id, subject_type, subject_id, ref_key, execution_id, event_seq, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const now = utcnow();
	for (const ref of refs) {
		validateEvidenceRef(db, projectId, ref);
		insert.run(
			projectId,
			subjectType,
			subjectId,
			evidenceRefKey(ref),
			ref.execution_id,
			ref.seq,
			now,
		);
	}
}

function evidenceFromRow(r: EvidenceRefRow): EvidenceRef {
	return { kind: "event", execution_id: r.execution_id, seq: r.event_seq };
}

export function listEvidenceRefs(
	db: Db,
	projectId: string,
	subjectType: "fact" | "finding",
	subjectId: string,
): EvidenceRef[] {
	const rows = db
		.prepare(
			`SELECT execution_id, event_seq FROM evidence_refs
			 WHERE project_id = ? AND subject_type = ? AND subject_id = ? ORDER BY rowid`,
		)
		.all(projectId, subjectType, subjectId) as EvidenceRefRow[];
	return rows.map(evidenceFromRow);
}

export function listGoalEvidence(db: Db, projectId: string, goalId: string): TypedEvidenceRef[] {
	const rows = db
		.prepare(
			`SELECT evidence_type, evidence_id FROM goal_evidence
			 WHERE project_id = ? AND goal_id = ? ORDER BY rowid`,
		)
		.all(projectId, goalId) as Array<{ evidence_type: "fact" | "finding"; evidence_id: string }>;
	return rows.map((r) => ({ type: r.evidence_type, id: r.evidence_id }));
}

/** 在调用方事务内写入 Goal 完成证据（goal_evidence 是该关系的唯一存储）。 */
export function setGoalEvidence(
	db: Db,
	projectId: string,
	goalId: string,
	refs: TypedEvidenceRef[],
): void {
	validateTypedEvidence(db, projectId, refs);
	const insert = db.prepare(
		"INSERT OR IGNORE INTO goal_evidence (project_id, goal_id, evidence_type, evidence_id, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	const now = utcnow();
	for (const ref of refs) {
		insert.run(projectId, goalId, ref.type, ref.id, now);
	}
}

/** 幂等确认判定：证据集合与完成理由完全一致（证据顺序无关）。 */
export function sameGoalEvidence(
	a: TypedEvidenceRef[],
	descriptionA: string | null,
	b: TypedEvidenceRef[],
	descriptionB: string | null,
): boolean {
	if (descriptionA !== descriptionB) return false;
	const keys = (refs: TypedEvidenceRef[]) => [...new Set(refs.map(typedRefKey))].sort();
	const ka = keys(a);
	const kb = keys(b);
	return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** Load project evidence once for bulk graph/model reads; preserve insertion order. */
