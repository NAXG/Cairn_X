import { expect, test } from "vitest";
import {
	issueProjectWorkerToken,
	touchProjectWorker,
	stopProjectWorker,
} from "../../src/server/core/project-workers.js";
import { createTestServer, createProject, get } from "./helpers.js";

test("environment observation distinguishes missing, preparing, live, stale and stopped without credentials", async () => {
	const { app, db } = createTestServer();
	const project = await createProject(app);
	const url = `/projects/${project}/environment`;
	expect((await get(app, "/projects/missing/environment")).status).toBe(404);
	expect(await (await get(app, url)).json()).toEqual({ status: "unavailable", last_seen_at: null });
	issueProjectWorkerToken(db, project, "private-container");
	expect(await (await get(app, url)).json()).toEqual({ status: "pending", last_seen_at: null });
	touchProjectWorker(db, project);
	const live = await (await get(app, url)).json();
	expect(live.status).toBe("running");
	expect(Object.keys(live).sort()).toEqual(["last_seen_at", "status"]);
	db.prepare(
		"UPDATE project_workers SET last_seen_at='2020-01-01T00:00:00Z' WHERE project_id=?",
	).run(project);
	expect((await (await get(app, url)).json()).status).toBe("unresponsive");
	stopProjectWorker(db, project);
	expect((await (await get(app, url)).json()).status).toBe("stopped");
});
