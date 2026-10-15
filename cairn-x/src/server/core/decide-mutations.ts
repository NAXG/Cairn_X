import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { ApiError, utcnow } from "./base.js";
import { getProjectOr404 } from "./project-guards.js";

import { canonicalMutation } from "../../shared/mutation-key.js";

/** Caller wraps this and create() in one write transaction. Replays are read-only. */
export function replayDecideCreation<T>(
	db: Db,
	projectId: string,
	worker: string | undefined,
	requestId: string | undefined,
	operation: string,
	body: unknown,
	create: () => T,
): { data: T; replayed: boolean } {
	if (requestId === undefined) return { data: create(), replayed: false };
	if (!worker) throw new ApiError(400, "request_id requires a Decide worker");
	getProjectOr404(db, projectId);
	const hash = createHash("sha256").update(canonicalMutation(body)).digest("hex");
	const stored = db
		.prepare(
			`SELECT request_hash, response_json FROM decide_mutations
		WHERE project_id=? AND worker=? AND operation=? AND request_id=?`,
		)
		.get(projectId, worker, operation, requestId) as
		{ request_hash: string; response_json: string } | undefined;
	if (stored) {
		if (stored.request_hash !== hash)
			throw new ApiError(409, "request_id already belongs to a different mutation");
		return { data: JSON.parse(stored.response_json) as T, replayed: true };
	}
	const response = create();
	db.prepare(
		`INSERT INTO decide_mutations
		(project_id,worker,operation,request_id,request_hash,response_json,created_at) VALUES(?,?,?,?,?,?,?)`,
	).run(projectId, worker, operation, requestId, hash, JSON.stringify(response), utcnow());
	return { data: response, replayed: false };
}
