import type { Db, FactRow } from "../db.js";
import type { EvidenceRef } from "../../contracts/evidence.js";
import { addEvidenceRefs } from "./evidence.js";
import { ApiError, utcnow } from "./base.js";
import { nextFactId } from "./ids.js";
import { checkProjectActive } from "./project-guards.js";
import { factToModel } from "./model-mappers.js";
import type { FactContent } from "../../contracts/facts.js";

interface FactInput extends FactContent {
	step_id?: string | null;
	execution_id?: string | null;
	client_event_id?: string | null;
	/** 原始资料证据引用（execution 事件）；随 Fact 同事务写入。 */
	evidence?: EvidenceRef[] | null;
}

/** 鉴权由入口完成；幂等检查、ID 分配和写入在同一事务中完成。 */
export function createFact(db: Db, projectId: string, body: FactInput) {
	return db
		.transaction(() => {
			checkProjectActive(db, projectId);
			if (body.client_event_id) {
				const existing = db
					.prepare("SELECT * FROM facts WHERE project_id = ? AND client_event_id = ?")
					.get(projectId, body.client_event_id) as FactRow | undefined;
				if (existing) {
					if (
						existing.execution_id !== (body.execution_id ?? null) ||
						existing.step_id !== (body.step_id ?? null)
					) {
						throw new ApiError(409, "client_event_id already belongs to a different fact source");
					}
					return { model: factToModel(db, existing), duplicate: true };
				}
			}
			const id = nextFactId(db, projectId);
			db.prepare(
				"INSERT INTO facts (id, project_id, description, confidence, step_id, execution_id, client_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				id,
				projectId,
				body.description,
				body.confidence,
				body.step_id ?? null,
				body.execution_id ?? null,
				body.client_event_id ?? null,
				utcnow(),
			);
			addEvidenceRefs(db, projectId, "fact", id, body.evidence);
			const row = db
				.prepare("SELECT * FROM facts WHERE project_id = ? AND id = ?")
				.get(projectId, id) as FactRow;
			return { model: factToModel(db, row), duplicate: false };
		})
		.immediate();
}
