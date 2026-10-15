import { conditionalRead } from "../core/read-versions.js";
import { Hono } from "hono";
import type { Db } from "../db.js";
import type { LineageOptions } from "../../contracts/graph.js";
import { ApiError } from "../core/base.js";
import { requireDecideLease } from "../core/project-guards.js";
import { projectGraph, graphLineage, goalEvidence, parseGraphType } from "../core/graph.js";

// direction / relations 的合法性由 core/graph.ts 统一校验；这里只做 query 解析。
function options(query: Record<string, string>): LineageOptions {
	const numeric = (name: string) => {
		const raw = query[name];
		if (raw === undefined) return undefined;
		if (!/^\d+$/.test(raw)) throw new ApiError(400, `Invalid ${name}`);
		return Number(raw);
	};
	if (query.include_execution !== undefined && !["true", "false"].includes(query.include_execution))
		throw new ApiError(400, "Invalid include_execution");
	return {
		direction: query.direction as LineageOptions["direction"],
		relations: query.relations?.split(",") as LineageOptions["relations"],
		include_execution: query.include_execution === "true",
		depth: numeric("depth"),
		max_nodes: numeric("max_nodes"),
		max_edges: numeric("max_edges"),
	};
}
export function graphRoutes(db: Db): Hono {
	const app = new Hono();
	// Public routes inherit session/machine authentication. Decide tools additionally bind reads to their live lease.
	const load = (pid: string, worker: string | undefined) => {
		if (worker !== undefined) requireDecideLease(db, pid, worker);
		return projectGraph(db, pid);
	};

	app.get("/projects/:id/graph/canvas", (c) => {
		const pid = c.req.param("id"),
			worker = c.req.query("worker");
		if (worker !== undefined) requireDecideLease(db, pid, worker);
		return conditionalRead(c, db, pid, "graph", () => projectGraph(db, pid, true));
	});
	app.get("/projects/:id/graph/lineage/:type/:nodeId", (c) => {
		const type = parseGraphType(c.req.param("type"));
		if (c.req.query("worker") !== undefined)
			requireDecideLease(db, c.req.param("id"), c.req.query("worker")!);
		return conditionalRead(c, db, c.req.param("id"), "graph", () =>
			graphLineage(
				load(c.req.param("id"), c.req.query("worker")),
				{ type, id: c.req.param("nodeId") },
				options(c.req.query()),
			),
		);
	});
	app.get("/projects/:id/goals/:goalId/evidence", (c) => {
		if (c.req.query("worker") !== undefined)
			requireDecideLease(db, c.req.param("id"), c.req.query("worker")!);
		return conditionalRead(c, db, c.req.param("id"), "graph", () =>
			goalEvidence(
				load(c.req.param("id"), c.req.query("worker")),
				c.req.param("goalId"),
				options(c.req.query()),
			),
		);
	});
	return app;
}
