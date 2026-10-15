import { expect, test } from "vitest";
import { createProject, createTestServer, get, post } from "./helpers.js";

test("removed full-read endpoints return 404 and current read views remain available", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	for (const path of [
		"/projects",
		`/projects/${pid}`,
		`/projects/${pid}/executions`,
		`/projects/${pid}/activities`,
		`/projects/${pid}/sessions`,
		`/projects/${pid}/graph`,
		`/projects/${pid}/graph?view=canvas`,
		`/projects/${pid}/graph/nodes/fact/origin`,
	])
		expect((await get(app, path)).status).toBe(404);
	for (const path of [
		"/projects/page",
		`/projects/${pid}/overview`,
		`/projects/${pid}/records/fact/origin`,
		`/projects/${pid}/graph/canvas`,
		`/projects/${pid}/activities/page`,
	])
		expect((await get(app, path)).status).toBe(200);
	const created = await post(app, "/projects", {
		title: "compact",
		origin: "origin",
		goal: "goal",
	});
	const data = await created.json();
	expect(created.status).toBe(201);
	expect(Object.keys(data)).toEqual(["project"]);
});
