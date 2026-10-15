export const PLANNING_GRAPH_SCHEMA_VERSION = 2 as const;

const GRAPH_SECTIONS = ["facts", "goals", "steps", "hints", "findings", "routes"] as const;

const GRAPH_RECORD_SECTIONS = [...GRAPH_SECTIONS, "project", "usage"] as const;

export type GraphSection = (typeof GRAPH_SECTIONS)[number];
export type GraphRecordSection = (typeof GRAPH_RECORD_SECTIONS)[number];

export interface GraphSectionFilters {
	query?: string;
	status?: string;
	goal_id?: string;
	route_id?: string;
}

export type PlanningGraphRequest =
	| { worker: string; view: "planning"; cursor?: string }
	| ({
			worker: string;
			view: "section";
			section: GraphSection;
			cursor?: string;
	  } & GraphSectionFilters)
	| {
			worker: string;
			view: "record";
			section: GraphRecordSection;
			id: string;
			offset?: number;
			revision?: string;
	  };

/**
 * coverage 只回答 Decide 唯一需要据此决策的问题：本轮必需页读完了没有。
 * 未读完时必须带 next_cursor 继续读，读完后 required_complete 才为 true。
 *
 * 水位（observed_seq）、snapshot 序号与历史条数统计都是服务端内部记账，既不参与
 * 规划判断也不该占用上下文预算，因此不进模型可见的响应。
 */
interface PlanningCoverage {
	required_complete: boolean;
	next_cursor: string | null;
}

export interface PlanningGraphPage {
	schema_version: typeof PLANNING_GRAPH_SCHEMA_VERSION;
	view: "planning";
	project?: unknown;
	frontier: {
		goals: unknown[];
		steps: unknown[];
		routes: unknown[];
		hints?: unknown[];
	};
	changes: unknown[];
	evidence: {
		facts: unknown[];
	};
	history: Record<string, unknown[]>;
	/**
	 * 历史索引被截断（每分区只列最近若干条，或整页预算吃满）时为 true。
	 * 未截断的页面不带这个键，避免用 false 占字数。完整索引用 view:"section"。
	 */
	history_truncated?: boolean;
	coverage: PlanningCoverage;
}

export interface GraphSectionPage {
	schema_version: typeof PLANNING_GRAPH_SCHEMA_VERSION;
	view: "section";
	section: GraphSection;
	records: unknown[];
	next_cursor: string | null;
}

export interface GraphRecordPageV2 {
	schema_version: typeof PLANNING_GRAPH_SCHEMA_VERSION;
	view: "record";
	section: GraphRecordSection;
	id: string;
	record?: unknown;
	revision: string;
	offset?: number;
	text?: string;
	next_offset: number | null;
}

export type PlanningGraphResponse = PlanningGraphPage | GraphSectionPage | GraphRecordPageV2;
