import type { ElementDefinition } from "cytoscape";
import type { GraphNode, ProjectGraph } from "../../../contracts/graph.js";
import { statusLabels } from "../../labels.js";
interface GraphOptions {
	compact: boolean;
	isolated: boolean;
	expanded: Record<string, boolean>;
	/** Routes duplicate step → goal ownership in the overview, so keep them opt-in. */
	showRoutes?: boolean;
	/** The whole-project canvas prefers one canonical path over repeated proof edges. */
	overview?: boolean;
}
/**
 * 画布节点尺寸。Cytoscape 的 text-wrap 只在空格处断行，中文长句没有空格，
 * 所以换行必须自己算；宽度同时被 Graph.tsx 的样式引用，避免两处漂移。
 */
export const NODE_SIZES = {
	fact: { width: 196, height: 70, pointed: 0 },
	goal: { width: 196, height: 70, pointed: 0 },
	"goal-root": { width: 220, height: 84, pointed: 0 },
	step: { width: 210, height: 78, pointed: 0.25 },
	finding: { width: 224, height: 88, pointed: 1 },
	"fact-group": { width: 150, height: 38, pointed: 0 },
} as const;
const CANVAS_FONT_SIZE = 11;
const LINE_HEIGHT_FACTOR = 1.35;
/** 全角字符与半角字符的渲染宽度比例；半角取略宽的 0.58，避免英文与数字溢出。 */
const WIDE_CHAR =
	/[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const charWidth = (ch: string) => (WIDE_CHAR.test(ch) ? 1 : 0.58);

/** 正文里的 Markdown 记号在画布上没有意义，只会在节点里显示成噪声。 */
function stripMarkup(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^\s{0,3}#{1,6}\s*/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
		.replace(/\*\*|__|~~|`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
/** Finding 正文常以自身标题开头，节点上已显示标题，重复一次只会挤掉真正的内容。 */
function dropRepeatedTitle(text: string, title: string): string {
	const body = stripMarkup(text);
	const head = stripMarkup(title);
	let same = 0;
	while (same < body.length && same < head.length && body[same] === head[same] && same < 60) same++;
	return same >= 10 ? body.slice(same).replace(/^[\s：:，,。.、\-—]+/, "") : body;
}
/** 供测试校验节点文字是否真的装得进边框。 */
export const textUnits = (text: string) => [...text].reduce((sum, ch) => sum + charWidth(ch), 0);
/** 按估算宽度硬折行，保证每一行都装得进节点内宽。 */
function wrapToWidth(text: string, budget: number, maxLines: number): string[] {
	const lines: string[] = [];
	let line = "";
	let used = 0;
	let clipped = false;
	for (const ch of text) {
		const width = charWidth(ch);
		if (used + width > budget && line !== "") {
			if (lines.length === maxLines - 1) {
				clipped = true;
				break;
			}
			lines.push(line);
			line = "";
			used = 0;
			if (ch === " ") continue;
		}
		line += ch;
		used += width;
	}
	if (line) lines.push(line);
	if (clipped && lines.length) {
		let last = lines[lines.length - 1].replace(/[\s，,。.、;；]+$/, "");
		while (last && textUnits(last) + 1 > budget) last = last.slice(0, -1);
		lines[lines.length - 1] = `${last}…`;
	}
	return lines;
}
function nodeBox(node: GraphNode) {
	const key = node.type === "goal" && node.ref_id === "goal" ? "goal-root" : node.type;
	return (
		(NODE_SIZES as Record<string, { width: number; height: number; pointed: number }>)[key] ??
		NODE_SIZES.fact
	);
}
/**
 * 一行文字能用的像素宽度。菱形（发现）与六边形（步骤）在中线以外会收窄，
 * 若只按节点外框宽度折行，第二行就会压到边线上，所以要按形状扣掉收缩量。
 */
export function labelWidthLimit(node: GraphNode): number {
	const { width, height, pointed } = nodeBox(node);
	const halfLine = (CANVAS_FONT_SIZE * LINE_HEIGHT_FACTOR) / 2;
	const slope = pointed * (halfLine / (height / 2)) * (width / 2);
	return Math.max(48, width - 12 - 2 * slope);
}
function canvasLabel(node: GraphNode, statusLabel: string | undefined): string {
	const budget = labelWidthLimit(node) / CANVAS_FONT_SIZE;
	const summary = dropRepeatedTitle(node.description, node.label);
	const body = wrapToWidth(`${statusLabel ? `${statusLabel} · ` : ""}${summary}`, budget, 2);
	return [canvasTitle(node), ...body].join("\n");
}
function canvasTitle(node: GraphNode): string {
	if (node.type === "fact" && node.ref_id === "origin") return "起点";
	if (node.type === "goal") return node.ref_id === "goal" ? "根目标" : `目标 ${node.ref_id}`;
	if (node.type === "step")
		// 画布不放执行层：每次尝试的方框与它的产出边只是把同一批证据再画一遍，
		// 真正需要留在图上的只有"这个步骤跑了几次"，所以只标重试过的步骤。
		return node.attempt !== undefined && node.attempt > 1
			? `步骤 ${node.ref_id} · ${node.attempt} 次尝试`
			: `步骤 ${node.ref_id}`;
	if (node.type === "finding") return `发现 ${node.ref_id}`;
	if (node.type === "route") return `路线 ${node.ref_id}`;
	return `${node.type} ${node.ref_id}`;
}
function canonicalOverviewEdges(edges: ProjectGraph["edges"]): ProjectGraph["edges"] {
	const root = "goal:goal";
	const findingsProvingChildren = new Set(
		edges
			.filter(
				(e) =>
					e.relation === "proves" &&
					e.source.startsWith("finding:") &&
					e.target.startsWith("goal:") &&
					e.target !== root,
			)
			.map((e) => e.source),
	);
	const stepsWithFindingProvingRoot = new Set(
		edges
			.filter(
				(e) =>
					e.relation === "produces" &&
					e.source.startsWith("step:") &&
					e.target.startsWith("finding:") &&
					edges.some(
						(proof) =>
							proof.relation === "proves" && proof.source === e.target && proof.target === root,
					),
			)
			.map((e) => e.source),
	);
	return edges.filter(
		(e) =>
			// A finding which already proves a child goal reaches the root through that
			// child. Drawing its duplicate direct proof creates a fan without adding a
			// planning decision. Keep direct root-only findings (such as a final review).
			!(e.relation === "proves" && e.target === root && findingsProvingChildren.has(e.source)) &&
			// Likewise, a review step which produces the root proof needs one path,
			// step → finding → root, rather than a second direct step → root arrow.
			!(e.relation === "serves" && e.target === root && stepsWithFindingProvingRoot.has(e.source)),
	);
}
/** Existing approximate replay only. Current-state projection is not a historical snapshot. */
function nodeStatusAt(node: GraphNode, at: number | null): string | undefined {
	if (at !== null && node.type === "goal" && node.achieved_at && Date.parse(node.achieved_at) > at)
		return "pending";
	if (
		at !== null &&
		node.type === "step" &&
		node.concluded_at &&
		Date.parse(node.concluded_at) > at
	)
		return node.worker ? "claimed" : "open";
	return node.status;
}
export function buildGraphElements(
	graph: ProjectGraph,
	options: GraphOptions,
	atMs: number | null = null,
): ElementDefinition[] {
	const nodes = graph.nodes.filter(
		(n) =>
			(atMs === null || !n.created_at || Date.parse(n.created_at) <= atMs) &&
			n.type !== "hint" &&
			(options.showRoutes || n.type !== "route") &&
			// 执行尝试不画在画布上：它对阅读拓扑没有增量信息，逐次尝试的状态与
			// 失败原因在执行记录页与轨迹页里读更完整。
			n.type !== "execution",
	);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const baseEdges = graph.edges.filter(
		(e) =>
			byId.has(e.source) &&
			byId.has(e.target) &&
			(e.relation !== "proves" || nodeStatusAt(byId.get(e.target)!, atMs) === "achieved"),
	);
	const edges = options.overview ? canonicalOverviewEdges(baseEdges) : baseEdges;
	const referenced = new Set(["fact:origin"]);
	const outputs = new Map<string, string[]>();
	for (const e of edges) {
		referenced.add(e.source);
		referenced.add(e.target);
		if (
			e.relation === "produces" &&
			byId.get(e.source)!.type === "step" &&
			byId.get(e.target)!.type === "fact" &&
			e.target !== "fact:origin"
		) {
			if (!outputs.has(e.source)) outputs.set(e.source, []);
			outputs.get(e.source)!.push(e.target);
		}
	}
	const groups = new Map<string, string[]>();
	const hidden = new Set<string>();
	if (options.compact) {
		for (const [step, facts] of outputs) {
			// 折叠模式收起所有产出事实，即便它还支持别的步骤或是目标证据。
			// 关键关系在展开后原样出现，默认画布则不会变成事实的蜘蛛网。
			if (!facts.length) continue;
			groups.set(step, facts);
			if (!options.expanded[byId.get(step)!.ref_id]) facts.forEach((id) => hidden.add(id));
		}
		const grouped = new Set([...groups.values()].flat());
		const unscoped = nodes
			.filter((n) => n.type === "fact" && n.id !== "fact:origin" && !grouped.has(n.id))
			.map((n) => n.id);
		if (unscoped.length) {
			const key = "__unscoped_facts__";
			groups.set(key, unscoped);
			if (!options.expanded[key]) unscoped.forEach((id) => hidden.add(id));
		}
	}
	// 未归属的手动事实通常没有边，因此即使点了“展开”也会被“隐藏孤立事实”
	// 的筛选误杀。分组被显式展开就是展示它们的明确意图。
	const expandedFacts = new Set<string>();
	if (options.compact) {
		for (const [step, facts] of groups) {
			const refId = byId.get(step)?.ref_id ?? step;
			if (options.expanded[refId]) facts.forEach((id) => expandedFacts.add(id));
		}
		for (const id of expandedFacts) hidden.delete(id);
	}
	const visible = nodes.filter(
		(n) =>
			!hidden.has(n.id) &&
			(n.type !== "fact" || options.isolated || referenced.has(n.id) || expandedFacts.has(n.id)),
	);
	const visibleIds = new Set(visible.map((n) => n.id));
	const elements: ElementDefinition[] = visible.map((n) => {
		const status = nodeStatusAt(n, atMs);
		const cls: string[] = [n.type];
		if (n.type === "fact" && n.ref_id === "origin") cls.push("origin");
		if (n.type === "goal") {
			if (n.ref_id === "goal") cls.push("goal-root");
			if (status) cls.push(`goal-${status}`);
		}
		if (n.type === "step" && status)
			cls.push(status === "concluded" ? "concluded" : `ph-${status}`);
		const statusLabel = statusLabels[status ?? ""] ?? status;
		return {
			data: {
				id: n.id,
				kind: n.type,
				refId: n.ref_id,
				// 画布是用来读拓扑的，不是详情页：固定显示类型/id，再放两行短摘要，
				// 完整正文在右侧检查器中读取，避免适应画布时文字缩成噪点。
				label: canvasLabel(n, statusLabel),
			},
			classes: cls.join(" "),
		};
	});
	for (const raw of edges) {
		// 存储关系的方向表达语义（父目标→子目标、后置步骤→前置步骤），
		// 但画布应沿工作流从左到右阅读。只在渲染层反转这两类边，数据协议不变。
		const e =
			raw.relation === "decomposes_to" || raw.relation === "depends_on"
				? { ...raw, source: raw.target, target: raw.source }
				: raw;
		if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) continue;
		elements.push({
			data: {
				id: e.id,
				source: e.source,
				target: e.target,
				relation: e.relation,
				label: "",
			},
			classes:
				e.relation === "proves"
					? "edge-proves achieve"
					: ["depends_on", "decomposes_to", "serves"].includes(e.relation)
						? `edge-${e.relation} subgoal`
						: `edge-${e.relation}`,
		});
	}
	for (const [step, facts] of groups) {
		const source = byId.get(step);
		if (source && !visibleIds.has(step)) continue;
		const refId = source?.ref_id ?? step;
		const id = `group:${step}`;
		elements.push({
			data: {
				id,
				kind: "fact-group",
				refId,
				label: `${options.expanded[refId] ? "收起" : "展开"}${source ? "" : "未归类"} ${facts.length} 个事实`,
			},
			classes: "fact-group",
		});
		if (source)
			elements.push({
				data: { id: `group-edge:${step}`, source: step, target: id },
				classes: "subgoal",
			});
	}
	return elements;
}

/** Navigation currently uses business ids (and _step_ ids); graph identities remain typed. */
export function resolveGraphFocus(graph: ProjectGraph, focus: string): GraphNode | undefined {
	return (
		graph.nodes.find((n) => n.id === focus) ??
		graph.nodes.find((n) =>
			focus.startsWith("_step_")
				? n.type === "step" && n.ref_id === focus.slice(6)
				: n.ref_id === focus,
		)
	);
}
