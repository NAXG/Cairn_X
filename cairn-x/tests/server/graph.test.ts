import { projectGraph } from "../../src/server/core/graph.js";
import { expect, test } from "vitest";
import { createApp } from "../../src/server/app.js";
import { relationAllows } from "../../src/contracts/graph.js";
import { createProject, createTestServer, get, post } from "./helpers.js";

test("relation registry validates endpoint pairs, not just relation names", () => {
	expect(relationAllows("proves", "fact", "goal")).toBe(true);
	expect(relationAllows("proves", "execution", "goal")).toBe(false);
	expect(relationAllows("supports", "fact", "finding")).toBe(true);
	expect(relationAllows("has_execution", "execution", "step")).toBe(false);
});

test("graph endpoints inherit authentication; execution tokens cannot access machine reads", async () => {
	const { db, pid, base } = await fixture();
	const app = createApp(db, { user: "test", password: "pass", apiToken: "machine" });
	for (const route of [
		"/graph/canvas",
		"/records/fact/origin",
		"/graph/lineage/fact/origin",
		"/goals/goal/evidence",
	]) {
		expect((await get(app, base + route)).status).toBe(401);
		expect(
			(await app.request(base + route, { headers: { Authorization: "Bearer execution-token" } }))
				.status,
		).toBe(401);
		expect(
			(await app.request(base + route, { headers: { Authorization: "Bearer machine" } })).status,
		).toBe(200);
	}
	expect(
		(
			await app.request(`/projects/${pid}/graph/canvas?worker=stale`, {
				headers: { Authorization: "Bearer machine" },
			})
		).status,
	).toBe(409);
});

async function fixture() {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "inspect",
		goal_id: "goal",
	});
	const now = "2026-01-01T00:00:00Z";
	db.prepare(
		"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at, token_hash) VALUES (?, ?, 's001', 1, 0, 'lost', ?, 'SECRET')",
	).run("e1", pid, now);
	db.prepare(
		"INSERT INTO facts (id, project_id, description, step_id, execution_id, created_at) VALUES ('f1', ?, 'observation', 's001', 'e1', ?)",
	).run(pid, now);
	db.prepare(
		"INSERT INTO findings (id, project_id, title, description, fact_ids, step_id, execution_id, created_at) VALUES ('r1', ?, 'result', 'confirmed', '[\"f1\"]', 's001', 'e1', ?)",
	).run(pid, now);
	db.prepare(
		"UPDATE goals SET status='achieved', achieved_description='evidence', achieved_at=? WHERE project_id=?",
	).run(now, pid);
	db.prepare(
		"INSERT INTO goal_evidence (project_id, goal_id, evidence_type, evidence_id, created_at) VALUES (?, 'goal', 'fact', 'f1', ?)",
	).run(pid, now);
	return { app, db, pid, base: `/projects/${pid}` };
}

test("projects typed relations from existing records, including live outputs and exact attempts", async () => {
	const { app, db, pid, base } = await fixture();
	const response = await get(app, `${base}/graph/canvas`);
	expect(response.status).toBe(200);
	const canvas = await response.json();
	expect(
		canvas.nodes.some((n: { type: string }) => n.type === "execution" || n.type === "hint"),
	).toBe(false);
	const graph = projectGraph(db, pid);
	const edges = graph.edges.map((e: any) => [e.source, e.relation, e.target]);
	expect(edges).toEqual(
		expect.arrayContaining([
			["fact:origin", "supports", "step:s001"],
			["step:s001", "produces", "fact:f1"],
			["fact:f1", "supports", "finding:r1"],
			["fact:f1", "proves", "goal:goal"],
			["step:s001", "has_execution", "execution:e1"],
			["execution:e1", "produces", "finding:r1"],
			["step:s001", "serves", "goal:goal"],
		]),
	);
	expect(graph.edges.filter((e: any) => e.relation === "proves")).toHaveLength(1);
	expect(JSON.stringify(graph)).not.toContain("SECRET");
	expect(graph.nodes.find((n: any) => n.id === "execution:e1")!.status).toBe("lost");
	expect((await (await get(app, `${base}/records/finding/r1`)).json()).record.description).toBe(
		"confirmed",
	);
	expect(await (await get(app, `${base}/graph/canvas`)).json()).toEqual(canvas);
});

test("lineage excludes unrelated execution topology unless requested", async () => {
	const { app, base } = await fixture();
	const normal = await (await get(app, `${base}/graph/lineage/finding/r1?direction=up`)).json();
	expect(normal.nodes.map((n: any) => n.id)).toEqual([
		"fact:f1",
		"fact:origin",
		"finding:r1",
		"step:s001",
	]);
	const expanded = await (
		await get(app, `${base}/graph/lineage/finding/r1?include_execution=true`)
	).json();
	expect(expanded.nodes.map((n: any) => n.id)).toContain("execution:e1");
	const downstream = await (
		await get(app, `${base}/graph/lineage/fact/origin?direction=down`)
	).json();
	expect(downstream.nodes.map((n: any) => n.id)).toContain("finding:r1");
	const evidence = await (await get(app, `${base}/goals/goal/evidence`)).json();
	expect(evidence.goal.achieved_description).toBe("evidence");
	expect(evidence.evidence.map((n: any) => n.id)).toEqual(["fact:f1"]);
	expect(evidence.lineage.nodes.map((n: any) => n.id)).toContain("execution:e1");
});

test("bounds traversal, rejects invalid queries and handles cycles deterministically", async () => {
	const { app, db, pid, base } = await fixture();
	db.prepare(
		"INSERT INTO step_sources (step_id, project_id, fact_id) VALUES ('s001', ?, 'f1')",
	).run(pid);
	const graph = await (await get(app, `${base}/graph/lineage/finding/r1?max_nodes=2`)).json();
	expect(graph.nodes).toHaveLength(2);
	expect(graph.truncated).toBe(true);
	const shallow = await (await get(app, `${base}/graph/lineage/finding/r1?depth=0`)).json();
	expect(shallow.nodes).toHaveLength(1);
	expect(shallow.truncated).toBe(true);
	const cyclic = await (await get(app, `${base}/graph/lineage/finding/r1`)).json();
	expect(cyclic.nodes).toHaveLength(4);
	expect(cyclic.truncated).toBe(false);
	for (const query of [
		"direction=side",
		"depth=-1",
		"max_nodes=0",
		"max_nodes=2001",
		"relations=invalid",
		"include_execution=yes",
		"depth=1.2",
	]) {
		expect((await get(app, `${base}/graph/lineage/finding/r1?${query}`)).status).toBe(400);
	}
	expect((await get(app, `${base}/records/invalid/r1`)).status).toBe(400);
	expect((await get(app, `${base}/records/fact/missing`)).status).toBe(404);
});

test("large evidence lists and dense slices respect node and edge budgets", async () => {
	const { app, db, pid, base } = await fixture();
	db.transaction(() => {
		const insert = db.prepare(
			"INSERT INTO facts (id, project_id, description, created_at) VALUES (?, ?, 'evidence', '2026-01-01')",
		);
		for (let i = 0; i < 250; i++) {
			insert.run(`bulk-${i}`, pid);
		}
		db.prepare(
			"INSERT OR IGNORE INTO goal_evidence (project_id, goal_id, evidence_type, evidence_id, created_at) SELECT ?, 'goal', 'fact', id, '2026-01-01' FROM facts WHERE project_id = ? AND id != 'origin'",
		).run(pid, pid);
	})();
	const result = await (await get(app, `${base}/goals/goal/evidence?max_nodes=10`)).json();
	expect(result.evidence_total).toBe(251);
	expect(result.evidence).toHaveLength(9);
	expect(result.lineage.nodes).toHaveLength(10);
	expect(result.lineage.truncated).toBe(true);
	const edges = await (
		await get(app, `${base}/graph/lineage/finding/r1?max_edges=1&include_execution=true`)
	).json();
	expect(edges.edges).toHaveLength(1);
	expect(edges.truncated).toBe(true);
	for (const edge of edges.edges) {
		expect(edges.nodes.some((n: any) => n.id === edge.source)).toBe(true);
		expect(edges.nodes.some((n: any) => n.id === edge.target)).toBe(true);
	}
});

test("scopes all nodes and endpoints to the project and reports dangling references", async () => {
	const { app, db, pid, base } = await fixture();
	const other = await createProject(app);
	db.prepare(
		"INSERT INTO facts (id, project_id, description, created_at) VALUES ('foreign', ?, 'private', '2026-01-01')",
	).run(other);
	db.prepare(
		"INSERT INTO step_sources (step_id, project_id, fact_id) VALUES ('s001', ?, 'foreign')",
	).run(pid);
	const graph = await (await get(app, `${base}/graph/canvas`)).json();
	expect(graph.stats.dangling_edges).toBe(1);
	expect(JSON.stringify(graph)).not.toContain("private");
	expect(graph.edges.some((e: any) => e.source === "fact:foreign")).toBe(false);
	expect((await get(app, `${base}/records/fact/foreign`)).status).toBe(404);
	expect((await get(app, `/projects/${other}/executions/e1/detail`)).status).toBe(404);
	expect((await get(app, "/projects/missing/graph/canvas")).status).toBe(404);
});

test("dependency direction is semantic and non-causal relations require explicit selection", async () => {
	const { app, db, pid, base } = await fixture();
	await post(app, `${base}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "next",
		waiting_on: ["s001"],
	});
	db.prepare(
		"INSERT INTO goals (id, project_id, parent_goal_id, description, created_at) VALUES ('g1', ?, 'goal', 'child', '2026-01-01')",
	).run(pid);
	const graph = await (await get(app, `${base}/graph/canvas`)).json();
	expect(graph.edges).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ source: "step:s002", relation: "depends_on", target: "step:s001" }),
			expect.objectContaining({
				source: "goal:goal",
				relation: "decomposes_to",
				target: "goal:g1",
			}),
		]),
	);
	const dependency = await (
		await get(app, `${base}/graph/lineage/step/s002?relations=depends_on&direction=up`)
	).json();
	expect(dependency.nodes.map((n: any) => n.id)).toEqual(["step:s001", "step:s002"]);
	const defaults = await (await get(app, `${base}/graph/lineage/goal/goal`)).json();
	expect(defaults.nodes.map((n: any) => n.id)).not.toContain("goal:g1");
});
