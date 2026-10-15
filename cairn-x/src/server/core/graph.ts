import type { Db, FactRow, FindingRow, GoalRow, StepRow, HintRow, RouteRow } from "../db.js";
import {
	GRAPH_NODE_TYPES,
	GRAPH_RELATIONS,
	RELATIONS,
	compareScopedIds,
	graphNodeId,
	relationAllows,
	type GraphNodeType,
	type GraphNode,
	type GraphEdge,
	type GraphRelation,
	type ProjectGraph,
	type GraphRef,
	type GraphLineage,
	type LineageOptions,
	type GoalEvidence,
} from "../../contracts/graph.js";
import { ApiError } from "./base.js";
import { getProjectOr404 } from "./project-guards.js";
import { parseJsonStringArray } from "./model-mappers.js";

export function parseGraphType(value: string): GraphNodeType {
	if (!GRAPH_NODE_TYPES.includes(value as GraphNodeType))
		throw new ApiError(400, "Invalid node type");
	return value as GraphNodeType;
}
const order = <T extends { id: string }>(items: T[]) =>
	items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * 节点排序：同一类型内按作用域 id 的创建序（先长度后字典序），跨类型维持
 * 原有的字典序 —— 消费方按类型分组读取，跨类型重排没有收益还会破坏既有断言。
 */
const orderNodes = (nodes: GraphNode[]): GraphNode[] =>
	nodes.sort((a, b) =>
		a.type === b.type
			? compareScopedIds(a.ref_id, b.ref_id)
			: a.id < b.id
				? -1
				: a.id > b.id
					? 1
					: 0,
	);

/** One SQLite read transaction: nodes and edges describe the same current state. Never exposes raw execution rows/tokens. */
export function projectGraph(db: Db, projectId: string, canvas = false): ProjectGraph {
	return db.transaction(() => {
		getProjectOr404(db, projectId);
		const columns: Record<string, string> = {
			facts: "id,project_id,step_id,created_at,substr(description,1,300) description",
			findings:
				"id,project_id,step_id,fact_ids,created_at,substr(title,1,160) title,substr(description,1,300) description",
			goals:
				"id,project_id,parent_goal_id,status,created_at,achieved_at,substr(achieved_description,1,300) achieved_description,substr(description,1,300) description",
			steps:
				"id,project_id,goal_id,route_id,status,worker,waiting_on,created_at,concluded_at,substr(description,1,300) description",
			routes: "id,project_id,goal_id,created_at,substr(description,1,300) description",
		};
		const rows = <T>(table: string): T[] =>
			db
				.prepare(
					`SELECT ${canvas ? columns[table] : "*"} FROM ${table} WHERE project_id=? ORDER BY LENGTH(id),id`,
				)
				.all(projectId) as T[];
		const facts = rows<FactRow>("facts"),
			findings = rows<FindingRow>("findings"),
			goals = rows<GoalRow>("goals"),
			steps = rows<StepRow>("steps"),
			routes = rows<RouteRow>("routes");
		const hints = canvas ? [] : rows<HintRow>("hints");
		const executions = canvas
			? []
			: (db
					.prepare(
						"SELECT id, step_id, status, attempt, summary, error, created_at FROM executions WHERE project_id=? ORDER BY id",
					)
					.all(projectId) as Array<{
					id: string;
					step_id: string;
					status: string;
					attempt: number;
					summary: string | null;
					error: string | null;
					created_at: string;
				}>);
		const nodes: GraphNode[] = [];
		// 每个步骤的尝试次数：一次执行尝试一行，用于在步骤节点上标注重试过的步骤。
		const attempts = new Map<string, number>();
		if (canvas)
			for (const row of db
				.prepare("SELECT step_id,COUNT(*) n FROM executions WHERE project_id=? GROUP BY step_id")
				.all(projectId) as Array<{ step_id: string; n: number }>)
				attempts.set(row.step_id, row.n);
		else executions.forEach((r) => attempts.set(r.step_id, (attempts.get(r.step_id) ?? 0) + 1));
		const node = (
			type: GraphNodeType,
			row: { id: string; created_at: string },
			description: string,
			extra: Partial<GraphNode> = {},
		) => {
			nodes.push({
				id: graphNodeId(type, row.id),
				type,
				ref_id: row.id,
				label: row.id,
				description,
				created_at: row.created_at,
				...extra,
			});
		};
		facts.forEach((r) => node("fact", r, r.description));
		findings.forEach((r) => node("finding", r, r.description, { label: r.title }));
		goals.forEach((r) =>
			node("goal", r, r.description, {
				status: r.status,
				achieved_at: r.achieved_at,
				achieved_description: r.achieved_description,
			}),
		);
		steps.forEach((r) =>
			node("step", r, r.description, {
				status: r.status,
				concluded_at: r.concluded_at,
				worker: r.worker,
				// 步骤节点上的 attempt 表示"这个步骤被尝试了几次"（执行行数），
				// 与 execution.attempt 的序号含义不同。画布用它标注重试过的步骤。
				attempt: attempts.get(r.id) ?? 0,
			}),
		);
		hints.forEach((r) => node("hint", r, r.content));
		routes.forEach((r) => node("route", r, r.description));
		executions.forEach((r) =>
			node("execution", r, r.summary ?? r.error ?? "", { status: r.status, attempt: r.attempt }),
		);
		const nodeIds = new Set(nodes.map((n) => n.id));
		const edges = new Map<string, GraphEdge>();
		const dangling = new Set<string>();
		const edge = (
			fromType: GraphNodeType,
			from: string | null,
			relation: GraphRelation,
			toType: GraphNodeType,
			to: string | null,
		) => {
			if (!from || !to) return;
			if (!relationAllows(relation, fromType, toType))
				throw new Error(`Invalid graph projection: ${relation}`);
			const source = graphNodeId(fromType, from),
				target = graphNodeId(toType, to);
			const id = JSON.stringify([source, relation, target]);
			if (!nodeIds.has(source) || !nodeIds.has(target)) {
				dangling.add(id);
				return;
			}
			edges.set(id, { id, source, relation, target });
		};
		const sources = db
			.prepare(
				"SELECT step_id, fact_id FROM step_sources WHERE project_id = ? ORDER BY step_id, fact_id",
			)
			.all(projectId) as Array<{ step_id: string; fact_id: string }>;
		sources.forEach((r) => edge("fact", r.fact_id, "supports", "step", r.step_id));
		facts.forEach((r) => {
			edge("step", r.step_id, "produces", "fact", r.id);
			if (!canvas) edge("execution", r.execution_id, "produces", "fact", r.id);
		});
		findings.forEach((r) => {
			edge("step", r.step_id, "produces", "finding", r.id);
			if (!canvas) edge("execution", r.execution_id, "produces", "finding", r.id);
			parseJsonStringArray(r.fact_ids).forEach((id) =>
				edge("fact", id, "supports", "finding", r.id),
			);
		});
		steps.forEach((r) => {
			edge("step", r.id, "serves", "goal", r.goal_id);
			edge("step", r.id, "serves", "route", r.route_id);
			parseJsonStringArray(r.waiting_on).forEach((id) =>
				edge("step", r.id, "depends_on", "step", id),
			);
		});
		routes.forEach((r) => edge("route", r.id, "serves", "goal", r.goal_id));
		goals.forEach((r) => {
			edge("goal", r.parent_goal_id, "decomposes_to", "goal", r.id);
		});
		// Goal 完成证据：唯一存储在 goal_evidence，支持 Fact 与 Finding。
		const goalEvidenceRows = db
			.prepare(
				"SELECT goal_id, evidence_type, evidence_id FROM goal_evidence WHERE project_id = ? ORDER BY rowid",
			)
			.all(projectId) as Array<{
			goal_id: string;
			evidence_type: "fact" | "finding";
			evidence_id: string;
		}>;
		goalEvidenceRows.forEach((r) =>
			edge(r.evidence_type, r.evidence_id, "proves", "goal", r.goal_id),
		);
		executions.forEach((r) => edge("step", r.step_id, "has_execution", "execution", r.id));
		return {
			project_id: projectId,
			nodes: orderNodes(nodes),
			edges: order([...edges.values()]),
			stats: { nodes: nodes.length, edges: edges.size, dangling_edges: dangling.size },
		};
	})();
}

function graphNode(graph: ProjectGraph, ref: GraphRef): GraphNode {
	const node = graph.nodes.find((n) => n.id === graphNodeId(ref.type, ref.id));
	if (!node) throw new ApiError(404, "Graph node not found");
	return node;
}
function bounded(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
	name: string,
): number {
	const n = value ?? fallback;
	if (!Number.isSafeInteger(n) || n < min || n > max) throw new ApiError(400, `Invalid ${name}`);
	return n;
}
export function graphLineage(
	graph: ProjectGraph,
	ref: GraphRef,
	options: LineageOptions = {},
): GraphLineage {
	const root = graphNode(graph, ref).id;
	const direction = options.direction ?? "up";
	if (direction !== "up" && direction !== "down") throw new ApiError(400, "Invalid direction");
	const depth = bounded(options.depth, 8, 0, 32, "depth");
	const maxNodes = bounded(options.max_nodes, 200, 1, 2000, "max_nodes");
	const maxEdges = bounded(options.max_edges, 1000, 1, 5000, "max_edges");
	const relations = options.relations ?? GRAPH_RELATIONS.filter((r) => RELATIONS[r].defaultLineage);
	if (!relations.length || relations.some((r) => !GRAPH_RELATIONS.includes(r)))
		throw new ApiError(400, "Invalid relations");
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const allowed = new Set(relations);
	const candidates = graph.edges.filter(
		(e) =>
			allowed.has(e.relation) &&
			(options.include_execution ||
				![e.source, e.target].some((id) => byId.get(id)!.type === "execution")),
	);
	const adjacent = new Map<string, string[]>();
	for (const e of candidates) {
		const forward =
			direction === "up"
				? RELATIONS[e.relation].upstreamForward
				: !RELATIONS[e.relation].upstreamForward;
		const from = forward ? e.source : e.target,
			to = forward ? e.target : e.source;
		if (!adjacent.has(from)) adjacent.set(from, []);
		adjacent.get(from)!.push(to);
	}
	const seen = new Set([root]);
	const queue: Array<[string, number]> = [[root, 0]];
	const omitted = new Set<string>();
	for (let i = 0; i < queue.length; i++) {
		const [current, level] = queue[i]!;
		for (const next of adjacent.get(current) ?? []) {
			if (seen.has(next)) continue;
			if (level >= depth || seen.size >= maxNodes) {
				omitted.add(next);
				continue;
			}
			seen.add(next);
			queue.push([next, level + 1]);
		}
	}
	const nodes = graph.nodes.filter((n) => seen.has(n.id));
	const allEdges = candidates.filter((e) => seen.has(e.source) && seen.has(e.target));
	const edges = allEdges.slice(0, maxEdges);
	return {
		project_id: graph.project_id,
		root,
		direction,
		nodes,
		edges,
		stats: { nodes: nodes.length, edges: edges.length, dangling_edges: graph.stats.dangling_edges },
		truncated: allEdges.length > edges.length || [...omitted].some((id) => !seen.has(id)),
	};
}
export function goalEvidence(
	graph: ProjectGraph,
	goalId: string,
	options: Pick<LineageOptions, "depth" | "max_nodes" | "max_edges"> = {},
): GoalEvidence {
	const goal = graphNode(graph, { type: "goal", id: goalId });
	const evidenceIds = new Set(
		graph.edges.filter((e) => e.relation === "proves" && e.target === goal.id).map((e) => e.source),
	);
	const lineage = graphLineage(
		graph,
		{ type: "goal", id: goalId },
		{
			depth: options.depth,
			max_nodes: options.max_nodes,
			max_edges: options.max_edges,
			direction: "up",
			include_execution: true,
		},
	);
	return {
		goal,
		evidence: lineage.nodes.filter((n) => evidenceIds.has(n.id)),
		evidence_total: evidenceIds.size,
		lineage,
	};
}
