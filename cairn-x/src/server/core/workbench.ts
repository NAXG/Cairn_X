import { createHash } from "node:crypto";
import type { Db, ProjectRow, FactRow, FindingRow, GoalRow, HintRow, StepRow } from "../db.js";
import type {
	WorkbenchOverview,
	WorkbenchRecord,
	TimelineItem,
	ReadPage,
	RecordPreview,
	ExecutionDetail,
} from "../../contracts/workbench.js";
import { ApiError } from "./base.js";
import { getProjectOr404 } from "./project-guards.js";
import {
	projectMetaFromRow,
	factToModel,
	findingToModel,
	goalToModel,
	stepToModel,
	routeToModel,
	planningInfo,
	usageAggregates,
} from "./model-mappers.js";
import { listExecutionSummaries } from "./execution-summaries.js";

export function pageLimit(raw?: string) {
	const n = raw === undefined ? 50 : Number(raw);
	if (!Number.isSafeInteger(n) || n < 1 || n > 100)
		throw new ApiError(400, "Invalid limit (1-100)");
	return n;
}
export function pageCursor(
	raw: string | undefined,
	scope: string,
): { at: string; key: string } | undefined {
	if (!raw) return undefined;
	if (raw.length > 2000) throw new ApiError(400, "Invalid page cursor");
	try {
		const data = JSON.parse(Buffer.from(raw, "base64url").toString());
		if (
			data.scope !== scope ||
			typeof data.at !== "string" ||
			typeof data.key !== "string" ||
			raw.length > 2000
		)
			throw Error();
		return data;
	} catch {
		throw new ApiError(400, "Invalid page cursor; restart this list");
	}
}
export function nextCursor(at: string, key: string, scope: string) {
	return Buffer.from(JSON.stringify({ at, key, scope })).toString("base64url");
}
export function pageScope(projectId: string, kind: string, filters: unknown = {}) {
	return createHash("sha256")
		.update(JSON.stringify([projectId, kind, filters]))
		.digest("hex");
}

export function workbenchOverview(db: Db, projectId: string): WorkbenchOverview {
	const row = getProjectOr404(db, projectId);
	const { finding_schema: _schema, ...project } = projectMetaFromRow({
		...row,
		finding_schema: null,
	});
	const counts = db
		.prepare(
			`SELECT
	 (SELECT COUNT(*) FROM facts WHERE project_id=@pid) facts,
	 (SELECT COUNT(*) FROM goals WHERE project_id=@pid) goals,
	 (SELECT COUNT(*) FROM steps WHERE project_id=@pid) steps,
	 (SELECT COUNT(*) FROM findings WHERE project_id=@pid) findings,
	 (SELECT COUNT(*) FROM hints WHERE project_id=@pid) hints,
	 (SELECT COUNT(*) FROM steps WHERE project_id=@pid AND status='open') open_steps,
	 (SELECT COUNT(*) FROM executions WHERE project_id=@pid AND status='running') running,
	 (SELECT COUNT(*) FROM executions WHERE project_id=@pid AND status='queued') queued`,
		)
		.get({ pid: projectId }) as WorkbenchOverview["counts"];
	const active = db
		.prepare(
			"SELECT e.id,substr(s.description,1,240) description FROM executions e JOIN steps s ON s.project_id=e.project_id AND s.id=e.step_id WHERE e.project_id=? AND e.status='running' ORDER BY e.created_at,e.id LIMIT 50",
		)
		.all(projectId) as Array<{ id: string; description: string }>;
	const summaries = listExecutionSummaries(
		db,
		projectId,
		active.map((e) => e.id),
		true,
	);
	const failure = db
		.prepare(
			"SELECT id FROM executions WHERE project_id=? AND status IN ('failed','lost') ORDER BY COALESCE(finished_at,created_at) DESC,id DESC LIMIT 1",
		)
		.get(projectId) as { id: string } | undefined;
	return {
		project,
		counts,
		planning: planningInfo(db, projectId),
		usage: usageAggregates(db, projectId),
		active_executions: summaries.map((e) => ({
			...e,
			step_description: active.find((a) => a.id === e.id)?.description ?? "",
		})),
		latest_failure: failure
			? (listExecutionSummaries(db, projectId, [failure.id], true)[0] ?? null)
			: null,
		latest_finding:
			(db
				.prepare(
					"SELECT id,substr(title,1,160) title,created_at FROM findings WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
				)
				.get(projectId) as WorkbenchOverview["latest_finding"]) ?? null,
	};
}

const recordTables = {
	fact: "facts",
	finding: "findings",
	goal: "goals",
	step: "steps",
	hint: "hints",
	route: "routes",
};
export function resolveRecord(db: Db, pid: string, type: string, id: string) {
	if (type === "node") {
		if (id.startsWith("_step_")) return resolveRecord(db, pid, "step", id.slice(6));
		for (const candidate of ["fact", "finding", "goal", "step", "hint", "route"] as const)
			if (
				db
					.prepare(`SELECT 1 FROM ${recordTables[candidate]} WHERE project_id=? AND id=?`)
					.get(pid, id)
			)
				return { type: candidate, id, table: recordTables[candidate] };
		throw new ApiError(404, "Record not found");
	}
	const table = Object.hasOwn(recordTables, type)
		? recordTables[type as keyof typeof recordTables]
		: undefined;
	if (!table) throw new ApiError(400, "Invalid record type");
	if (!db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND id=?`).get(pid, id))
		throw new ApiError(404, "Record not found");
	return { type: type as keyof typeof recordTables, id, table };
}
export function workbenchRecord(db: Db, pid: string, type: string, id: string): WorkbenchRecord {
	getProjectOr404(db, pid);
	const resolved = resolveRecord(db, pid, type, id);
	type = resolved.type;
	id = resolved.id;
	const table = resolved.table;
	const row = db.prepare(`SELECT * FROM ${table} WHERE project_id=? AND id=?`).get(pid, id);
	if (!row) throw new ApiError(404, "Record not found");
	if (type === "route") {
		const stats = db
			.prepare(
				"SELECT COUNT(*) step_count,COALESCE(SUM(status IN ('open','claimed')),0) open_step_count,COALESCE(SUM(status='concluded'),0) concluded_step_count FROM steps WHERE project_id=? AND route_id=?",
			)
			.get(pid, id) as import("./model-mappers.js").RouteStepStats;
		return { type, record: routeToModel(row as import("../db.js").RouteRow, stats) };
	}
	if (type === "fact") return { type, record: factToModel(db, row as FactRow) };
	if (type === "finding") return { type, record: findingToModel(db, row as FindingRow) };
	if (type === "goal") return { type, record: goalToModel(db, row as GoalRow) };
	if (type === "hint") {
		const h = row as HintRow;
		return {
			type,
			record: {
				id: h.id,
				content: h.content,
				creator: h.creator,
				created_at: h.created_at,
				persistent: !!db
					.prepare("SELECT 1 FROM persistent_hints WHERE project_id=? AND hint_id=?")
					.get(pid, id),
			},
		};
	}
	const {
		worker: _worker,
		lease_version: _lease,
		last_heartbeat_at: _heartbeat,
		...step
	} = stepToModel(db, row as StepRow, pid);
	return {
		type: "step",
		record: {
			...step,
			produced_fact_ids: (
				db
					.prepare("SELECT id FROM facts WHERE project_id=? AND step_id=? ORDER BY LENGTH(id),id")
					.all(pid, id) as Array<{ id: string }>
			).map((f) => f.id),
		},
	};
}

export function recordPage(
	db: Db,
	pid: string,
	kind: string,
	limit: number,
	cursor?: string,
): ReadPage<RecordPreview> {
	if (!["findings", "hints", "goals"].includes(kind)) throw new ApiError(400, "Invalid collection");
	const scope = pageScope(pid, kind);
	const after = pageCursor(cursor, scope);
	const field = kind === "hints" ? "content" : "description";
	const cols =
		kind === "findings"
			? ",substr(title,1,160) title"
			: kind === "goals"
				? ",status,parent_goal_id"
				: ",creator";
	const rows = db
		.prepare(
			`SELECT id,created_at,substr(${field},1,400) ${field},length(${field})>400 truncated${cols} FROM ${kind} WHERE project_id=? ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
		)
		.all(pid, ...(after ? [after.at, after.at, after.key] : []), limit + 1) as RecordPreview[];
	const items = rows.slice(0, limit).map((r) => ({ ...r, truncated: !!r.truncated }));
	const last = items.at(-1);
	return {
		items,
		next_cursor: rows.length > limit && last ? nextCursor(last.created_at, last.id, scope) : null,
	};
}

export function timelinePage(
	db: Db,
	pid: string,
	limit: number,
	cursor?: string,
): ReadPage<TimelineItem> {
	const scope = pageScope(pid, "timeline");
	const after = pageCursor(cursor, scope);
	const event = (
		table: string,
		where: string,
		key: string,
		time: string,
		title: string,
		body: string,
		step: string,
		type: string,
	): [string, string, string] => [
		`SELECT ${key} key,${time} t,${title} title,substr(${body},1,400) body,${step} step,'${type}' record_type,id record_id,length(${body})>400 truncated FROM ${table} WHERE ${where}`,
		time,
		key,
	];
	const branches = [
		event(
			"projects",
			"id=@pid",
			"'project:'||id",
			"created_at",
			"'项目创建'",
			"title",
			"''",
			"project",
		),
		event(
			"facts",
			"project_id=@pid",
			"'fact:'||id",
			"created_at",
			"'事实 '||id",
			"description",
			"COALESCE(step_id,'')",
			"fact",
		),
		event(
			"steps",
			"project_id=@pid",
			"'step-created:'||id",
			"created_at",
			"'创建步骤 '||id",
			"description",
			"id",
			"step",
		),
		event(
			"steps",
			"project_id=@pid AND concluded_at IS NOT NULL",
			"'step-ended:'||id",
			"concluded_at",
			"'步骤结束 '||id",
			"COALESCE(summary,description)",
			"id",
			"step",
		),
		event(
			"goals",
			"project_id=@pid",
			"'goal-created:'||id",
			"created_at",
			"'目标 '||id",
			"description",
			"''",
			"goal",
		),
		event(
			"goals",
			"project_id=@pid AND achieved_at IS NOT NULL",
			"'goal-achieved:'||id",
			"achieved_at",
			"'目标达成 '||id",
			"COALESCE(achieved_description,'')",
			"''",
			"goal",
		),
		event(
			"findings",
			"project_id=@pid",
			"'finding:'||id",
			"created_at",
			"'发现 '||id",
			"title",
			"''",
			"finding",
		),
		event(
			"hints",
			"project_id=@pid",
			"'hint:'||id",
			"created_at",
			"'补充提示'",
			"content",
			"''",
			"hint",
		),
	];
	const unions = branches.map(
		([sql, time, key]) =>
			`SELECT * FROM (${sql}${after ? ` AND (${time}<@at OR (${time}=@at AND ${key}<@key))` : ""} ORDER BY t DESC,record_id DESC LIMIT @limit)`,
	);
	const rows = db
		.prepare(
			`WITH events AS (${unions.join(" UNION ALL ")}) SELECT key,t,title,substr(body,1,400) body,step,record_type,record_id,truncated FROM events ORDER BY t DESC,key DESC LIMIT @limit`,
		)
		.all({
			pid,
			...(after ? { at: after.at, key: after.key } : {}),
			limit: limit + 1,
		}) as TimelineItem[];
	const items = rows.slice(0, limit).map((r) => ({ ...r, truncated: !!r.truncated }));
	const last = items.at(-1);
	return {
		items,
		next_cursor: rows.length > limit && last ? nextCursor(last.t, last.key, scope) : null,
	};
}

export function executionDetail(db: Db, pid: string, id: string): ExecutionDetail {
	const execution = listExecutionSummaries(db, pid, [id])[0];
	if (!execution) throw new ApiError(404, "Execution not found");
	const adjacent = (previous: boolean) => {
		const cmp = previous ? "<" : ">";
		const direction = previous ? "DESC" : "ASC";
		const row = db
			.prepare(
				`SELECT id FROM executions WHERE project_id=? AND (step_id${cmp}? OR (step_id=? AND attempt${cmp}?)) ORDER BY step_id ${direction},attempt ${direction} LIMIT 1`,
			)
			.get(pid, execution.step_id, execution.step_id, execution.attempt) as
			{ id: string } | undefined;
		return row ? (listExecutionSummaries(db, pid, [row.id], true)[0] ?? null) : null;
	};
	return { execution, previous: adjacent(true), next: adjacent(false) };
}

export function projectPage(db: Db, limit: number, cursor?: string, query = "") {
	if (query.length > 200) throw new ApiError(400, "Project query is too long");
	const scope = pageScope("collection", "projects", query);
	const after = pageCursor(cursor, scope);
	const rows = db
		.prepare(
			`SELECT p.id,p.title,p.status,p.created_at,p.experiment_id,p.harness_variant,p.decide_worker,p.decide_trigger,p.decide_started_at,p.decide_last_heartbeat_at,NULL finding_schema,
	 (SELECT COUNT(*) FROM facts WHERE project_id=p.id) fact_count,
	 (SELECT COUNT(*) FROM goals WHERE project_id=p.id) goal_count,
	 (SELECT COUNT(*) FROM steps WHERE project_id=p.id) step_count,
	 (SELECT COUNT(*) FROM steps WHERE project_id=p.id AND status='claimed') working_step_count,
	 (SELECT COUNT(*) FROM steps WHERE project_id=p.id AND status='open') unclaimed_step_count,
	 (SELECT COUNT(*) FROM findings WHERE project_id=p.id) finding_count,
	 (SELECT COUNT(*) FROM hints WHERE project_id=p.id) hint_count FROM projects p
	 WHERE instr(lower(title),lower(@query))>0 ${after ? "AND (created_at<@at OR (created_at=@at AND id<@key))" : ""}
	 ORDER BY created_at DESC,id DESC LIMIT @limit`,
		)
		.all({ query, ...(after ? { at: after.at, key: after.key } : {}), limit: limit + 1 }) as Array<
		ProjectRow & {
			fact_count: number;
			goal_count: number;
			step_count: number;
			working_step_count: number;
			unclaimed_step_count: number;
			finding_count: number;
			hint_count: number;
		}
	>;
	const items = rows.slice(0, limit).map((row) => {
		const { finding_schema: _schema, ...meta } = projectMetaFromRow(row);
		return {
			...meta,
			fact_count: row.fact_count,
			goal_count: row.goal_count,
			step_count: row.step_count,
			working_step_count: row.working_step_count,
			unclaimed_step_count: row.unclaimed_step_count,
			finding_count: row.finding_count,
			hint_count: row.hint_count,
		};
	});
	const last = items.at(-1);
	return {
		items,
		next_cursor: rows.length > limit && last ? nextCursor(last.created_at, last.id, scope) : null,
	};
}
