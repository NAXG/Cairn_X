import { inspectProject } from "../support/project-state.js";
import { expect, test } from "vitest";

import { projectGraph } from "../../src/server/core/graph.js";

import {
	claimDecideForRead,
	createProject,
	createTestServer,
	post,
	readPlanningGraph,
} from "./helpers.js";

test("a route groups steps and stays visible in the planning frontier", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);

	const created = await post(app, `/projects/${pid}/routes`, {
		actor: "human",
		description: "SSRF via the import endpoint",
	});
	expect(created.status).toBe(201);
	const routeId = (await created.json()).id;
	expect(routeId).toBe("t001");

	const inRoute = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "probe the import endpoint",
		route_id: routeId,
		creator: "human",
	});
	expect(inRoute.status).toBe(201);
	expect((await inRoute.json()).route_id).toBe(routeId);

	const outside = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "unrelated recon",
		creator: "human",
	});
	expect(outside.status).toBe(201);

	// 图投影：route 节点 + step --serves--> route 边
	const graph = projectGraph(db, pid);
	expect(graph.nodes.some((n) => n.type === "route" && n.ref_id === routeId)).toBe(true);
	expect(
		graph.edges.some(
			(e) => e.relation === "serves" && e.source === "step:s001" && e.target === `route:${routeId}`,
		),
	).toBe(true);

	// route 记录带步骤统计，Decide 不用自己按 route_id 归类。
	expect(inspectProject(db, pid).routes.find((r) => r.id === routeId)).toMatchObject({
		step_count: 1,
		open_step_count: 1,
		concluded_step_count: 0,
	});

	// 规划前沿必须带上活跃 route 与步骤的 route_id：Decide 靠它判断整条方向是否还在推进。
	await claimDecideForRead(app, pid, "reader");
	const pages = await readPlanningGraph(app, pid, "reader");
	expect(pages.flatMap((page) => page.frontier.routes)).toEqual([
		expect.objectContaining({
			id: routeId,
			description: "SSRF via the import endpoint",
			step_count: 1,
			open_step_count: 1,
		}),
	]);
	expect(
		pages.flatMap((page) => page.frontier.steps).find((step: any) => step.id === "s001"),
	).toMatchObject({ route_id: routeId });

	// 路线没有「放弃」入口：历史索引仍可按 section 分页读回。
	const after = await post(app, `/projects/${pid}/decide/graph`, {
		worker: "reader",
		view: "section",
		section: "routes",
	});
	expect(after.status).toBe(200);
	expect((await after.json()).records.map((r: { id: string }) => r.id)).toContain(routeId);
});

test("省略 goal_id 的路线挂到根目标，指向不存在的目标则被拒绝", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);

	const omitted = await post(app, `/projects/${pid}/routes`, {
		actor: "human",
		description: "省略目标的路线",
	});
	expect(omitted.status).toBe(201);
	expect((await omitted.json()).goal_id).toBe("goal");

	const child = await post(app, `/projects/${pid}/goals`, {
		actor: "human",
		description: "子目标",
		parent_goal_id: "goal",
	});
	expect(child.status).toBe(201);
	const childId = (await child.json()).id;
	const explicit = await post(app, `/projects/${pid}/routes`, {
		actor: "human",
		description: "明确指向子目标的路线",
		goal_id: childId,
	});
	expect(explicit.status).toBe(201);
	expect((await explicit.json()).goal_id).toBe(childId);

	const invalid = await post(app, `/projects/${pid}/routes`, {
		actor: "human",
		description: "指向不存在的目标",
		goal_id: "g404",
	});
	expect(invalid.status).toBe(404);

	// 图上必须画出 route →serves→ goal，否则路线只能靠步骤反推归属。
	const graph = projectGraph(db, pid);
	expect(
		graph.edges.some(
			(e) => e.relation === "serves" && e.source === "route:t001" && e.target === "goal:goal",
		),
	).toBe(true);
	expect(
		graph.edges.some(
			(e) => e.relation === "serves" && e.source === "route:t002" && e.target === `goal:${childId}`,
		),
	).toBe(true);
});
