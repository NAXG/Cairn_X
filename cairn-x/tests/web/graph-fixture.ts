import type { GraphNode, GraphEdge, ProjectGraph } from "../../src/contracts/graph.js";
export function graphNode(
	type: GraphNode["type"],
	ref_id: string,
	extra: Partial<GraphNode> = {},
): GraphNode {
	return {
		id: `${type}:${ref_id}`,
		type,
		ref_id,
		label: ref_id,
		description: ref_id,
		created_at: "2026-01-01",
		...extra,
	};
}
export function graphEdge(
	source: string,
	relation: GraphEdge["relation"],
	target: string,
): GraphEdge {
	return { id: JSON.stringify([source, relation, target]), source, relation, target };
}
export function fixtureGraph(): ProjectGraph {
	return {
		project_id: "p",
		nodes: [
			graphNode("fact", "origin"),
			graphNode("fact", "f1", { created_at: "2026-01-03" }),
			graphNode("step", "s1", {
				status: "concluded",
				created_at: "2026-01-02",
				concluded_at: "2026-01-03",
				worker: "e1",
			}),
		],
		edges: [
			graphEdge("fact:origin", "supports", "step:s1"),
			graphEdge("step:s1", "produces", "fact:f1"),
		],
		stats: { nodes: 3, edges: 2, dangling_edges: 0 },
	};
}
