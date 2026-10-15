import { inspectProjectResponse } from "../support/project-state.js";
import { expect, test } from "vitest";

import { createProject, createTestServer, del, get, post, readPlanningGraph } from "./helpers.js";

test("sub goals can be created under the root by default and under a given parent", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const first = await post(app, `/projects/${pid}/goals`, { actor: "human", description: "recon" });
	expect(first.status).toBe(201);
	const g1 = await first.json();
	expect(g1).toMatchObject({
		id: "g001",
		parent_goal_id: "goal",
		description: "recon",
		status: "pending",
	});

	const second = await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		description: "port scan",
		parent_goal_id: "g001",
	});
	expect(second.status).toBe(201);
	expect((await second.json()).parent_goal_id).toBe("g001");

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.goals.map((g: { id: string }) => g.id)).toEqual(["goal", "g001", "g002"]);
});

test("root goal achieved by the decide worker commits its planning checkpoint", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);

	// 与真实 decide 相同：先认领租约（fresh 项目触发 initial_run），再达成根目标。
	const claim = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "decide:test",
		min_interval_seconds: 0,
	});
	expect(claim.status).toBe(200);
	await readPlanningGraph(app, pid, "decide:test");

	const achieve = await post(app, `/projects/${pid}/goals/goal/achieve`, {
		worker: "decide:test",
		from: [{ type: "fact", id: "origin" }],
		description: "goal satisfied",
	});
	expect(achieve.status).toBe(200);

	// 项目完成后 Dispatcher 会取消在途 decide，checkpoint 必须在达成事务内推进：
	// 否则它永远停在旧版本（proj_003 现场）。
	const checkpoint = db
		.prepare("SELECT * FROM decide_checkpoints WHERE project_id = ?")
		.get(pid) as Record<string, unknown>;
	expect(checkpoint.planning_version).toBe(1);
	expect(checkpoint.last_completed_by).toBe("decide:test");
	expect(checkpoint.last_trigger).toBe("initial_run");
	expect(checkpoint.fact_count).toBe(1);

	// 完成语义不变：项目 completed、decide 租约已清。
	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.project.status).toBe("completed");
	expect(detail.project.decide).toBeNull();
});

test("sub goal creation validates parent and project status", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);

	const missing = await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		description: "x",
		parent_goal_id: "g404",
	});
	expect(missing.status).toBe(404);
	expect((await missing.json()).detail).toBe("Goal not found");

	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "doomed" });
	db.prepare("UPDATE goals SET status = 'abandoned' WHERE id = 'g001' AND project_id = ?").run(pid);
	const abandonedParent = await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		description: "orphan",
		parent_goal_id: "g001",
	});
	expect(abandonedParent.status).toBe(409);
	expect((await abandonedParent.json()).detail).toBe("Parent goal is abandoned");

	await post(app, `/projects/${pid}/status`, { status: "stopped" });
	const stopped = await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		description: "blocked",
	});
	expect(stopped.status).toBe(403);
});

test("only pending sub goals can be deleted; the root goal is protected", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "parent" });
	await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		description: "child",
		parent_goal_id: "g001",
	});
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "deletable" });

	const root = await del(app, `/projects/${pid}/goals/goal`);
	expect(root.status).toBe(400);
	expect((await root.json()).detail).toBe("Root goal cannot be deleted");

	const withChildren = await del(app, `/projects/${pid}/goals/g001`);
	expect(withChildren.status).toBe(409);
	expect((await withChildren.json()).detail).toBe("Goal has pending sub goals");

	const ok = await del(app, `/projects/${pid}/goals/g003`);
	expect(ok.status).toBe(204);
	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.goals.map((g: { id: string }) => g.id)).toEqual(["goal", "g001", "g002"]);

	const gone = await del(app, `/projects/${pid}/goals/g003`);
	expect(gone.status).toBe(404);
});

test("deleting an achieved goal is rejected", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "recon" });
	await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "recon done",
	});

	const res = await del(app, `/projects/${pid}/goals/g001`);
	expect(res.status).toBe(409);
	expect((await res.json()).detail).toBe("Goal is achieved");
});

test("deleting a pending goal with achieved children reparents them", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "parent" });
	await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		description: "achieved child",
		parent_goal_id: "g001",
	});

	// Achieve the child so g001 has an achieved (non-pending) sub goal.
	await post(app, `/projects/${pid}/goals/g002/achieve`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "child done",
	});

	// g001 can now be deleted because its only child is achieved, not pending.
	const res = await del(app, `/projects/${pid}/goals/g001`);
	expect(res.status).toBe(204);

	const detail = await (await inspectProjectResponse(app, pid)).json();
	const goals = detail.goals.map((g: { id: string; parent_goal_id: string | null }) => ({
		id: g.id,
		parent: g.parent_goal_id,
	}));
	expect(goals).toEqual([
		{ id: "goal", parent: null },
		{ id: "g002", parent: "goal" },
	]);
});

test("deleting a sub goal reparents its routes without dangling graph edges", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "parent" });
	await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		parent_goal_id: "g001",
		description: "temporary child",
	});
	const route = await post(app, `/projects/${pid}/routes`, {
		actor: "human",
		goal_id: "g002",
		description: "investigate route",
	});
	expect(route.status).toBe(201);
	expect((await del(app, `/projects/${pid}/goals/g002`)).status).toBe(204);
	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.routes[0].goal_id).toBe("g001");
	const graph = await (await get(app, `/projects/${pid}/graph/canvas`)).json();
	expect(graph.stats.dangling_edges).toBe(0);
	expect(graph.edges).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ source: "route:t001", relation: "serves", target: "goal:g001" }),
		]),
	);
});

test("achieving a sub goal records provenance without completing the project", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "recon" });

	const res = await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "recon done",
	});
	expect(res.status).toBe(200);
	const goal = await res.json();
	expect(goal).toMatchObject({
		id: "g001",
		status: "achieved",
		evidence: [{ type: "fact", id: "origin" }],
		achieved_description: "recon done",
	});
	expect(goal.achieved_at).not.toBeNull();

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.project.status).toBe("active");

	const again = await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "twice",
	});
	expect(again.status).toBe(409);
	expect((await again.json()).detail).toBe("Goal already achieved");
});

test("achieve validates fact references and goal existence", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/goals`, { actor: "human", description: "recon" });

	const missingGoal = await post(app, `/projects/${pid}/goals/g404/achieve`, {
		actor: "human",
		from: [{ type: "fact", id: "origin" }],
		description: "x",
	});
	expect(missingGoal.status).toBe(404);

	const missingFact = await post(app, `/projects/${pid}/goals/g001/achieve`, {
		actor: "human",
		from: [{ type: "fact", id: "f404" }],
		description: "x",
	});
	expect(missingFact.status).toBe(404);
	expect((await missingFact.json()).detail).toBe("Fact f404 not found");
});

test("achieving the root goal completes the project and clears the decide lease", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "decider",
	});
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "executor" });
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "measured evidence",
		step_id: "s001",
	});
	await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "executor",
		description: "result",
	});
	await post(app, `/projects/${pid}/decide/claim`, { worker: "decider", trigger: "steps closed" });

	const res = await post(app, `/projects/${pid}/goals/goal/achieve`, {
		actor: "human",
		from: [{ type: "fact", id: "f001" }],
		description: "all done",
	});
	expect(res.status).toBe(200);
	expect((await res.json()).status).toBe("achieved");

	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.project.status).toBe("completed");
	expect(detail.project.decide).toBeNull();

	const write = await post(app, `/projects/${pid}/goals`, { actor: "human", description: "late" });
	expect(write.status).toBe(403);
});
