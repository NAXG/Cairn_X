/** Current-state graph projection. These edges are read models, not a second writable store. */

/** Agent get_graph 单页响应预算（字符）；必需内容放不下时由 next_cursor 续读。 */
export const GRAPH_PAGE_MAX_CHARS = 60_000;
export const GRAPH_NODE_TYPES = [
	"fact",
	"goal",
	"step",
	"finding",
	"hint",
	"route",
	"execution",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];
export interface GraphRef {
	type: GraphNodeType;
	id: string;
}
export const graphNodeId = (type: GraphNodeType, id: string): string => `${type}:${id}`;
/**
 * 作用域 id（f001/s001/t001…）排序：先比长度、再比字典序。
 *
 * 零填充宽度一致时它等价于数值序，且 999→1000 跨位宽后仍然正确
 * （f999 < f1000，而纯字典序会把 f1000 排到前面）。库里已有可变宽度的历史
 * id，所以不能靠加宽填充来修，只能在比较处统一。
 */
export const compareScopedIds = (a: string, b: string): number =>
	a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;

export interface GraphNode {
	id: string;
	type: GraphNodeType;
	ref_id: string;
	label: string;
	description: string;
	created_at: string;
	status?: string;
	concluded_at?: string | null;
	achieved_at?: string | null;
	achieved_description?: string | null;
	/** Needed only for the existing approximate timeline, not a historical snapshot. */
	worker?: string | null;
	attempt?: number;
	size?: number;
}

interface RelationDefinition {
	pairs: readonly (readonly [GraphNodeType, GraphNodeType])[];
	defaultLineage: boolean;
	/** Whether upstream follows the stored source → target direction. */
	upstreamForward: boolean;
}
export const RELATIONS = {
	supports: {
		pairs: [
			["fact", "step"],
			["fact", "finding"],
		],
		defaultLineage: true,
		upstreamForward: false,
	},
	produces: {
		pairs: [
			["step", "fact"],
			["step", "finding"],
			["execution", "fact"],
			["execution", "finding"],
		],
		defaultLineage: true,
		upstreamForward: false,
	},
	proves: {
		pairs: [
			["fact", "goal"],
			["finding", "goal"],
		],
		defaultLineage: true,
		upstreamForward: false,
	},
	// serves = 贡献于：step 服务 route、route 服务 goal；同时 step 始终保留一条直达
	// 自己 goal_id 的边（无论是否归入某条路线），这样从 goal 出发能直接看到全部贡献步骤。
	serves: {
		pairs: [
			["step", "goal"],
			["step", "route"],
			["route", "goal"],
		],
		defaultLineage: false,
		upstreamForward: false,
	},
	depends_on: { pairs: [["step", "step"]], defaultLineage: false, upstreamForward: true },
	decomposes_to: { pairs: [["goal", "goal"]], defaultLineage: false, upstreamForward: false },
	has_execution: { pairs: [["step", "execution"]], defaultLineage: true, upstreamForward: false },
} as const satisfies Record<string, RelationDefinition>;
export type GraphRelation = keyof typeof RELATIONS;
export const GRAPH_RELATIONS = Object.keys(RELATIONS) as GraphRelation[];
export function relationAllows(
	relation: GraphRelation,
	from: GraphNodeType,
	to: GraphNodeType,
): boolean {
	return (RELATIONS[relation].pairs as RelationDefinition["pairs"]).some(
		([a, b]) => a === from && b === to,
	);
}
export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	relation: GraphRelation;
}
interface GraphStats {
	nodes: number;
	edges: number;
	dangling_edges: number;
}
export interface ProjectGraph {
	project_id: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	stats: GraphStats;
}
export interface LineageOptions {
	direction?: "up" | "down";
	relations?: GraphRelation[];
	include_execution?: boolean;
	depth?: number;
	max_nodes?: number;
	max_edges?: number;
}
export interface GraphLineage extends ProjectGraph {
	root: string;
	direction: "up" | "down";
	truncated: boolean;
}
export interface GoalEvidence {
	goal: GraphNode;
	/** Direct evidence present in the bounded lineage; evidence_total reports the full count. */
	evidence: GraphNode[];
	evidence_total: number;
	lineage: GraphLineage;
}
