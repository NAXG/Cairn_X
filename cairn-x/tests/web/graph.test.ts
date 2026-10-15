import { expect, test } from "vitest";
import {
	NODE_SIZES,
	buildGraphElements,
	labelWidthLimit,
	textUnits,
} from "../../src/web/features/graph/elements.js";
import { fixtureGraph, graphNode, graphEdge } from "./graph-fixture.js";
const options = { compact: true, isolated: false, expanded: {} };
test("compact output expands without hiding causal inputs", () => {
	const graph = fixtureGraph();
	const compact = buildGraphElements(graph, options);
	expect(compact.some((e) => e.data.id === "fact:origin")).toBe(true);
	expect(compact.some((e) => e.data.id === "fact:f1")).toBe(false);
	expect(compact.some((e) => e.data.id === "group:step:s1")).toBe(true);
	expect(
		buildGraphElements(graph, { ...options, expanded: { s1: true } }).some(
			(e) => e.data.id === "fact:f1",
		),
	).toBe(true);
});
test("replay excludes future steps and output facts", () => {
	const els = buildGraphElements(
		fixtureGraph(),
		{ ...options, compact: false, isolated: true },
		Date.parse("2026-01-01"),
	);
	expect(els.map((e) => e.data.id)).toEqual(["fact:origin"]);
});
test("compact mode hides even Fact evidence until its producer group is expanded", () => {
	const graph = fixtureGraph();
	graph.nodes.push(graphNode("finding", "r1"));
	graph.edges.push(graphEdge("fact:f1", "supports", "finding:r1"));
	const elements = buildGraphElements(graph, options);
	expect(elements.some((e) => e.data.id === "fact:f1")).toBe(false);
	expect(elements.some((e) => e.data.id === "group:step:s1")).toBe(true);
	expect(elements.some((e) => e.data.source === "step:s1" && e.data.target === "finding:r1")).toBe(
		false,
	);
	const visibleNodeIds = new Set(elements.filter((e) => !e.data.source).map((e) => e.data.id));
	for (const e of elements.filter((e) => e.data.source)) {
		expect(visibleNodeIds.has(e.data.source)).toBe(true);
		expect(visibleNodeIds.has(e.data.target)).toBe(true);
	}
});
test("compact mode groups manually added facts that have no producing step", () => {
	const graph = fixtureGraph();
	graph.nodes.push(graphNode("fact", "manual"));
	const compact = buildGraphElements(graph, options);
	expect(compact.some((e) => e.data.id === "fact:manual")).toBe(false);
	expect(compact.some((e) => e.data.id === "group:__unscoped_facts__")).toBe(true);
	const expanded = buildGraphElements(graph, {
		...options,
		expanded: { __unscoped_facts__: true },
	});
	expect(expanded.some((e) => e.data.id === "fact:manual")).toBe(true);
});
test("executions never reach the canvas; retried steps carry their attempt count", () => {
	const graph = fixtureGraph();
	graph.nodes.push(graphNode("execution", "s1"));
	graph.edges.push(graphEdge("step:s1", "has_execution", "execution:s1"));
	const elements = buildGraphElements(graph, options);
	// 执行层被彻底移除：既没有执行节点，也没有 has_execution 边。
	expect(elements.some((e) => e.data.id === "execution:s1")).toBe(false);
	expect(elements.some((e) => e.data.relation === "has_execution")).toBe(false);
	// 一次尝试的步骤不加标记；多次尝试才在标题里写明，避免节点变宽后文字被裁。
	const step = elements.find((e) => e.data.id === "step:s1")!;
	expect(String(step.data.label).startsWith("步骤 s1\n")).toBe(true);
	graph.nodes.find((n) => n.id === "step:s1")!.attempt = 3;
	const retried = buildGraphElements(graph, options).find((e) => e.data.id === "step:s1")!;
	expect(String(retried.data.label).startsWith("步骤 s1 · 3 次尝试\n")).toBe(true);
});

test("overview keeps a readable mainline and makes duplicate routes opt-in", () => {
	const graph = fixtureGraph();
	graph.nodes.push(
		graphNode("goal", "goal", { status: "achieved" }),
		graphNode("goal", "g1", { status: "achieved" }),
		graphNode("route", "t1"),
		graphNode("finding", "r1"),
	);
	graph.edges.push(
		graphEdge("step:s1", "serves", "goal:g1"),
		graphEdge("step:s1", "serves", "goal:goal"),
		graphEdge("step:s1", "serves", "route:t1"),
		graphEdge("route:t1", "serves", "goal:g1"),
		graphEdge("step:s1", "produces", "finding:r1"),
		graphEdge("finding:r1", "proves", "goal:g1"),
		graphEdge("finding:r1", "proves", "goal:goal"),
		graphEdge("goal:goal", "decomposes_to", "goal:g1"),
	);
	const overview = buildGraphElements(graph, { ...options, overview: true });
	expect(overview.some((e) => e.data.id === "route:t1")).toBe(false);
	expect(
		overview.some((e) => e.data.id === "goal:goal" && e.data.label.startsWith("根目标\n")),
	).toBe(true);
	const decomposition = overview.find((e) => e.data.relation === "decomposes_to");
	expect(decomposition?.data).toMatchObject({ source: "goal:g1", target: "goal:goal", label: "" });
	expect(
		overview.some((e) => e.data.source === "finding:r1" && e.data.target === "goal:goal"),
	).toBe(false);
	expect(overview.some((e) => e.data.source === "step:s1" && e.data.target === "goal:goal")).toBe(
		false,
	);
	const withRoutes = buildGraphElements(graph, { ...options, showRoutes: true });
	expect(withRoutes.some((e) => e.data.id === "route:t1")).toBe(true);
});

test("canvas labels drop markup and stay inside their node box", () => {
	const graph = fixtureGraph();
	const title =
		"长任务「规划→执行→复盘」闭环方法学（可操作版，含输入/动作/产出/判定标准、来源、限制与待验证点）";
	graph.nodes.push(
		graphNode("finding", "r1", {
			label: title,
			description: `# ${title}\n\n## 适用对象\n多轮、跨会话、步骤相互依赖的长任务，单上下文装不下全部信息`,
		}),
		graphNode("goal", "g1", {
			status: "achieved",
			description: "比较至少三类模型目录更新机制，并说明各自的新鲜度、缓存与失败回退",
		}),
		graphNode("goal", "goal", {
			status: "achieved",
			description: "交付一份结构化研究结论：至少比较三类模型目录更新机制及其新鲜度、缓存和失败回退",
		}),
		graphNode("step", "s9", {
			status: "concluded",
			description:
				"问题：完成研究目标第 1 项——横向比较至少三类 AI 供应商「模型目录/模型列表」更新机制",
		}),
	);
	const elements = buildGraphElements(graph, { ...options, overview: true });
	for (const element of elements) {
		if (element.data.source) continue;
		if (element.data.kind === "fact-group") {
			expect(textUnits(String(element.data.label)) * 10).toBeLessThanOrEqual(
				NODE_SIZES["fact-group"].width - 20,
			);
			continue;
		}
		const node = graph.nodes.find((n) => n.id === element.data.id)!;
		for (const line of String(element.data.label).split("\n")) {
			// Cytoscape 只在空格处断行，中文长句必须靠我们自己折行；每行还要让开
			// 菱形/六边形在中线以外收窄的宽度，否则文字会压到边线上。
			expect(textUnits(line) * 11).toBeLessThanOrEqual(labelWidthLimit(node) + 0.5);
		}
	}
	const finding = elements.find((e) => e.data.id === "finding:r1")!;
	expect(String(finding.data.label)).not.toContain("#");
	expect(String(finding.data.label)).toContain("适用对象");
});
