import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import { GRAPH_PAGE_MAX_CHARS } from "../../../contracts/graph.js";
import {
	PLANNING_GRAPH_SCHEMA_VERSION,
	type GraphRecordPageV2,
	type GraphRecordSection,
	type PlanningGraphRequest,
} from "../../../contracts/planning-graph.js";
import type { Db, FactRow, FindingRow, GoalRow, HintRow, RouteRow, StepRow } from "../../db.js";
import { ApiError } from "../base.js";
import {
	factToModel,
	findingToModel,
	goalToModel,
	projectMetaFromRow,
	routeToModel,
	stepToModel,
} from "../model-mappers.js";
import { getProjectOr404 } from "../project-guards.js";

function usageRecord(db: Db, projectId: string): unknown {
	return db
		.prepare(
			`SELECT activity, COUNT(*) events, COALESCE(SUM(input_tokens),0) input_tokens,
			 COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,
			 COALESCE(SUM(cache_write_tokens),0) cache_write_tokens
			 FROM usage_events WHERE project_id=? GROUP BY activity`,
		)
		.all(projectId);
}

function directRecord(db: Db, projectId: string, section: GraphRecordSection, id: string): unknown {
	getProjectOr404(db, projectId);
	if (section === "project") {
		if (id !== "project") throw new ApiError(404, "Graph record not found");
		return projectMetaFromRow(getProjectOr404(db, projectId));
	}
	if (section === "usage") {
		if (id !== "usage") throw new ApiError(404, "Graph record not found");
		return { id: "usage", rows: usageRecord(db, projectId) };
	}
	if (section === "facts") {
		const row = db.prepare("SELECT * FROM facts WHERE project_id=? AND id=?").get(projectId, id) as
			FactRow | undefined;
		if (!row) throw new ApiError(404, "Graph record not found");
		return factToModel(db, row);
	}
	if (section === "goals") {
		const row = db.prepare("SELECT * FROM goals WHERE project_id=? AND id=?").get(projectId, id) as
			GoalRow | undefined;
		if (!row) throw new ApiError(404, "Graph record not found");
		return goalToModel(db, row);
	}
	if (section === "steps") {
		const row = db.prepare("SELECT * FROM steps WHERE project_id=? AND id=?").get(projectId, id) as
			StepRow | undefined;
		if (!row) throw new ApiError(404, "Graph record not found");
		return stepToModel(db, row, projectId);
	}
	if (section === "hints") {
		const row = db.prepare("SELECT * FROM hints WHERE project_id=? AND id=?").get(projectId, id) as
			HintRow | undefined;
		if (!row) throw new ApiError(404, "Graph record not found");
		return {
			id: row.id,
			content: row.content,
			creator: row.creator,
			created_at: row.created_at,
			persistent: !!db
				.prepare("SELECT 1 FROM persistent_hints WHERE project_id=? AND hint_id=?")
				.get(projectId, id),
		};
	}
	if (section === "findings") {
		const row = db
			.prepare("SELECT * FROM findings WHERE project_id=? AND id=?")
			.get(projectId, id) as FindingRow | undefined;
		if (!row) throw new ApiError(404, "Graph record not found");
		return findingToModel(db, row);
	}
	const row = db.prepare("SELECT * FROM routes WHERE project_id=? AND id=?").get(projectId, id) as
		RouteRow | undefined;
	if (!row) throw new ApiError(404, "Graph record not found");
	const stats = db
		.prepare(
			`SELECT COUNT(*) step_count,
			 SUM(CASE WHEN status IN ('open','claimed') THEN 1 ELSE 0 END) open_step_count,
			 SUM(CASE WHEN status='concluded' THEN 1 ELSE 0 END) concluded_step_count
			 FROM steps WHERE project_id=? AND route_id=?`,
		)
		.get(projectId, id) as {
		step_count: number;
		open_step_count: number;
		concluded_step_count: number;
	};
	return routeToModel(row, stats);
}

export function readGraphRecord(
	db: Db,
	projectId: string,
	request: Extract<PlanningGraphRequest, { view: "record" }>,
): GraphRecordPageV2 {
	const record = directRecord(db, projectId, request.section, request.id);
	const raw = JSON.stringify(record);
	const revision = createHash("sha256").update(raw).digest("hex");
	if (request.revision !== undefined && request.revision !== revision)
		throw new ApiError(409, "Graph record changed; restart at offset 0");
	const offset = request.offset ?? 0;
	if (offset > raw.length) throw new ApiError(400, "Offset exceeds record length");
	const direct: GraphRecordPageV2 = {
		schema_version: PLANNING_GRAPH_SCHEMA_VERSION,
		view: "record",
		section: request.section,
		id: request.id,
		record,
		revision,
		next_offset: null,
	};
	if (offset === 0 && stringifyYaml(direct).length <= GRAPH_PAGE_MAX_CHARS) return direct;
	let length = Math.min(8000, raw.length - offset);
	for (;;) {
		const end = offset + length;
		const page: GraphRecordPageV2 = {
			schema_version: PLANNING_GRAPH_SCHEMA_VERSION,
			view: "record",
			section: request.section,
			id: request.id,
			revision,
			offset,
			text: raw.slice(offset, end),
			next_offset: end < raw.length ? end : null,
		};
		if (stringifyYaml(page).length <= GRAPH_PAGE_MAX_CHARS) return page;
		if (length <= 1) throw new ApiError(400, "Record metadata exceeds output budget");
		length = Math.max(1, Math.floor(length / 2));
	}
}
