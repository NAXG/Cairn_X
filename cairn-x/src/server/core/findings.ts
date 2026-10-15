import { Ajv, type ErrorObject } from "ajv";
import type { Db, FindingRow } from "../db.js";
import type { EvidenceRef } from "../../contracts/evidence.js";
import { addEvidenceRefs, validateEvidenceRefs } from "./evidence.js";
import { ApiError, utcnow } from "./base.js";
import { nextFindingId } from "./ids.js";
import { checkProjectActive, validateFactsExist } from "./project-guards.js";
import { findingToModel } from "./model-mappers.js";

const ajv = new Ajv({ allErrors: true, strict: false });

/** 按 project 缓存编译后的 schema 校验器：schema 文本未变则不重新编译。 */
const findingSchemaCache = new Map<string, { raw: string; validate: ReturnType<Ajv["compile"]> }>();

function getFindingValidator(pid: string, rawSchema: string): ReturnType<Ajv["compile"]> {
	const cached = findingSchemaCache.get(pid);
	if (cached && cached.raw === rawSchema) {
		return cached.validate;
	}
	const validate = ajv.compile(JSON.parse(rawSchema) as object);
	findingSchemaCache.set(pid, { raw: rawSchema, validate });
	return validate;
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
	const lines = (errors ?? []).slice(0, 5).map((e) => `data${e.instancePath || ""} ${e.message}`);
	return lines.join("; ");
}

function validateFindingData(pid: string, rawSchema: string | null, data: unknown): void {
	if (rawSchema !== null && rawSchema.trim() !== "null") {
		if (data === undefined)
			throw new ApiError(400, "finding data is required by the project schema; supply data_json");
		let validate: ReturnType<Ajv["compile"]>;
		try {
			validate = getFindingValidator(pid, rawSchema);
		} catch {
			throw new ApiError(500, "Project finding schema is not valid JSON");
		}
		if (!validate(data)) {
			throw new ApiError(
				400,
				`finding data does not match the project schema: ${formatSchemaErrors(validate.errors)}`,
			);
		}
	}
}

interface FindingInput {
	title: string;
	description: string;
	data?: unknown;
	fact_ids?: string[] | null;
	step_id?: string | null;
	execution_id?: string | null;
	client_event_id?: string | null;
	/** 原始资料证据引用（已落盘事件）；随 Finding 同事务写入。 */
	evidence?: EvidenceRef[] | null;
}

export function createFinding(
	db: Db,
	projectId: string,
	body: FindingInput,
	options: { authorize: () => void },
) {
	options.authorize();
	const project = checkProjectActive(db, projectId);
	const factIds = body.fact_ids ?? [];
	validateFactsExist(db, projectId, factIds);
	// 先校验请求载荷：无效请求不烧 ID。
	validateFindingData(projectId, project.finding_schema, body.data);
	if (body.evidence?.length) validateEvidenceRefs(db, projectId, body.evidence);
	const findExisting = () =>
		body.client_event_id === undefined
			? undefined
			: (db
					.prepare("SELECT * FROM findings WHERE project_id = ? AND client_event_id = ?")
					.get(projectId, body.client_event_id) as FindingRow | undefined);
	const data = body.data;
	return db
		.transaction(() => {
			// 事务开始前租约或项目状态可能改变，提交前重新验证。
			options.authorize();
			checkProjectActive(db, projectId);
			// 幂等重传检查必须先于 ID 分配：重试不得烧 ID。
			const existing = findExisting();
			if (existing) return { model: findingToModel(db, existing), duplicate: true };
			const id = nextFindingId(db, projectId);
			db.prepare(
				"INSERT INTO findings (id, project_id, title, description, data, fact_ids, step_id, execution_id, client_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				id,
				projectId,
				body.title,
				body.description,
				data === undefined ? null : JSON.stringify(data),
				JSON.stringify(factIds),
				body.step_id ?? null,
				body.execution_id ?? null,
				body.client_event_id ?? null,
				utcnow(),
			);
			addEvidenceRefs(db, projectId, "finding", id, body.evidence);
			const row = db
				.prepare("SELECT * FROM findings WHERE project_id = ? AND id = ?")
				.get(projectId, id) as FindingRow;
			return { model: findingToModel(db, row), duplicate: false };
		})
		.immediate();
}
