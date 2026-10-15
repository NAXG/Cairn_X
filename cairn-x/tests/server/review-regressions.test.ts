import { workbenchRecord } from "../../src/server/core/workbench.js";
import { inspectProjectResponse } from "../support/project-state.js";
import { expect, test, vi } from "vitest";

import {
	createProject,
	createTestServer,
	post,
	del,
	backdateStepHeartbeat,
	backdateDecideHeartbeat,
	readPlanningGraph,
} from "./helpers.js";

async function stepFixture() {
	const server = createTestServer();
	const pid = await createProject(server.app);
	const step = await post(server.app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "inspect",
		creator: "human",
	});
	expect(step.status).toBe(201);
	expect(
		(await post(server.app, `/projects/${pid}/steps/s001/claim`, { worker: "attempt-a" })).status,
	).toBe(200);
	return { ...server, pid, base: `/projects/${pid}` };
}

test("expired attempts cannot renew, conclude, or write evidence; a new claim can", async () => {
	const { app, db, pid, base } = await stepFixture();
	backdateStepHeartbeat(db, pid, "s001", "2000-01-01T00:00:00Z");
	for (const worker of ["attempt-a", "attempt-b"]) {
		expect((await post(app, `${base}/steps/s001/heartbeat`, { worker })).status).toBe(409);
		expect(
			(await post(app, `${base}/steps/s001/conclude`, { worker, description: "stale summary" }))
				.status,
		).toBe(409);
	}
	const claim = await post(app, `${base}/steps/s001/claim`, { worker: "attempt-b" });
	expect(claim.status).toBe(200);
	expect(claim.headers.get("X-Lease-Timeout")).toBe("120");
	for (const endpoint of ["facts", "findings"]) {
		const body = {
			confidence: "observed",
			worker: "attempt-a",
			actor: "human",
			step_id: "s001",
			title: "stale",
			description: "stale evidence",
		};
		expect((await post(app, `${base}/${endpoint}`, body)).status).toBe(409);
		expect((await post(app, `${base}/${endpoint}`, { ...body, worker: "attempt-b" })).status).toBe(
			201,
		);
	}
	expect(
		(
			await post(app, `${base}/steps/s001/conclude`, {
				worker: "attempt-b",
				description: "I infer it may be closed",
			})
		).status,
	).toBe(200);
	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.facts).toHaveLength(2);
	expect(detail.facts.some((f: { description: string }) => f.description.includes("I infer"))).toBe(
		false,
	);
	expect(detail.steps[0]).toMatchObject({ summary: "I infer it may be closed" });
});

test("stale Decide cannot mutate graphs, even when actor=human is also supplied", async () => {
	const { app, db, pid, base } = await stepFixture();
	await post(app, `${base}/decide/claim`, { worker: "old" });
	backdateDecideHeartbeat(db, pid, "2000-01-01T00:00:00Z");
	await post(app, `${base}/decide/signal`, { signal: "rotate" });
	await post(app, `${base}/decide/claim`, { worker: "new" });
	await readPlanningGraph(app, pid, "new");
	for (const endpoint of ["complete", "goals/goal/achieve"]) {
		expect(
			(
				await post(app, `${base}/${endpoint}`, {
					worker: "old",
					actor: "human",
					from: [{ type: "fact", id: "origin" }],
					description: "done",
				})
			).status,
		).toBe(409);
	}
	expect((await post(app, `${base}/goals`, { worker: "old", description: "stale" })).status).toBe(
		409,
	);
	expect(
		(
			await post(app, `${base}/steps`, {
				decide_worker: "old",
				from: ["origin"],
				description: "stale",
				creator: "old",
			})
		).status,
	).toBe(409);
	expect((await inspectProjectResponse(app, pid)).status).toBe(200);
	expect(
		(
			await post(app, `${base}/complete`, {
				worker: "new",
				from: [{ type: "fact", id: "origin" }],
				description: "done",
			})
		).status,
	).toBe(200);
});

test("graph writes require explicit human intent or a lease", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	expect(
		(await post(app, `/projects/${pid}/facts`, { confidence: "observed", description: "implicit" }))
			.status,
	).toBe(400);
	expect((await post(app, `/projects/${pid}/goals`, { description: "implicit" })).status).toBe(400);
	expect(
		(
			await post(app, `/projects/${pid}/facts`, {
				confidence: "observed",
				actor: "human",
				description: "explicit",
			})
		).status,
	).toBe(201);
});

test.each(["complete", "goals/goal/achieve"])(
	"%s cannot leave pending subgoals or manufacture facts",
	async (endpoint) => {
		const { app } = createTestServer();
		const pid = await createProject(app);
		const base = `/projects/${pid}`;
		await post(app, `${base}/goals`, { actor: "human", description: "stage" });
		const body = {
			actor: "human",
			from: [{ type: "fact", id: "origin" }],
			description: "finished",
		};
		expect((await post(app, `${base}/${endpoint}`, body)).status).toBe(409);
		await post(app, `${base}/goals/g001/achieve`, body);
		expect((await post(app, `${base}/${endpoint}`, body)).status).toBe(200);
		const detail = await (await inspectProjectResponse(app, pid)).json();
		expect(detail.facts).toHaveLength(1);
		expect(detail.goals.every((g: { status: string }) => g.status === "achieved")).toBe(true);
	},
);

test("deleting a pending goal detaches referring steps and requires an active project", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	const base = `/projects/${pid}`;
	await post(app, `${base}/goals`, { actor: "human", description: "stage" });
	await post(app, `${base}/steps`, {
		actor: "human",
		from: ["origin"],
		goal_id: "g001",
		description: "inspect",
		creator: "human",
	});
	expect((await del(app, `${base}/goals/g001`)).status).toBe(204);
	expect((await (await inspectProjectResponse(app, pid)).json()).steps[0].goal_id).toBeNull();
	await post(app, `${base}/goals`, { actor: "human", description: "stage 2" });
	await post(app, `${base}/status`, { status: "stopped" });
	expect((await del(app, `${base}/goals/g002`)).status).toBe(403);
});

test("single step records read scoped sources once", async () => {
	const { app, db, pid } = await stepFixture();
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "second",
		creator: "human",
	});
	const spy = vi.spyOn(db, "prepare");
	try {
		const selected = workbenchRecord(db, pid, "step", "s001");
		if (selected.type !== "step") throw new Error("Expected Step");
		expect(selected.record.from).toEqual(["origin"]);
		expect(spy.mock.calls.filter(([sql]) => sql.includes("FROM step_sources"))).toHaveLength(1);
	} finally {
		spy.mockRestore();
	}
});

test("changing lease settings does not revoke an already granted deadline", async () => {
	const { app, db, pid, base } = await stepFixture();
	// An existing lease remains valid even if its heartbeat timestamp precedes a newly configured timeout.
	db.prepare("UPDATE steps SET last_heartbeat_at = ? WHERE project_id = ?").run(
		new Date(Date.now() - 10000).toISOString(),
		pid,
	);
	const setting = await app.request("/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ lease_timeout: 5 }),
	});
	expect(setting.status).toBe(200);
	expect((await post(app, `${base}/steps/s001/claim`, { worker: "attempt-b" })).status).toBe(409);
	const renewed = await post(app, `${base}/steps/s001/heartbeat`, { worker: "attempt-a" });
	expect(renewed.status).toBe(200);
	expect(renewed.headers.get("X-Lease-Timeout")).toBe("5");
	const row = db.prepare("SELECT lease_expires_at FROM steps WHERE project_id = ?").get(pid) as {
		lease_expires_at: string;
	};
	expect(Date.parse(row.lease_expires_at) - Date.now()).toBeLessThanOrEqual(5000);
});
