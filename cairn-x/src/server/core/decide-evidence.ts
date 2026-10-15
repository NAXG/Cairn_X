import { createHash } from "node:crypto";
import type { ReadEvidenceInput } from "../../contracts/decide-tools.js";
import type { Db } from "../db.js";
import { ApiError } from "./base.js";
import { listEvidenceRefs } from "./evidence.js";
import { readTraceRequest, EVIDENCE_CONTEXT_ENTRY_BYTES } from "./event-search.js";
import { requireDecideLease } from "./project-guards.js";

/** Lease and all material are checked in the caller's read transaction. */
export function readDecideEvidence(
	db: Db,
	projectId: string,
	worker: string,
	input: ReadEvidenceInput,
) {
	requireDecideLease(db, projectId, worker);
	const table = input.type === "fact" ? "facts" : "findings";
	if (!db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND id=?`).get(projectId, input.id))
		throw new ApiError(404, "Evidence subject not found");
	const refs = listEvidenceRefs(db, projectId, input.type, input.id);
	const index = input.ref_index ?? 0;
	const base = { type: input.type, id: input.id, evidence_count: refs.length };
	if (refs.length === 0) {
		if (index !== 0 || (input.offset ?? 0) !== 0 || input.revision !== undefined)
			throw new ApiError(400, "No associated evidence reference to continue");
		return { ...base, status: "no_references" as const, next_ref_index: null };
	}
	const ref = refs[index];
	if (!ref) throw new ApiError(400, "Evidence ref_index is out of range");
	// Explicit project scoping, even if an offline writer inserted a corrupt reference.
	const row = db
		.prepare(
			`SELECT ee.line FROM execution_events ee JOIN executions e ON e.id=ee.execution_id
		WHERE e.project_id=? AND ee.execution_id=? AND ee.seq=?`,
		)
		.get(projectId, ref.execution_id, ref.seq) as { line: string } | undefined;
	if (!row) throw new ApiError(404, "Evidence event not found in this project");
	const revision = createHash("sha256").update(JSON.stringify(ref)).update(row.line).digest("hex");
	if ((input.offset ?? 0) > 0 && input.revision === undefined)
		throw new ApiError(400, "revision is required when offset is greater than zero");
	if (input.revision !== undefined && input.revision !== revision)
		throw new ApiError(409, "Evidence changed; restart this reference at offset 0");
	const event = readTraceRequest(db, projectId, ref.execution_id, (name) =>
		name === "event_seq"
			? String(ref.seq)
			: name === "offset"
				? String(input.offset ?? 0)
				: undefined,
	);
	const context =
		(input.offset ?? 0) === 0
			? readTraceRequest(
					db,
					projectId,
					ref.execution_id,
					(name) =>
						name === "after_seq"
							? String(Math.max(0, ref.seq - 3))
							: name === "limit"
								? "3"
								: undefined,
					{ pageBytes: 8000, entryBytes: EVIDENCE_CONTEXT_ENTRY_BYTES, skipInvalid: true },
				)
			: undefined;
	return {
		...base,
		status: "available" as const,
		ref_index: index,
		ref,
		revision,
		event,
		...(context && "entries" in context
			? { context: context.entries.filter((entry) => entry.seq < ref.seq) }
			: {}),
		next_ref_index: index + 1 < refs.length ? index + 1 : null,
	};
}
