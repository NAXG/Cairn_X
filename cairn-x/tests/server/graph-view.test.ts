import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import { expect, test, onTestFinished } from "vitest";
import { buildGraphElements } from "../../src/web/features/graph/elements.js";
import { reconcileGraph } from "../../src/web/features/graph/reconcile.js";
import { fixtureGraph, graphNode, graphEdge } from "../web/graph-fixture.js";
cytoscape.use(dagre);
function graphApp() {
	const cy = cytoscape({ headless: true });
	onTestFinished(() => cy.destroy());
	const detail = fixtureGraph();
	detail.nodes = [
		graphNode("fact", "origin"),
		graphNode("step", "s1", { status: "open" }),
		graphNode("goal", "goal", { status: "achieved" }),
		...[0, 1, 2].map((i) => graphNode("fact", `f${i}`)),
	];
	detail.edges = [
		graphEdge("fact:origin", "supports", "step:s1"),
		graphEdge("fact:f2", "proves", "goal:goal"),
		...[0, 1, 2].map((i) => graphEdge("step:s1", "produces", `fact:f${i}`)),
	];
	const app = {
		detail,
		compactGraph: true,
		expandedSteps: {} as Record<string, boolean>,
		buildGraphElements(at: number | null) {
			return buildGraphElements(
				this.detail,
				{ compact: this.compactGraph, expanded: this.expandedSteps, isolated: false },
				at,
			);
		},
		updateGraph(at: number | null) {
			reconcileGraph(cy, this.buildGraphElements(at));
		},
	};
	return { app, cy };
}
test("live outputs stay connected to a stable Step node before conclusion", () => {
	const { app } = graphApp();
	app.compactGraph = false;
	const before = app.buildGraphElements(null);
	expect(before.filter((e) => e.data.source === "step:s1")).toHaveLength(3);
	app.detail.nodes.find((n) => n.id === "step:s1")!.status = "concluded";
	expect(app.buildGraphElements(null).map((e) => e.data.id)).toEqual(before.map((e) => e.data.id));
});
test("compact view folds every produced Fact, including goal evidence", () => {
	const { app } = graphApp();
	let elements = app.buildGraphElements(null);
	expect(elements.some((e) => e.data.id === "fact:f2")).toBe(false);
	expect(elements.some((e) => e.data.id === "fact:f0")).toBe(false);
	expect(elements.some((e) => e.data.id === "group:step:s1")).toBe(true);
	app.expandedSteps.s1 = true;
	elements = app.buildGraphElements(null);
	expect(
		elements.filter((e) => e.data.source === "step:s1" && e.data.relation === "produces"),
	).toHaveLength(3);
});
test("polling and new outputs preserve existing positions and viewport", () => {
	const { app, cy } = graphApp();
	app.compactGraph = false;
	app.updateGraph(null);
	cy.getElementById("step:s1").position({ x: 777, y: 333 });
	cy.pan({ x: 40, y: 50 });
	cy.zoom(1.7);
	app.detail.nodes.find((n) => n.id === "step:s1")!.status = "concluded";
	app.detail.nodes.push(graphNode("fact", "new"));
	const edge = graphEdge("step:s1", "produces", "fact:new");
	app.detail.edges.push(edge);
	app.updateGraph(null);
	expect(cy.getElementById("step:s1").position()).toMatchObject({ x: 777, y: 333 });
	expect(cy.zoom()).toBe(1.7);
	expect(cy.pan()).toEqual({ x: 40, y: 50 });
	expect(cy.getElementById(edge.id).length).toBe(1);
});
