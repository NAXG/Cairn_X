import { inspectProjectResponse } from "../support/project-state.js";
import { expect, test } from "vitest";
import { getCheckpoint } from "../../src/server/core/decide.js";
import { getDecideRead, latestDecideChange } from "../../src/server/core/decide-changes.js";
import { createProject, createTestServer, get, post, del, readPlanningGraph } from "./helpers.js";
import type { Hono } from "hono";
import type { Db } from "../../src/server/db.js";

/**
 * 已读水位是服务端内部记账，不再出现在规划页里；断言直接查 decide_reads。
 * 规划页只暴露 required_complete / next_cursor 两个决策信号。
 */
function watermark(db: Db, pid: string, worker = "w1"): number {
	return getDecideRead(db, pid, worker)?.observed_seq ?? 0;
}

async function readGraph(app: Hono, pid: string, worker = "w1") {
	const pages = await readPlanningGraph(app, pid, worker);
	return {
		changes: pages.flatMap((page) => page.changes),
		pages,
	};
}

async function complete(app: Hono, pid: string, worker = "w1", version = 0) {
	expect(
		(await post(app, `/projects/${pid}/decide/complete`, { worker, planning_version: version }))
			.status,
	).toBe(200);
	expect((await post(app, `/projects/${pid}/decide/release`, { worker })).status).toBe(200);
}

const inputs = {
	fact: {
		path: "facts",
		body: { actor: "human", description: "late fact", confidence: "observed" },
		trigger: "fact_added",
	},
	hint: {
		path: "hints",
		body: { creator: "human", content: "late human input" },
		trigger: "hint_added",
	},
	finding: {
		path: "findings",
		body: { actor: "human", title: "late result", description: "late finding" },
		trigger: "finding_added",
	},
	signal: {
		path: "decide/signal",
		body: { signal: "late-event" },
		trigger: "external_signal:late-event",
	},
} as const;

for (const productive of [false, true]) {
	for (const [kind, input] of Object.entries(inputs)) {
		test(`unread ${kind} survives ${productive ? "productive" : "no-op"} completion and bypasses batching`, async () => {
			const { app, db } = createTestServer();
			const pid = await createProject(app);
			expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" })).status).toBe(200);
			const graph = await readGraph(app, pid);
			expect(graph.pages.at(-1)?.coverage.required_complete).toBe(true);
			if (productive) {
				expect(
					(
						await post(app, `/projects/${pid}/steps`, {
							decide_worker: "w1",
							creator: "w1",
							from: ["origin"],
							description: "planned work",
						})
					).status,
				).toBe(201);
			}
			expect((await post(app, `/projects/${pid}/${input.path}`, input.body)).ok).toBe(true);
			expect(latestDecideChange(db, pid)).toBeGreaterThan(watermark(db, pid));
			await complete(app, pid);
			expect(getCheckpoint(db, pid)).toMatchObject({
				observed_seq: watermark(db, pid),
				unread_changes: 1,
				last_noop: productive ? 0 : 1,
				last_fact_id: null,
			});
			// 单条事实也必须被下一轮处理，不能继续等待固定的 2/3 条阈值。
			const next = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
			expect(next.status).toBe(200);
			expect((await next.json()).trigger).toContain(input.trigger);
			const fresh = await readGraph(app, pid, "w2");
			if (kind === "signal")
				expect(
					fresh.changes
						.filter((change: any) => change.kind === "signal")
						.map((change: any) => change.detail),
				).toEqual(["late-event"]);
			await complete(app, pid, "w2", 1);
			expect(getCheckpoint(db, pid)?.unread_changes).toBe(0);
			if (kind === "fact") expect(getCheckpoint(db, pid)?.last_fact_id).toBe("f001");
			const idle = await post(app, `/projects/${pid}/decide/claim`, { worker: "w3" });
			if (productive) {
				// 有既有计划 + 无未读输入：不再唤醒。
				expect(idle.status).toBe(409);
			} else {
				// 已读输入不再触发；项目从未产出过步骤，所以只剩空图保护的重试，
				// 绝不能把该输入当成新变更再次唤醒。
				expect(idle.status).toBe(200);
				const idleTrigger = (await idle.json()).trigger as string;
				expect(idleTrigger).toBe("waiting_timeout");
				expect(idleTrigger).not.toContain(input.trigger);
			}
		});
	}
}

test("a full re-read acknowledges later inputs and advances the fact watermark", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readGraph(app, pid);
	const initialWatermark = watermark(db, pid);
	for (const input of Object.values(inputs)) {
		expect((await post(app, `/projects/${pid}/${input.path}`, input.body)).ok).toBe(true);
	}
	const fresh = await readGraph(app, pid);
	expect(watermark(db, pid)).toBeGreaterThan(initialWatermark);
	expect(fresh.changes.find((change: any) => change.kind === "signal")?.detail).toBe("late-event");
	await complete(app, pid);
	expect(getCheckpoint(db, pid)).toMatchObject({
		observed_seq: watermark(db, pid),
		last_fact_id: "f001",
		unread_changes: 0,
		external_signal: null,
	});
	// 输入均已确认；项目从未产出过步骤，因此只剩空图保护的重试而不是空触发。
	const idle = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(idle.status).toBe(200);
	expect((await idle.json()).trigger).toBe("waiting_timeout");
});

test("pagination, UI reads, stale readers, failed reads and repeated claims cannot acknowledge unrelated changes", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readGraph(app, pid);
	const initialWatermark = watermark(db, pid);
	await post(app, `/projects/${pid}/hints`, inputs.hint.body);
	expect(
		(
			await post(app, `/projects/${pid}/decide/graph`, {
				worker: "w1",
				view: "record",
				section: "facts",
				id: "origin",
			})
		).status,
	).toBe(200);
	// 控制台 /graph 读取（普通 UI 路径）同样不推进水位。
	expect((await get(app, `/projects/${pid}/graph/canvas`)).status).toBe(200);
	expect((await inspectProjectResponse(app, pid)).status).toBe(200);
	expect(
		(await post(app, `/projects/${pid}/decide/graph`, { worker: "stale", view: "planning" }))
			.status,
	).toBe(409);
	expect(
		(await post(app, `/projects/${pid}/decide/graph`, { worker: "w1", view: "record" })).status,
	).toBe(400);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" })).status).toBe(200);
	await complete(app, pid);
	expect(getCheckpoint(db, pid)?.observed_seq).toBe(initialWatermark);
	expect((await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" })).status).toBe(200);
});

test("identical signals arriving after the read are retained; complete retries do not consume them", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/signal`, { signal: "same" });
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readGraph(app, pid);
	await post(app, `/projects/${pid}/decide/signal`, { signal: "same" });
	const body = { worker: "w1", planning_version: 0 };
	expect((await post(app, `/projects/${pid}/decide/complete`, body)).status).toBe(200);
	const cp = getCheckpoint(db, pid);
	await post(app, `/projects/${pid}/decide/signal`, { signal: "even-later" });
	expect((await post(app, `/projects/${pid}/decide/complete`, body)).status).toBe(200);
	expect(getCheckpoint(db, pid)?.observed_seq).toBe(cp?.observed_seq);
	expect(getCheckpoint(db, pid)?.external_signal).toBe("even-later");
	await post(app, `/projects/${pid}/decide/release`, { worker: "w1" });
	const next = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(next.status).toBe(200);
	const graph = await readGraph(app, pid, "w2");
	expect(
		graph.changes
			.filter((change: any) => change.kind === "signal")
			.map((s: { detail: string }) => s.detail),
	).toEqual(["same", "even-later"]);
});

test("own goal writes do not echo or hide an external signal", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readGraph(app, pid);
	const goal = await (
		await post(app, `/projects/${pid}/goals`, { worker: "w1", description: "sub goal" })
	).json();
	expect(
		(
			await post(app, `/projects/${pid}/goals/${goal.id}/achieve`, {
				worker: "w1",
				from: [{ type: "fact", id: "origin" }],
				description: "verified",
			})
		).status,
	).toBe(200);
	const disposable = await (
		await post(app, `/projects/${pid}/goals`, { worker: "w1", description: "unneeded" })
	).json();
	expect(
		(await app.request(`/projects/${pid}/goals/${disposable.id}?worker=w1`, { method: "DELETE" }))
			.status,
	).toBe(204);
	await post(app, `/projects/${pid}/decide/signal`, { signal: "external-first" });
	await complete(app, pid);
	expect(getCheckpoint(db, pid)?.external_signal).toBe("external-first");
	const next = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(next.status).toBe(200);
	const trigger = (await next.json()).trigger;
	expect(trigger).toContain("external_signal:external-first");
	expect(trigger).not.toContain("goal_changed");
	await readGraph(app, pid, "w2");
	await complete(app, pid, "w2", 1);
	// 信号已消费，goal 变更不回声；空图保护只补 waiting_timeout。
	const idle = await post(app, `/projects/${pid}/decide/claim`, { worker: "w3" });
	expect(idle.status).toBe(200);
	expect((await idle.json()).trigger).toBe("waiting_timeout");
});

test("a human goal replacement is not hidden by unchanged goal counts", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app);
	const old = await (
		await post(app, `/projects/${pid}/goals`, { actor: "human", description: "old" })
	).json();
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readGraph(app, pid);
	expect((await del(app, `/projects/${pid}/goals/${old.id}`)).status).toBe(204);
	expect(
		(await post(app, `/projects/${pid}/goals`, { actor: "human", description: "replacement" }))
			.status,
	).toBe(201);
	await complete(app, pid);
	const next = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(next.status).toBe(200);
	expect((await next.json()).trigger).toContain("goal_changed");
});

test("signal backlog shows earliest signals and advances without losing omitted ones", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	await readGraph(app, pid);
	for (let i = 0; i < 23; i++) {
		expect((await post(app, `/projects/${pid}/decide/signal`, { signal: `sig-${i}` })).status).toBe(
			204,
		);
	}
	const backlog = await readGraph(app, pid);
	const backlogSignals = backlog.changes.filter((change: any) => change.kind === "signal");
	expect(backlogSignals).toHaveLength(23);
	expect(backlogSignals[0].detail).toBe("sig-0");
	await complete(app, pid);
	// 协议会跟随游标读完全部必需页，因此所有信号都被连续确认。
	const cp = getCheckpoint(db, pid);
	expect(cp?.unread_changes).toBe(0);
	expect(cp?.external_signal).toBeNull();
	const next = await post(app, `/projects/${pid}/decide/claim`, { worker: "w2" });
	expect(next.status).toBe(200);
	expect((await next.json()).trigger).toBe("waiting_timeout");
	const tail = await readGraph(app, pid, "w2");
	expect(tail.changes.filter((change: any) => change.kind === "signal")).toHaveLength(0);
	await complete(app, pid, "w2", 1);
	expect(getCheckpoint(db, pid)?.unread_changes).toBe(0);
	// 积压信号已全部确认；空图保护只补 waiting_timeout。
	const idle = await post(app, `/projects/${pid}/decide/claim`, { worker: "w3" });
	expect(idle.status).toBe(200);
	expect((await idle.json()).trigger).toBe("waiting_timeout");
});

test("a decide that never reads the planning graph cannot complete", async () => {
	const { app, db } = createTestServer();
	const pid = await createProject(app);
	await post(app, `/projects/${pid}/decide/claim`, { worker: "w1" });
	const claimSeq = latestDecideChange(db, pid);
	await post(app, `/projects/${pid}/facts`, inputs.fact.body);
	const result = await post(app, `/projects/${pid}/decide/complete`, {
		worker: "w1",
		planning_version: 0,
	});
	expect(result.status).toBe(409);
	expect((await result.json()).detail).toContain("has not been read");
	expect(getCheckpoint(db, pid)?.observed_seq ?? 0).toBeLessThanOrEqual(claimSeq);
});

test("hints stay unread when the first Decide round is interrupted before completing", async () => {
	const { app } = createTestServer();
	const pid = await createProject(app, {
		hints: [{ content: "SECRET HINT: try port 8080", creator: "human" }],
	});
	const first = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "d1",
		min_interval_seconds: 0,
	});
	expect((await first.json()).trigger).toBe("initial_run");
	await readGraph(app, pid, "d1");
	// 首轮没 complete 就释放：服务端会挂 decide_interrupted 信号并补建 checkpoint。
	expect((await post(app, `/projects/${pid}/decide/release`, { worker: "d1" })).status).toBe(200);

	const second = await post(app, `/projects/${pid}/decide/claim`, {
		worker: "d2",
		min_interval_seconds: 0,
	});
	expect((await second.json()).trigger).toContain("hint_added");
	const { changes } = await readGraph(app, pid, "d2");
	expect(JSON.stringify(changes)).toContain("SECRET HINT");
});
