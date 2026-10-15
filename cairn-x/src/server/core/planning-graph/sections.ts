import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import { GRAPH_PAGE_MAX_CHARS } from "../../../contracts/graph.js";
import {
	PLANNING_GRAPH_SCHEMA_VERSION,
	type GraphSection,
	type GraphSectionFilters,
	type GraphSectionPage,
} from "../../../contracts/planning-graph.js";
import type { Db } from "../../db.js";
import { ApiError } from "../base.js";
import { getProjectOr404 } from "../project-guards.js";

/**
 * 历史索引只用来「发现 id」，正文一律走 view:"record"。
 *
 * 索引行因此不投影描述、confidence、priority 之类的正文片段：截断到 120 字的片段
 * 既不足以据此判断，又会按行挤占整页预算（实测占规划页 59.8%–79.5%）。只有 goal
 * 与 step 还带 status：它们的状态会变（pending/achieved、concluded/abandoned），
 * 是索引里唯一还带决策含义的信息；fact/hint/finding/route 没有状态可给。
 */
interface SectionOptions extends GraphSectionFilters {
	after?: string;
	limit?: number;
	descending?: boolean;
	exclude?: string[];
}

export function sectionRows(
	db: Db,
	projectId: string,
	section: GraphSection,
	options: SectionOptions = {},
): Array<Record<string, unknown>> {
	const filters = ["project_id=?"];
	const args: (string | number)[] = [projectId];
	if (options.after !== undefined) {
		filters.push("(LENGTH(id)>LENGTH(?) OR (LENGTH(id)=LENGTH(?) AND id>?))");
		args.push(options.after, options.after, options.after);
	}
	if (options.exclude?.length) {
		filters.push("id NOT IN (SELECT value FROM json_each(?))");
		args.push(JSON.stringify(options.exclude));
	}
	if (options.status) {
		const allowed =
			section === "steps"
				? ["open", "claimed", "concluded", "abandoned"]
				: section === "goals"
					? ["pending", "achieved", "abandoned"]
					: [];
		if (!allowed.includes(options.status))
			throw new ApiError(400, "status is not valid for this section");
		filters.push("status=?");
		args.push(options.status);
	}
	if (options.goal_id) {
		if (section !== "steps" && section !== "routes")
			throw new ApiError(400, "goal_id filter requires steps or routes");
		filters.push("goal_id=?");
		args.push(options.goal_id);
	}
	if (options.route_id) {
		if (section !== "steps") throw new ApiError(400, "route_id filter requires steps");
		filters.push("route_id=?");
		args.push(options.route_id);
	}
	if (options.query) {
		const terms = options.query.trim().split(/\s+/);
		if (!terms.length || terms.length > 5)
			throw new ApiError(400, "query requires 1-5 keyword terms");
		const field =
			section === "hints"
				? "content"
				: section === "findings"
					? "title || ' ' || description"
					: "description";
		for (const term of terms) {
			filters.push(`(${field}) LIKE ? ESCAPE '\\'`);
			args.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
		}
	}
	const hasStatus = section === "goals" || section === "steps";
	const preview = section === "hints" ? "content" : "description";
	const columns = `id${hasStatus ? ",status" : ""}${options.query ? `,substr(${preview},1,160) AS preview` : ""}`;
	const direction = options.descending ? "DESC" : "ASC";
	args.push(options.limit ?? 201);
	return db
		.prepare(
			`SELECT ${columns} FROM ${section} WHERE ${filters.join(" AND ")}
		ORDER BY LENGTH(id) ${direction},id ${direction} LIMIT ?`,
		)
		.all(...args) as Array<Record<string, unknown>>;
}

export function readGraphSection(
	db: Db,
	projectId: string,
	section: GraphSection,
	cursor?: string,
	filters: GraphSectionFilters = {},
): GraphSectionPage {
	getProjectOr404(db, projectId);
	const filtered = Object.values(filters).some((v) => v !== undefined);
	const filterHash = createHash("sha256")
		.update(
			JSON.stringify([section, filters.query, filters.status, filters.goal_id, filters.route_id]),
		)
		.digest("hex")
		.slice(0, 16);
	const prefix = `search:${filterHash}:`;
	let after = cursor;
	if (filtered && cursor !== undefined) {
		if (!cursor.startsWith(prefix))
			throw new ApiError(409, "Section cursor does not match these filters; restart the search");
		after = cursor.slice(prefix.length);
	}
	if (
		after !== undefined &&
		!db.prepare(`SELECT 1 FROM ${section} WHERE project_id=? AND id=?`).get(projectId, after)
	)
		throw new ApiError(409, "Section cursor is stale or belongs to another project");
	const rows = sectionRows(db, projectId, section, { ...filters, after, limit: 201 });
	const page: GraphSectionPage = {
		schema_version: PLANNING_GRAPH_SCHEMA_VERSION,
		view: "section",
		section,
		records: [],
		next_cursor: null,
	};
	let index = 0;
	for (; index < rows.length && page.records.length < 200; index++) {
		page.records.push(rows[index]);
		if (stringifyYaml(page).length > GRAPH_PAGE_MAX_CHARS) {
			page.records.pop();
			break;
		}
	}
	if (!page.records.length && rows.length)
		throw new ApiError(400, "A graph section record exceeds the page character budget");
	if (index < rows.length)
		page.next_cursor = `${filtered ? prefix : ""}${(page.records.at(-1) as { id: string }).id}`;
	return page;
}
