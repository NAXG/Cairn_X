import { inspectProjectResponse } from "../support/project-state.js";
import { expect, test } from "vitest";

import {
	backdateStepHeartbeat,
	createProject,
	createTestServer,
	patch,
	post,
	readPlanningGraph,
	secondsAgo,
} from "./helpers.js";

test("step lifecycle: create, claim via heartbeat, conflict, conclude, concluded conflict", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const create = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "investigate",
		creator: "decider",
	});
	expect(create.status).toBe(201);
	const step = await create.json();
	expect(step).toMatchObject({
		id: "s001",
		from: ["origin"],
		goal_id: null,
		description: "investigate",
		priority: 0,
		status: "open",
		creator: "decider",
		worker: null,
		last_heartbeat_at: null,
		concluded_at: null,
	});

	const claim = await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "executor" });
	expect(claim.status).toBe(200);
	expect((await claim.json()).worker).toBe("executor");
	expect(step.status).toBe("open");

	const conflict = await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "other" });
	expect(conflict.status).toBe(409);
	expect((await conflict.json()).detail).toContain("executor");

	const concludeByOther = await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "other",
		description: "stolen",
	});
	expect(concludeByOther.status).toBe(409);

	const conclude = await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "executor",
		description: "new fact",
	});
	expect(conclude.status).toBe(200);
	const payload = await conclude.json();
	expect(payload.fact).toBeUndefined();
	expect(payload.step).toMatchObject({
		id: "s001",
		status: "concluded",
		summary: "new fact",
		worker: "executor",
	});
	expect(payload.step.concluded_at).not.toBeNull();

	const again = await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "executor",
		description: "twice",
	});
	expect(again.status).toBe(409);
	expect((await again.json()).detail).toBe("Step already concluded");
});

test("creating a step cannot wait on an abandoned step", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "obsolete prerequisite",
	});
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "ex" });
	expect((await post(app, `/projects/${pid}/steps/s001/abandon`, { worker: "ex" })).status).toBe(
		200,
	);
	const dependent = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "cannot run without prerequisite",
		waiting_on: ["s001"],
	});
	expect(dependent.status).toBe(409);
	expect((await dependent.json()).detail).toContain("abandoned step s001");
	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.steps).toHaveLength(1);
});

test("completed-step barrier requires Decide before another open step can be claimed", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	for (const description of ["first batch step", "next batch step"]) {
		expect(
			(
				await post(app, `/projects/${pid}/steps`, {
					actor: "human",
					from: ["origin"],
					description,
					creator: "human",
				})
			).status,
		).toBe(201);
	}
	expect(
		(await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "execute-1" })).status,
	).toBe(200);
	expect(
		(
			await post(app, `/projects/${pid}/steps/s001/conclude`, {
				worker: "execute-1",
				description: "done",
			})
		).status,
	).toBe(200);

	const blocked = await post(app, `/projects/${pid}/steps/s002/claim`, { worker: "execute-2" });
	expect(blocked.status).toBe(409);
	expect((await blocked.json()).detail).toContain("Decide must process");

	const claim = await post(app, `/projects/${pid}/decide/claim`, { worker: "decide-1" });
	expect(claim.status).toBe(200);
	const planningVersion = (await claim.json()).planning_version as number;
	await readPlanningGraph(app, pid, "decide-1");
	expect(
		(
			await post(app, `/projects/${pid}/decide/complete`, {
				worker: "decide-1",
				planning_version: planningVersion,
			})
		).status,
	).toBe(200);
	// checkpoint 已推进但 Decide 租约尚未释放，仍然不能领取。
	expect(
		(await post(app, `/projects/${pid}/steps/s002/claim`, { worker: "execute-2" })).status,
	).toBe(409);
	expect((await post(app, `/projects/${pid}/decide/release`, { worker: "decide-1" })).status).toBe(
		200,
	);
	expect(
		(await post(app, `/projects/${pid}/steps/s002/claim`, { worker: "execute-2" })).status,
	).toBe(200);
});

test("completed-step barrier does not interrupt another step that was already claimed", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	for (const description of ["parallel one", "parallel two"]) {
		await post(app, `/projects/${pid}/steps`, {
			actor: "human",
			from: ["origin"],
			description,
			creator: "human",
		});
	}
	expect(
		(await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "execute-1" })).status,
	).toBe(200);
	expect(
		(await post(app, `/projects/${pid}/steps/s002/claim`, { worker: "execute-2" })).status,
	).toBe(200);
	await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "execute-1",
		description: "done",
	});
	// 屏障只拦新的 claim；同一 Worker 的重复 claim 必须幂等，不能因重试
	// 增加 lease_version 从而作废已经创建的 execution。
	const beforeRetry = (await (await inspectProjectResponse(app, pid)).json()).steps.find(
		(step: { id: string }) => step.id === "s002",
	)!.lease_version as number;
	const repeated = await post(app, `/projects/${pid}/steps/s002/claim`, { worker: "execute-2" });
	expect(repeated.status).toBe(200);
	expect((await repeated.json()).lease_version).toBe(beforeRetry);
	// 在途执行也仍可续租和完成。
	expect(
		(await post(app, `/projects/${pid}/steps/s002/heartbeat`, { worker: "execute-2" })).status,
	).toBe(200);
	expect(
		(
			await post(app, `/projects/${pid}/steps/s002/conclude`, {
				worker: "execute-2",
				description: "also done",
			})
		).status,
	).toBe(200);
});

test("create step with worker claims it immediately; mismatched worker rejected", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const claimed = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "self-assigned",
		creator: "worker-a",
		worker: "worker-a",
	});
	expect(claimed.status).toBe(201);
	const step = await claimed.json();
	expect(step.status).toBe("claimed");
	expect(step.worker).toBe("worker-a");
	expect(step.last_heartbeat_at).not.toBeNull();

	const mismatched = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "invalid",
		creator: "decider",
		worker: "executor",
	});
	expect(mismatched.status).toBe(400);
	expect((await mismatched.json()).detail).toBe("worker must be null or equal to creator");
});

test("create step validates sources, goal reference and project status", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const goalSource = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["goal"],
		description: "invalid",
		creator: "decider",
	});
	expect(goalSource.status).toBe(400);
	expect((await goalSource.json()).detail).toBe("goal cannot be used in from");

	const missingFact = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["f404"],
		description: "invalid",
		creator: "decider",
	});
	expect(missingFact.status).toBe(404);

	const missingGoal = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		goal_id: "g404",
		description: "invalid",
		creator: "decider",
	});
	expect(missingGoal.status).toBe(404);
	expect((await missingGoal.json()).detail).toBe("Goal not found");

	const ok = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		goal_id: "goal",
		description: "scoped",
		creator: "decider",
		priority: 5,
	});
	expect(ok.status).toBe(201);
	expect((await ok.json()).goal_id).toBe("goal");

	await post(app, `/projects/${pid}/status`, { status: "stopped" });
	const stopped = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "blocked",
		creator: "decider",
	});
	expect(stopped.status).toBe(403);
	expect((await stopped.json()).detail).toBe("Project is stopped");
});

test("release frees the claim so another worker can take it", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "worker-a",
		worker: "worker-a",
	});

	const wrongWorker = await post(app, `/projects/${pid}/steps/s001/release`, {
		worker: "worker-b",
	});
	expect(wrongWorker.status).toBe(409);

	const release = await post(app, `/projects/${pid}/steps/s001/release`, { worker: "worker-a" });
	expect(release.status).toBe(200);
	expect((await release.json()).status).toBe("open");

	const reclaim = await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "worker-b" });
	expect(reclaim.status).toBe(200);
	expect((await reclaim.json()).worker).toBe("worker-b");

	const idempotent = await post(app, `/projects/${pid}/steps/s001/release`, { worker: "worker-b" });
	expect(idempotent.status).toBe(200);
	expect((await idempotent.json()).worker).toBeNull();
});

test("expired heartbeat lets another worker claim and conclude", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "worker-a",
		worker: "worker-a",
	});
	backdateStepHeartbeat(db, pid, "s001", "2000-01-01T00:00:00Z");

	const steal = await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "worker-b" });
	expect(steal.status).toBe(200);
	expect((await steal.json()).worker).toBe("worker-b");

	const conclude = await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "worker-b",
		description: "done",
	});
	expect(conclude.status).toBe(200);
});

test("expired claim cannot be concluded without reacquiring a lease", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "worker-a",
		worker: "worker-a",
	});
	backdateStepHeartbeat(db, pid, "s001", "2000-01-01T00:00:00Z");

	const conclude = await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "worker-b",
		description: "recovered",
	});
	expect(conclude.status).toBe(409);
});

test("abandon requires the claimer or the decide lease holder", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "owned",
		creator: "worker-a",
		worker: "worker-a",
	});
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "unclaimed",
		creator: "decider",
	});
	await post(app, `/projects/${pid}/decide/signal`, { signal: "test" });
	await post(app, `/projects/${pid}/decide/claim`, { worker: "decider" });
	await readPlanningGraph(app, pid, "decider");

	const byRandom = await post(app, `/projects/${pid}/steps/s001/abandon`, { worker: "random" });
	expect(byRandom.status).toBe(409);
	expect((await byRandom.json()).detail).toContain("worker-a");

	// 步骤没有单条 GET 路由：从项目详情里取租约版本。
	const detailBefore = await inspectProjectResponse(app, pid);
	const versionBefore = (
		(await detailBefore.json()) as { steps: Array<{ id: string; lease_version: number }> }
	).steps.find((s) => s.id === "s001")!.lease_version;

	const byDecide = await post(app, `/projects/${pid}/steps/s001/abandon`, {
		worker: "decider",
		reason: "obsolete",
	});
	expect(byDecide.status).toBe(200);
	const abandoned = (await byDecide.json()) as { status: string; lease_version: number };
	expect(abandoned.status).toBe("abandoned");
	// 任何改变 worker 归属的写入都要递增租约版本（与 release / 过期回收一致），
	// 否则"租约代数"出现断层，在途执行者的写入资格判断就失去依据。
	expect(abandoned.lease_version).toBe(versionBefore + 1);

	const unclaimedByRandom = await post(app, `/projects/${pid}/steps/s002/abandon`, {
		worker: "random",
	});
	expect(unclaimedByRandom.status).toBe(409);

	const again = await post(app, `/projects/${pid}/steps/s001/abandon`, { worker: "decider" });
	expect(again.status).toBe(409);
	expect((await again.json()).detail).toBe("Step already abandoned");

	const heartbeat = await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "worker-a" });
	expect(heartbeat.status).toBe(409);

	const conclude = await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "worker-a",
		description: "late",
	});
	expect(conclude.status).toBe(409);
});

test("claimer can abandon their own step", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "worker-a",
		worker: "worker-a",
	});

	const res = await post(app, `/projects/${pid}/steps/s001/abandon`, {
		worker: "worker-a",
		reason: "stuck",
	});
	expect(res.status).toBe(200);
	const step = await res.json();
	expect(step.status).toBe("abandoned");
	expect(step.worker).toBeNull();
});

test("priority can be patched on active projects only", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "decider",
	});

	const res = await patch(app, `/projects/${pid}/steps/s001/priority`, {
		actor: "human",
		priority: 7,
	});
	expect(res.status).toBe(200);
	expect((await res.json()).priority).toBe(7);

	const invalid = await patch(app, `/projects/${pid}/steps/s001/priority`, {
		actor: "human",
		priority: "high",
	});
	expect(invalid.status).toBe(400);

	const missing = await patch(app, `/projects/${pid}/steps/s404/priority`, {
		actor: "human",
		priority: 1,
	});
	expect(missing.status).toBe(404);

	await post(app, `/projects/${pid}/status`, { status: "stopped" });
	const stopped = await patch(app, `/projects/${pid}/steps/s001/priority`, {
		actor: "human",
		priority: 1,
	});
	expect(stopped.status).toBe(403);
});

test("step operations on missing step return 404", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	for (const url of [
		`/projects/${pid}/steps/s404/claim`,
		`/projects/${pid}/steps/s404/release`,
		`/projects/${pid}/steps/s404/abandon`,
	]) {
		const res = await post(app, url, { worker: "w", description: "d" });
		expect(res.status).toBe(404);
		expect((await res.json()).detail).toBe("Step not found");
	}
});

test("lease_timeout setting drives heartbeat expiry", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "work",
		creator: "worker-a",
		worker: "worker-a",
	});

	backdateStepHeartbeat(db, pid, "s001", secondsAgo(10));
	const tooEarly = await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "worker-b" });
	expect(tooEarly.status).toBe(409);

	await patch(app, "/settings", { lease_timeout: 5 });
	const afterShrink = await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "worker-b" });
	expect(afterShrink.status).toBe(200);
	expect((await afterShrink.json()).worker).toBe("worker-b");
});

test("waiting_on is validated, stored, and cascades when a dependency is abandoned", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const missingDep = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "depends on a step that does not exist",
		creator: "decider",
		waiting_on: ["s999"],
	});
	expect(missingDep.status).toBe(404);

	const first = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "extract credentials",
		creator: "decider",
	});
	expect(first.status).toBe(201);
	expect((await first.json()).waiting_on).toEqual([]);

	const second = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "log in with the extracted credentials",
		creator: "decider",
		waiting_on: ["s001"],
	});
	expect(second.status).toBe(201);
	expect((await second.json()).waiting_on).toEqual(["s001"]);

	const third = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "use the admin panel",
		creator: "decider",
		waiting_on: ["s002"],
	});
	expect(third.status).toBe(201);

	await post(app, `/projects/${pid}/decide/signal`, { signal: "test" });
	await post(app, `/projects/${pid}/decide/claim`, { worker: "decider" });
	await readPlanningGraph(app, pid, "decider");
	const abandon = await post(app, `/projects/${pid}/steps/s001/abandon`, {
		worker: "decider",
		reason: "dead end",
	});
	expect(abandon.status).toBe(200);

	const detail = (await (await inspectProjectResponse(app, pid)).json()) as {
		steps: Array<{ id: string; status: string; summary: string | null }>;
	};
	expect(detail.steps.find((s) => s.id === "s001")!.status).toBe("abandoned");
	expect(detail.steps.find((s) => s.id === "s002")).toMatchObject({
		status: "abandoned",
		summary: expect.stringContaining("s001"),
	});
	// 级联沿依赖链传播：s003 等待的 s002 已被取消
	expect(detail.steps.find((s) => s.id === "s003")!.status).toBe("abandoned");
});

test("rejects a step whose description duplicates an in-flight step", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	const first = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "investigate the login form",
		creator: "decider",
	});
	expect(first.status).toBe(201);

	const dup = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "  investigate the login form  ",
		creator: "decider",
	});
	expect(dup.status).toBe(409);
	expect((await dup.json()).detail).toContain("s001");

	// 已结束的步骤不再占用描述：s001 放弃后可以重新创建同描述步骤
	await post(app, `/projects/${pid}/decide/signal`, { signal: "test" });
	await post(app, `/projects/${pid}/decide/claim`, { worker: "decider" });
	await readPlanningGraph(app, pid, "decider");
	await post(app, `/projects/${pid}/steps/s001/abandon`, { worker: "decider" });
	const recreated = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "investigate the login form",
		creator: "decider",
	});
	expect(recreated.status).toBe(201);
});

test("concluding a step with facts but no finding wakes decide to converge", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "explore",
		creator: "human",
	});
	await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "executor" });
	for (const n of [1, 2, 3]) {
		expect(
			(
				await post(app, `/projects/${pid}/facts`, {
					confidence: "observed",
					actor: "human",
					step_id: "s001",
					description: `观察 ${n}`,
				})
			).status,
		).toBe(201);
	}
	await post(app, `/projects/${pid}/steps/s001/conclude`, {
		worker: "executor",
		description: "done",
	});
	const cp = db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(pid) as { external_signal: string | null };
	expect(cp.external_signal).toBe("finding_gap:s001:3");
});

test("abandoning a dependency cascades and wakes decide with a replacement signal", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "dependency",
		creator: "human",
	});
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		from: ["origin"],
		description: "blocked work",
		creator: "human",
		waiting_on: ["s001"],
	});
	// 放弃需要持有 Decide 租约（或步骤 claimer）；先拿租约再放弃 s001。
	await post(app, `/projects/${pid}/decide/signal`, { signal: "seed" });
	await post(app, `/projects/${pid}/decide/claim`, { worker: "decider" });
	await readPlanningGraph(app, pid, "decider");
	const abandon = await post(app, `/projects/${pid}/steps/s001/abandon`, {
		worker: "decider",
		reason: "obsolete",
	});
	expect(abandon.status).toBe(200);
	const blocked = db
		.prepare("SELECT status, summary FROM steps WHERE project_id = ? AND id = 's002'")
		.get(pid) as { status: string; summary: string };
	expect(blocked.status).toBe("abandoned");
	expect(blocked.summary).toContain("依赖的步骤 s001");
	// 级联取消本身不产生触发条件，必须显式发信号，否则 Decide 不会被唤醒，
	// 被放弃的依赖链就没有替代分支。
	const cp = db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(pid) as { external_signal: string | null };
	expect(cp.external_signal).toBe("dependency_abandoned:s002");
});
