import { inspectProjectResponse } from "../support/project-state.js";
import { expect, test } from "vitest";

import { computeDecideTrigger } from "../../src/server/core/decide.js";
import {
	backdateDecideHeartbeat,
	createProject,
	createTestServer,
	post,
	readPlanningGraph,
} from "./helpers.js";

test("decide lease: claim computes trigger, conflict, heartbeat, release", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);

	// 全新项目（无步骤）：initial_run，规划版本 0。
	const claim = await post(app, `/projects/${pid}/decide/claim`, { worker: "decider-a" });
	expect(claim.status).toBe(200);
	const meta = await claim.json();
	expect(meta.decide).toMatchObject({ worker: "decider-a", trigger: "initial_run" });
	expect(meta.trigger).toBe("initial_run");
	expect(meta.planning_version).toBe(0);

	// 他人冲突；同人幂等重申领（不重新计算触发）。
	const conflict = await post(app, `/projects/${pid}/decide/claim`, { worker: "decider-b" });
	expect(conflict.status).toBe(409);
	expect((await conflict.json()).detail).toContain("decider-a");
	const idempotent = await post(app, `/projects/${pid}/decide/claim`, { worker: "decider-a" });
	expect(idempotent.status).toBe(200);
	expect((await idempotent.json()).decide.trigger).toBe("initial_run");

	const heartbeatByOther = await post(app, `/projects/${pid}/decide/heartbeat`, {
		worker: "decider-b",
	});
	expect(heartbeatByOther.status).toBe(409);
	const heartbeat = await post(app, `/projects/${pid}/decide/heartbeat`, { worker: "decider-a" });
	expect(heartbeat.status).toBe(200);

	const releaseByOther = await post(app, `/projects/${pid}/decide/release`, {
		worker: "decider-b",
	});
	expect(releaseByOther.status).toBe(409);
	const release = await post(app, `/projects/${pid}/decide/release`, { worker: "decider-a" });
	expect(release.status).toBe(200);
	expect((await release.json()).decide).toBeNull();
	expect((await post(app, `/projects/${pid}/decide/release`, { worker: "decider-a" })).status).toBe(
		200,
	);
	expect(
		(await post(app, `/projects/${pid}/decide/heartbeat`, { worker: "decider-a" })).status,
	).toBe(409);
});

test("two interrupted plans pause automatic retries until new input arrives", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	for (const worker of ["first", "retry"]) {
		expect((await post(app, `/projects/${pid}/decide/claim`, { worker })).status).toBe(200);
		if (worker === "retry") {
			await readPlanningGraph(app, pid, worker);
			// 失败规划可能已经局部改图；这不能让失败计数归零并无限重试。
			expect(
				(await post(app, `/projects/${pid}/goals`, { worker, description: "partial plan" })).status,
			).toBe(201);
		}
		expect((await post(app, `/projects/${pid}/decide/release`, { worker })).status).toBe(200);
	}
	const stalled = await (await inspectProjectResponse(app, pid)).json();
	expect(stalled.planning).toMatchObject({ interrupted_retries: 2, stalled: true });
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "third" })).status).toBe(409);
	expect((await post(app, `/projects/${pid}/decide/signal`, { signal: "manual" })).status).toBe(
		204,
	);
	const resumed = await (await inspectProjectResponse(app, pid)).json();
	expect(resumed.planning).toMatchObject({ interrupted_retries: 0, stalled: false });
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "third" })).status).toBe(200);
});

test("complete advances planning_version with CAS and is idempotent", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readPlanningGraph(app, pid, "w1");

	// 版本错误 → 409。
	const stale = await post(app, `/projects/${pid}/decide/complete`, {
		worker: "w1",
		planning_version: 5,
	});
	expect(stale.status).toBe(409);
	expect((await stale.json()).detail).toContain("stale");

	const done = await post(app, `/projects/${pid}/decide/complete`, {
		worker: "w1",
		planning_version: 0,
	});
	expect(done.status).toBe(200);
	expect((await done.json()).planning_version).toBe(1);
	// 网络重试：同 worker 同版本的重复 complete 幂等确认。
	const retry = await post(app, `/projects/${pid}/decide/complete`, {
		worker: "w1",
		planning_version: 0,
	});
	expect(retry.status).toBe(200);
	expect((await retry.json()).planning_version).toBe(1);

	// 项目详情暴露规划版本与最近触发。
	const detail = await (await inspectProjectResponse(app, pid)).json();
	expect(detail.planning).toMatchObject({ version: 1, last_trigger: "initial_run" });

	// 收尾并释放后：这一轮 Decide 空转（既没建也没废步骤）。但项目从来没产出过
	// 任何步骤 —— 空图空转不算「计划已够用」，而是首轮规划失败，必须重试，
	// 否则项目会在 open==0 + last_noop==1 时被永久冻结（a-09 曾空转 74 分钟）。
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });
	const emptyRetry = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(emptyRetry.status).toBe(200);
	expect((await emptyRetry.json()).trigger).toBe("waiting_timeout");
});

test.each(["expired", "released"])(
	"an interrupted initial Decide (%s) is replanned without duplicating its persisted step",
	async (interruption) => {
		const { app, db } = createTestServer();
		const pid = await createProject(app);
		expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "crashed" })).status).toBe(
			200,
		);
		await readPlanningGraph(app, pid, "crashed");
		const step = {
			from: ["origin"],
			description: "问题：检查响应；范围：入口；验收：记录状态码",
			creator: "decide",
		};
		expect(
			(await post(app, `/projects/${pid}/steps`, { ...step, decide_worker: "crashed" })).status,
		).toBe(201);
		// 图写入已提交，但 complete 的 CAS 失败，然后进程崩溃。
		expect(
			(
				await post(app, `/projects/${pid}/decide/complete`, {
					worker: "crashed",
					planning_version: 99,
				})
			).status,
		).toBe(409);
		if (interruption === "expired") {
			backdateDecideHeartbeat(db, pid, "2020-01-01T00:00:00Z");
		} else {
			expect(
				(await post(app, `/projects/${pid}/decide/release`, { worker: "crashed" })).status,
			).toBe(200);
		}
		// 即使调度器先尝试派发，也不能运行尚未完成规划的半成品。
		expect((await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "early" })).status).toBe(
			409,
		);
		const resumed = await post(app, `/projects/${pid}/decide/claim`, {
			worker: "replacement",
			min_interval_seconds: 0,
		});
		expect(resumed.status).toBe(200);
		const version = (await resumed.json()).planning_version;
		await readPlanningGraph(app, pid, "replacement");
		expect(version).toBe(0);
		expect(
			(await post(app, `/projects/${pid}/steps`, { ...step, decide_worker: "replacement" })).status,
		).toBe(409);
		expect(
			(
				await post(app, `/projects/${pid}/steps`, {
					...step,
					description: "stale extra step",
					decide_worker: "crashed",
				})
			).status,
		).toBe(409);
		expect(
			(
				await post(app, `/projects/${pid}/decide/complete`, {
					worker: "crashed",
					planning_version: 0,
				})
			).status,
		).toBe(409);
		expect(
			(
				await post(app, `/projects/${pid}/decide/complete`, {
					worker: "replacement",
					planning_version: version,
				})
			).status,
		).toBe(200);
		const graph = await (await inspectProjectResponse(app, pid)).json();
		expect(graph.steps).toHaveLength(1);
		expect(graph.planning!.version).toBe(1);
		expect(
			(await post(app, `/projects/${pid}/decide/release`, { worker: "replacement" })).status,
		).toBe(200);
		expect(
			(await post(app, `/projects/${pid}/steps/s001/claim`, { worker: "after-review" })).status,
		).toBe(200);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM decide_changes WHERE project_id = ? AND detail = 'decide_interrupted'",
				)
				.get(pid),
		).toEqual({ n: 1 });
	},
);

test("expired Decide cannot complete even before a dispatcher reaps it", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "expired" })).status).toBe(
		200,
	);
	backdateDecideHeartbeat(db, pid, "2020-01-01T00:00:00Z");
	expect(
		(
			await post(app, `/projects/${pid}/decide/complete`, {
				worker: "expired",
				planning_version: 0,
			})
		).status,
	).toBe(409);
	const graph = await (await inspectProjectResponse(app, pid)).json();
	expect(graph.planning!.version).toBe(0);
	expect(
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM decide_changes WHERE project_id = ? AND detail = 'decide_interrupted'",
			)
			.get(pid),
	).toEqual({ n: 1 });
});

test("an expired lease that already completed does not emit an interruption signal", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "done" })).status).toBe(200);
	await readPlanningGraph(app, pid, "done");
	expect(
		(await post(app, `/projects/${pid}/decide/complete`, { worker: "done", planning_version: 0 }))
			.status,
	).toBe(200);
	backdateDecideHeartbeat(db, pid, "2020-01-01T00:00:00Z");
	await inspectProjectResponse(app, pid);
	expect(
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM decide_changes WHERE project_id = ? AND detail = 'decide_interrupted'",
			)
			.get(pid),
	).toEqual({ n: 0 });
});

test("empty-graph no-op decide still retries instead of freezing the project", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	// 项目一个步骤都没有；首轮 Decide 认领后什么也没建就 complete（模拟
	// planner 只输出思考、没调用 add_step —— a-09 的真实故障）。
	const claim = await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	expect(claim.status).toBe(200);
	expect((await claim.json()).trigger).toBe("initial_run");
	await readPlanningGraph(app, pid, "w1");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	// 图仍为空且这一轮空转，但项目绝不能被永久冻结：必须能再次认领重试。
	const retry = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(retry.status).toBe(200);
	expect((await retry.json()).trigger).toBe("waiting_timeout");
	await readPlanningGraph(app, pid, "w2");

	// 反复空转仍受 min_interval 节流，不会退化成每 tick 一次的热循环。
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w2", planning_version: 1 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w2" });
	const throttled = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "w3",
		min_interval_seconds: 3600,
	});
	expect(throttled.status).toBe(409);
});

test("observed facts do not echo; after a no-op decide facts must accumulate", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	// 先跑完一条步骤，让项目确实有过计划（total_step_count>0）。空图空转不适用
	// 空转抑制，必须重试（见上一条用例），这里要测的是「有计划时的空转抑制」。
	const seed = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "seed",
	});
	const seedId = (await seed.json()).id;
	await post(app, `/projects/${pid}/steps/${seedId}/claim`, { worker: "ex0" });
	await post(app, `/projects/${pid}/steps/${seedId}/conclude`, {
		worker: "ex0",
		description: "done",
	});

	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	// 人类在 Decide 运行期间写入事实；只有显式读图后才算该规划观察过。
	const ownFact = await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "人类并发写入的事实",
	});
	expect(ownFact.status).toBe(201);
	await readPlanningGraph(app, pid, "w1");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });
	// 这次 Decide 既没建步骤也没废步骤 → 记为空转（last_noop=1）。

	// 已读事实不产生回声；有过计划的项目空转 + open==0 不再兜底 waiting_timeout。
	const echo = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(echo.status).toBe(409);

	// 空转抑制：空转之后只来 1 条事实不足以唤醒 Decide（阈值 3）。
	expect(
		(
			await post(app, `/projects/${pid}/facts`, {
				confidence: "observed",
				actor: "human",
				description: "新观察 1",
			})
		).status,
	).toBe(201);
	const suppressed = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(suppressed.status).toBe(409);

	// 攒够阈值（3 条）后重新触发 fact_added。
	for (const n of [2, 3]) {
		expect(
			(
				await post(app, `/projects/${pid}/facts`, {
					confidence: "observed",
					actor: "human",
					description: `新观察 ${n}`,
				})
			).status,
		).toBe(201);
	}
	const claim = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(claim.status).toBe(200);
	const meta = await claim.json();
	expect(meta.trigger).toContain("fact_added");
	expect(meta.planning_version).toBe(1);
});

test("waiting_timeout fires when idle and respects min_interval", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	// 有在办步骤的项目：首次认领只写静默基线，不触发。
	const step = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "s1",
	});
	const stepId = (await step.json()).id;
	const baseline = await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	expect(baseline.status).toBe(409);

	// 步骤结束 → waiting_timeout。
	await post(app, `/projects/${pid}/steps/${stepId}/claim`, { worker: "ex" });
	const patch = await post(app, `/projects/${pid}/steps/${stepId}/conclude`, {
		worker: "ex",
		description: "done",
	});
	expect(patch.status).toBe(200);
	const claim = await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	expect(claim.status).toBe(200);
	expect((await claim.json()).trigger).toContain("waiting_timeout");
	await readPlanningGraph(app, pid, "w1");

	// min_interval 节奏：刚完成过（complete 前进 updated_at）时拒绝。
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });
	const debounced = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "w1",
		min_interval_seconds: 3600,
	});
	expect(debounced.status).toBe(409);
	// 空转之后 open==0 不再兜底重触发：不传节奏参数也拒绝（与旧行为相反）。
	const again = await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	expect(again.status).toBe(409);
});

test("external signal triggers once and is consumed by complete", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	// 有步骤的项目：基线已建立时 signal 叠加触发。
	await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "s1",
	});
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w" })).status).toBe(409);
	expect((await post(app, `/projects/${pid}/decide/signal`, { signal: "webhook-9" })).status).toBe(
		204,
	);
	const claim = await post(app, `/projects/${pid}/decide/claim`, { worker: "w" });
	expect(claim.status).toBe(200);
	expect((await claim.json()).trigger).toBe("external_signal:webhook-9");
	await readPlanningGraph(app, pid, "w");

	// complete 消费信号：项目仍有 open 步骤 → 无任何触发。
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w" });
	const next = await post(app, `/projects/${pid}/decide/claim`, { worker: "w" });
	expect(next.status).toBe(409);

	// signal 校验。
	expect(
		(await post(app, `/projects/${pid}/decide/signal`, { signal: "x".repeat(201) })).status,
	).toBe(400);
});

test("checkpoint counts a claimed step once (no double count)", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const step = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "s1",
	});
	const stepId = (await step.json()).id;
	await post(app, `/projects/${pid}/steps/${stepId}/claim`, { worker: "ex" });

	// 首次认领在有在办步骤时只写静默基线；一个 claimed 步骤必须只计 1。
	expect(computeDecideTrigger(db, pid, 0)).toBeNull();
	const row = db
		.prepare("SELECT open_step_count FROM decide_checkpoints WHERE project_id = ?")
		.get(pid) as { open_step_count: number };
	expect(row.open_step_count).toBe(1);
});

test("expired decide lease can be reclaimed by another worker", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "decider-a" });
	backdateDecideHeartbeat(db, pid, "2000-01-01T00:00:00Z");

	const res = await post(app, `/projects/${pid}/decide/claim`, { worker: "decider-b" });
	expect(res.status).toBe(200);
	expect((await res.json()).decide.worker).toBe("decider-b");
});

test("decide endpoints require an active project", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/status`, { status: "stopped" });

	const claim = await post(app, `/projects/${pid}/decide/claim`, { worker: "w" });
	expect(claim.status).toBe(403);
	expect((await claim.json()).detail).toBe("Project is stopped");
	expect((await post(app, `/projects/${pid}/decide/signal`, { signal: "x" })).status).toBe(403);
	expect((await post(app, `/projects/${pid}/decide/heartbeat`, { worker: "w" })).status).toBe(403);
	expect((await post(app, `/projects/${pid}/decide/release`, { worker: "w" })).status).toBe(403);
});

test("decide claim validates the body", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "" })).status).toBe(400);
	expect(
		(await post(app, `/projects/${pid}/decide/claim`, { worker: "w", min_interval_seconds: -1 }))
			.status,
	).toBe(400);
});

test("while Execute is active facts accumulate, then Step completion unlocks one Decide", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	const s1 = await post(app, `/projects/${pid}/steps`, {
		actor: "human",
		creator: "human",
		from: ["origin"],
		description: "s1",
	});
	const s1id = (await s1.json()).id;
	// 有在办步骤：首次认领只写静默基线。
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" })).status).toBe(409);

	await post(app, `/projects/${pid}/steps/${s1id}/claim`, { worker: "ex" });
	await post(app, `/projects/${pid}/steps/${s1id}/conclude`, { worker: "ex", description: "done" });
	const first = await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	expect(first.status).toBe(200);
	expect((await first.json()).trigger).toContain("waiting_timeout");
	await readPlanningGraph(app, pid, "w1");

	// 这一轮 Decide 产出了一个新步骤 → last_noop=0。
	const planned = await post(app, `/projects/${pid}/steps`, {
		decide_worker: "w1",
		creator: "w1",
		from: ["origin"],
		description: "planned s2",
	});
	expect(planned.status).toBe(201);
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	// s2 开始执行后，中间事实只入图，不在步骤完成前唤醒 Decide。
	const s2id = (await planned.json()).id;
	await post(app, `/projects/${pid}/steps/${s2id}/claim`, { worker: "ex2" });
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "one new fact",
	});
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" })).status).toBe(409);

	// 即使事实达到原来的批量阈值，Execute 仍在运行时也不规划。
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "second new fact",
	});
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" })).status).toBe(409);

	// 任意一个 Step 完成后立即获得一次规划机会；完成信号不受 min_interval 限制。
	await post(app, `/projects/${pid}/steps/${s2id}/conclude`, {
		worker: "ex2",
		description: "done",
	});
	const claim = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "w2",
		min_interval_seconds: 3600,
	});
	expect(claim.status).toBe(200);
	const trigger = (await claim.json()).trigger as string;
	expect(trigger).toContain("fact_added");
	expect(trigger).toContain(`external_signal:step_completed:${s2id}`);
});

test("a failed attempt wakes decide past min_interval and admits in-flight evidence", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readPlanningGraph(app, pid, "w1");
	const planned = await post(app, `/projects/${pid}/steps`, {
		decide_worker: "w1",
		creator: "w1",
		from: ["origin"],
		description: "planned work",
	});
	expect(planned.status).toBe(201);
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	const stepId = (await planned.json()).id;

	// 步骤认领（claimed）后执行失败：未耗尽失败也必须叫醒 Decide，
	// 且失败尝试抢救出的事实（在途积累）随边界信号一并被吸收。
	await post(app, `/projects/${pid}/steps/${stepId}/claim`, { worker: "ex1" });
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "salvaged observation",
	});
	await post(app, `/projects/${pid}/facts`, {
		confidence: "observed",
		actor: "human",
		description: "second observation",
	});
	await post(app, `/projects/${pid}/decide/signal`, { signal: "step_attempt_failed" });

	const claim = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "w2",
		min_interval_seconds: 3600,
	});
	expect(claim.status).toBe(200);
	const trigger = (await claim.json()).trigger as string;
	expect(trigger).toContain("external_signal:step_attempt_failed");
	// 边界信号开放证据吸收：在途事实达到 FACT_THRESHOLD=2 即随本轮参与规划，
	// 且边界信号本身不受 min_interval 节流。
	expect(trigger).toContain("fact_added");
});

test("decide complete persists the fact watermark for the bounded export", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	const insert = db.prepare(
		"INSERT INTO facts (id, project_id, description, confidence, created_at) VALUES (?, ?, ?, 'observed', ?)",
	);
	const now = new Date().toISOString();
	insert.run("f001", pid, "early observation", now);
	insert.run("f002", pid, "later observation", now);

	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readPlanningGraph(app, pid, "w1");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w1", planning_version: 0 });
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });

	const row = db
		.prepare("SELECT last_fact_id FROM decide_checkpoints WHERE project_id = ?")
		.get(pid) as { last_fact_id: string | null };
	expect(row.last_fact_id).toBe("f002");

	// complete 之后新增的事实推进水位线。上一轮 Decide 空转（未建/废步骤），
	// 事实阈值升到 3，因此这里补 3 条让下一次认领真的有触发；complete 时按
	// 认领兼容水位为 f005；之后如再产生事实，必须再次显式读图才会确认。
	insert.run("f003", pid, "third observation", now);
	insert.run("f004", pid, "fourth observation", now);
	insert.run("f005", pid, "fifth observation", now);
	const second = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "w2",
		min_interval_seconds: 0,
	});
	expect(second.status).toBe(200);
	await readPlanningGraph(app, pid, "w2");
	await post(app, `/projects/${pid}/decide/complete`, { worker: "w2", planning_version: 1 });
	const advanced = db
		.prepare("SELECT last_fact_id FROM decide_checkpoints WHERE project_id = ?")
		.get(pid) as { last_fact_id: string | null };
	expect(advanced.last_fact_id).toBe("f005");
});
