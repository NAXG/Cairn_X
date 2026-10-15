import { inspectClientProject } from "../support/project-state.js";
import { describe, expect, it, vi } from "vitest";

import { ClientError, FgsClient } from "../../src/orchestrator/client.js";
import { DispatcherLoop } from "../../src/scheduler/loop.js";
import { rotateProjects } from "../../src/scheduler/project-rotation.js";
import { type ExecuteContext } from "../../src/scheduler/types.js";
import { type Outcome } from "../../src/contracts/activity.js";
import { containerNameForProject } from "../../src/scheduler/launcher.js";
import {
	addStep,
	createProject,
	FakeLauncher,
	recordingRunners,
	silentLogger,
	seedServerRuntime,
	startTestServer,
	startExecutorTestServer,
	testConfig,
} from "./helpers.js";

const WORKER = { decide: "decide:t0", execute: "execute:t0" };
const WORKER_SUFFIX = "t0";

async function round(loop: DispatcherLoop): Promise<void> {
	await loop.tick();
	await loop.whenIdle();
}

describe("DispatcherLoop", () => {
	it("does not dispatch with stale YAML settings when runtime settings cannot be read", async () => {
		const { url, client } = await startTestServer();
		await createProject(client);
		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
		});
		const request = vi
			.spyOn(client, "getRuntimeSettings")
			.mockRejectedValueOnce(new Error("settings unavailable"));
		try {
			await expect(loop.tick()).rejects.toThrow("settings unavailable");
			expect(calls).toHaveLength(0);
		} finally {
			request.mockRestore();
			await loop.close();
		}
	});
	it("runs plugin operations in the background instead of blocking the tick", async () => {
		const { url, client } = await startTestServer();
		const { runners } = recordingRunners();
		let started = 0;
		let pluginFinished = false;
		let finishPlugin: () => void = () => {};
		const pluginGate = new Promise<void>((resolve) => {
			finishPlugin = () => {
				pluginFinished = true;
				resolve();
			};
		});
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			processPluginOperations: async () => {
				started += 1;
				await pluginGate;
			},
		});

		// 旧实现直接 await 它：一次安装（内含 docker run）期间整个调度节拍停摆。
		await loop.tick();
		expect(started).toBe(1);

		// 上一轮还没跑完时不得再起一轮，否则会在磁盘上并发改写 release 目录。
		await loop.tick();
		expect(started).toBe(1);

		// close 必须等在途操作收尾：它可能正在改写 release 目录。
		let closeSettled = false;
		const closing = loop.close().then(() => {
			closeSettled = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(closeSettled).toBe(false);

		finishPlugin();
		await closing;
		expect(pluginFinished).toBe(true);
	});

	it("dispatches decide first for a fresh project; decide creates the first concrete step", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client, { goal: "explore the target" });
		const fullRead = vi.spyOn(client, "getProjectOverview");
		let stepCreated = false;
		const { runners, calls } = recordingRunners({
			decide: async (ctx) => {
				if (stepCreated) {
					return "success";
				}
				stepCreated = true;
				const result = await ctx.client.createStep(ctx.projectId, {
					decide_worker: ctx.worker,
					from: ["origin"],
					description: "scan the target for open ports",
					creator: ctx.worker,
				});
				return result.ok ? "success" : "failed";
			},
		});
		seedServerRuntime(db, { max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await round(loop); // 首轮：decide(trigger="initial_run") 创建首个具体步骤
		expect(fullRead).not.toHaveBeenCalled();
		fullRead.mockRestore();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			activity: "decide",
			projectId: pid,
			trigger: "initial_run",
			worker: expect.stringContaining(WORKER.decide + ":"),
		});

		await round(loop); // 次轮：execute 认领并 conclude 该步骤
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({
			activity: "execute",
			projectId: pid,
			worker: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});

		const detail = await inspectClientProject(client, pid);
		expect(detail.steps).toHaveLength(1);
		expect(detail.steps[0]).toMatchObject({
			from: ["origin"],
			creator: expect.stringContaining(WORKER.decide + ":"),
			description: "scan the target for open ports",
			status: "concluded",
		});
		// 编排器不再种任何种子步骤
		expect(detail.steps.every((s) => s.creator !== "orchestrator")).toBe(true);
		// 默认 execute runner 会 conclude 这个 step，并创建一个 fact
		expect(detail.facts.map((f) => f.id)).toEqual(["origin", "f001"]);
	});

	it("pauses automatic planning after one interrupted retry and resumes on manual signal", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		const { runners, calls } = recordingRunners({ decide: async () => "cancelled" });
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
		});

		await round(loop);
		await round(loop);
		await round(loop);
		expect(calls.filter((call) => call.activity === "decide")).toHaveLength(2);
		expect((await inspectClientProject(client, pid)).planning).toMatchObject({
			interrupted_retries: 2,
			stalled: true,
		});

		expect((await client.signalDecide(pid, "manual")).ok).toBe(true);
		await round(loop);
		expect(calls.filter((call) => call.activity === "decide")).toHaveLength(3);
	});

	it("does not dispatch a step until its waiting_on dependency concludes", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		const dep = await addStep(client, pid, { description: "extract credentials" });
		const blockedResult = await client.createStep(pid, {
			actor: "human",
			from: ["origin"],
			description: "log in with the extracted credentials",
			waiting_on: [dep],
			creator: "test",
		});
		expect(blockedResult.ok).toBe(true);
		const blockedId = blockedResult.data!.id;

		seedServerRuntime(db, { max_project_workers: 2 });
		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 2 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await round(loop); // 依赖未 concluded：只派发 dep，blocked 留在队列
		const firstRound = calls.filter((c) => c.activity === "execute");
		expect(firstRound).toHaveLength(1);
		expect(firstRound[0]!.stepId).toBe(dep);

		// dep concluded 后（期间 decide 可能先跑一轮空转），blocked 解除阻塞
		for (let i = 0; i < 4 && calls.filter((c) => c.activity === "execute").length < 2; i++) {
			await round(loop);
		}
		const executeCalls = calls.filter((c) => c.activity === "execute");
		expect(executeCalls).toHaveLength(2);
		expect(executeCalls[1]!.stepId).toBe(blockedId);

		const detail = await inspectClientProject(client, pid);
		expect(detail.steps.find((s) => s.id === dep)?.status).toBe("concluded");
		expect(detail.steps.find((s) => s.id === blockedId)?.status).toBe("concluded");
	});

	it("holds every ready step while a decide replan is in flight", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		const dep = await addStep(client, pid, { description: "extract credentials" });
		const blockedResult = await client.createStep(pid, {
			actor: "human",
			from: ["origin"],
			description: "log in with the extracted credentials",
			waiting_on: [dep],
			creator: "test",
		});
		expect(blockedResult.ok).toBe(true);
		const blockedId = blockedResult.data!.id;

		seedServerRuntime(db, { max_project_workers: 2 });
		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 2 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await round(loop); // 首个可执行步骤 dep 完成
		const first = calls.filter((c) => c.activity === "execute");
		expect(first).toHaveLength(1);
		expect(first[0]!.stepId).toBe(dep);

		// 模拟依赖 conclude 带来的新事实触发了 Decide，它正在重规划（外部持有租约）。
		await client.signalDecide(pid, "test");
		expect((await client.claimDecide(pid, "external")).ok).toBe(true);
		const independent = await addStep(client, pid, {
			description: "independent follow-up created before replan finishes",
		});

		// Decide 在途：刚满足依赖的 blocked 和无依赖的 independent 都不得抢跑。
		for (let i = 0; i < 3; i += 1) {
			await round(loop);
		}
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(1);

		// Decide 收尾（释放租约）后门控解除；外部信号残留会先补一轮 decide（noop），
		// 随后 blocked 恢复派发。
		await client.releaseDecide(pid, "external");
		for (let i = 0; i < 5 && calls.filter((c) => c.activity === "execute").length < 3; i += 1) {
			await round(loop);
		}
		const after = calls.filter((c) => c.activity === "execute");
		expect(after).toHaveLength(3);
		expect(
			after
				.slice(1)
				.map((call) => call.stepId)
				.sort(),
		).toEqual([blockedId, independent].sort());
	});

	it("does not re-trigger decide after a no-op round once the plan is exhausted", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		// 铺一条已结束的步骤，让项目确实有过计划：空转抑制只对这类项目生效。
		const seedId = await addStep(client, pid, { description: "seed" });
		await client.claimStep(pid, seedId, "seed-exec");
		await client.concludeStep(pid, seedId, "seed-exec", "seed done");
		// 默认 fake decide 什么都不做直接 success：首轮 decide 不会产出任何步骤
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await round(loop); // 首次认领即重规划：项目有过计划且已无在办步骤
		const decideCalls = () => calls.filter((c) => c.activity === "decide");
		expect(decideCalls()).toHaveLength(1);
		expect(decideCalls()[0]?.trigger).toContain("waiting_timeout");
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(0);

		// 空转已记录（last_noop=1）、open==0 且项目有过计划：重放同一份图不再
		// 唤醒，兜底 waiting_timeout 不会每 min_interval 空烧一轮 Decide。
		await round(loop);
		expect(decideCalls()).toHaveLength(1);
	});

	it("re-triggers decide when an empty graph produced no plan at all", async () => {
		const { url, client, db } = await startTestServer();
		await createProject(client); // 从未产出任何步骤
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await round(loop); // decide(trigger="initial")，fake 什么都不做
		const decideCalls = () => calls.filter((c) => c.activity === "decide");
		expect(decideCalls()).toHaveLength(1);
		expect(decideCalls()[0]?.trigger).toBe("initial_run");
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(0);

		// 空图空转不得冻结项目：下一轮必须带 waiting_timeout 重新规划，
		// 否则 planner 一次没调 add_step 就会永久卡死（a-09 曾空转 74 分钟）。
		await round(loop);
		expect(decideCalls()).toHaveLength(2);
		expect(decideCalls()[1]?.trigger).toContain("waiting_timeout");
	});

	it("does not trigger decide while a step is claimed (still executing)", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		let release!: (outcome: Outcome) => void;
		const { runners, calls } = recordingRunners({
			execute: () =>
				new Promise<Outcome>((resolve) => {
					release = resolve;
				}),
		});
		seedServerRuntime(db, { max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await loop.tick(); // execute 认领 step 后挂起：step 处于 claimed，无 open step
		expect(calls.map((c) => c.activity)).toEqual(["execute"]);
		await loop.tick();
		await loop.tick();
		// 步骤仍在执行：不得空烧 decide
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(0);

		release("cancelled"); // 收尾：释放挂起的 runner，step 回到 open
		await loop.whenIdle();
	});

	it("triggers decide after execute concludes (open steps drained)", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		const now = 1_000_000_000;
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { decide_min_interval: 3600, max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { decide_min_interval: 3600, max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
			now: () => now,
		});

		await round(loop); // execute + conclude
		expect(calls.map((c) => c.activity)).toEqual(["execute"]);

		await round(loop); // decide 被触发
		const decideCalls = calls.filter((c) => c.activity === "decide");
		expect(decideCalls).toHaveLength(1);
		expect(decideCalls[0]?.worker).toEqual(expect.stringContaining(WORKER.decide + ":"));
		// 单条新事实不单独唤醒（有产出后的阈值 2），但步骤排空仍然立即触发。
		expect(decideCalls[0]?.trigger).toContain("waiting_timeout:1->0");
		expect(decideCalls[0]?.trigger).not.toContain("fact_added");

		// decide lease 已释放且 checkpoint 已更新：后续 round 不再有动作
		// （"无事可做"兜底触发被 decide_min_interval 防抖压住）
		const detail = await inspectClientProject(client, pid);
		expect(detail.project.decide).toBeNull();
		await round(loop);
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(1);
	});

	it("debounces decide triggers within decide_min_interval", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		let now = 1_000_000_000;
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { decide_min_interval: 3600, max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { decide_min_interval: 3600, max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
			now: () => now,
		});

		await round(loop); // execute + conclude
		await round(loop); // 第一次 decide（facts 1->2，open 1->0）
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(1);

		// 防抖窗口内的 graph 变化：不会触发新的 decide（上一轮 Decide 空转，
		// 事实阈值是 3）。
		for (const n of [1, 2, 3]) {
			await client.createFact(pid, {
				confidence: "observed",
				actor: "human",
				description: `external fact ${n}`,
			});
		}
		await round(loop);
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(1);

		// 窗口过后（服务端防抖按真实时间：直接回拨 checkpoint），累积的事实达到阈值触发一次
		db.prepare("UPDATE decide_checkpoints SET updated_at = ? WHERE project_id = ?").run(
			new Date(Date.now() - 3601 * 1000).toISOString(),
			pid,
		);
		await round(loop);
		const decideCalls = calls.filter((c) => c.activity === "decide");
		expect(decideCalls).toHaveLength(2);
		expect(decideCalls[1]?.trigger).toContain("fact_added:2->5");
		await round(loop);
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(2);
	});

	it("triggers decide when new hints arrive", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		await round(loop); // checkpoint 初始化 + execute + conclude
		await round(loop); // 因 facts/open_steps 触发的 decide，checkpoint 已更新
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(1);

		await client.createHint(pid, { content: "try harder", creator: "human" });
		await round(loop);
		const decideCalls = calls.filter((c) => c.activity === "decide");
		expect(decideCalls).toHaveLength(2);
		expect(decideCalls[1]?.trigger).toContain("hint_added:0->1");
	});

	it("dispatches steps by priority (ties: newest first)", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		const low = await addStep(client, pid, { priority: 0, description: "low" });
		const high = await addStep(client, pid, { priority: 5, description: "high" });
		const mid = await addStep(client, pid, { priority: 3, description: "mid" });
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_workers: 1, max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_workers: 1, max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		for (let i = 0; i < 8 && calls.filter((c) => c.activity === "execute").length < 3; i += 1) {
			await round(loop);
		}
		const executed = calls.filter((c) => c.activity === "execute").map((c) => c.stepId);
		expect(executed).toEqual([high, mid, low]);
	});

	it("enforces the global max_workers cap", async () => {
		const { url, client, db } = await startTestServer();
		const p1 = await createProject(client);
		const p2 = await createProject(client);
		await addStep(client, p1);
		await addStep(client, p2);
		// 本测试只验证 Execute 的全局额度；关闭 Decide 派发，避免步骤完成后的
		// 规划批次占用唯一的全局 worker。不能再靠外部持有 Decide 租约实现：
		// 新调度语义会在任何 Decide 在途时暂停该项目的新 Execute。
		vi.spyOn(client, "claimDecide").mockResolvedValue({
			statusCode: 409,
			ok: false,
			data: undefined,
			text: "disabled by test",
		});

		let running = 0;
		let maxRunning = 0;
		const releases: Array<() => void> = [];
		const { runners, calls } = recordingRunners({
			execute: async (ctx: ExecuteContext) => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				try {
					await new Promise<void>((resolve) => releases.push(resolve));
					const result = await ctx.client.concludeStep(
						ctx.projectId,
						ctx.stepId,
						ctx.worker,
						"done",
					);
					return result.ok ? "success" : "failed";
				} finally {
					running -= 1;
				}
			},
		});
		seedServerRuntime(db, { max_workers: 1, max_running_projects: 2, max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, {
				runtime: { max_workers: 1, max_running_projects: 2, max_project_workers: 1 },
			}),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		const releaseAll = () => {
			releases.forEach((release) => release());
			releases.length = 0;
		};

		await loop.tick();
		const firstProject = calls[0]?.projectId;
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(1);
		await loop.tick(); // 被阻塞：达到全局上限
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(1);

		releaseAll();
		await loop.whenIdle();

		for (let i = 0; i < 8 && calls.filter((c) => c.activity === "execute").length < 2; i += 1) {
			await loop.tick();
			releaseAll();
			await loop.whenIdle();
		}
		const executed = calls.filter((c) => c.activity === "execute");
		expect(executed).toHaveLength(2);
		expect(executed.map((c) => c.projectId)).not.toEqual([firstProject, firstProject]);
		expect(maxRunning).toBe(1);
	});

	it("enforces the per-project max_project_workers cap", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		await addStep(client, pid, { description: "do follow-up work" });

		let running = 0;
		let maxRunning = 0;
		const releases: Array<() => void> = [];
		const { runners, calls } = recordingRunners({
			execute: async (ctx: ExecuteContext) => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				try {
					await new Promise<void>((resolve) => releases.push(resolve));
					const result = await ctx.client.concludeStep(
						ctx.projectId,
						ctx.stepId,
						ctx.worker,
						"done",
					);
					return result.ok ? "success" : "failed";
				} finally {
					running -= 1;
				}
			},
		});
		seedServerRuntime(db, { max_workers: 8, max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_workers: 8, max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		const releaseAll = () => {
			releases.forEach((release) => release());
			releases.length = 0;
		};

		await loop.tick();
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(1);
		await loop.tick(); // 被阻塞：单项目上限
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(1);

		releaseAll();
		await loop.whenIdle();
		for (let i = 0; i < 8 && calls.filter((c) => c.activity === "execute").length < 2; i += 1) {
			await loop.tick();
			releaseAll();
			await loop.whenIdle();
		}
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(2);
		expect(maxRunning).toBe(1);
	});

	it("serves running projects first without starving idle ones", async () => {
		const { url, client, db } = await startTestServer();
		const projects = [
			await createProject(client),
			await createProject(client),
			await createProject(client),
		];
		for (const pid of projects) {
			await addStep(client, pid);
			await addStep(client, pid, { description: "do follow-up work" });
		}
		// 结构化完成边界要求每个 concluded Step 先经过一次 Decide；本测试只对
		// Execute 调用做轮转断言，穿插的 Decide 由默认 recording runner 完成。
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_workers: 1, max_running_projects: 3, max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, {
				runtime: { max_workers: 1, max_running_projects: 3, max_project_workers: 1 },
			}),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		for (let i = 0; i < 30 && calls.filter((c) => c.activity === "execute").length < 6; i += 1) {
			await round(loop);
		}
		const executeCalls = calls.filter((c) => c.activity === "execute");
		expect(executeCalls).toHaveLength(6);
		// 项目会一直留在运行集合中直到 step 耗尽，因此
		// 每个项目依次被清空，谁都不会被饿死
		expect(executeCalls.map((c) => c.projectId)).toEqual([
			projects[0],
			projects[0],
			projects[1],
			projects[1],
			projects[2],
			projects[2],
		]);
		// 项目内部：相同 priority 时最新的 step 先派发
		expect(executeCalls[0]?.stepId).toBe("s002");
		expect(executeCalls[1]?.stepId).toBe("s001");
	});

	it("project rotation preserves string ordering, object identity and input order", () => {
		const projects = [{ id: "p2" }, { id: "p10" }, { id: "P1" }];
		const original = [...projects];
		expect(rotateProjects(projects, 4)).toEqual([projects[1], projects[0], projects[2]]);
		expect(rotateProjects(projects, 0)[0]).toBe(projects[2]);
		expect(projects).toEqual(original);
		expect(rotateProjects([], 1)).toEqual([]);
	});

	it("rotates the round-robin project cursor", () => {
		const loop = new DispatcherLoop({
			config: testConfig("http://127.0.0.1:1"),
			client: new FgsClient("http://127.0.0.1:1", 500),
			runners: recordingRunners().runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		const whiteBox = loop as unknown as {
			orderedProjects(
				list: "running" | "idle",
				summaries: Array<{ id: string }>,
			): Array<{ id: string }>;
		};
		const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const rotations = [0, 1, 2, 3].map(() =>
			whiteBox.orderedProjects("running", list).map((s) => s.id),
		);
		expect(rotations).toEqual([
			["a", "b", "c"],
			["b", "c", "a"],
			["c", "a", "b"],
			["a", "b", "c"],
		]);
		// 每个节拍两个列表各排一次：共用游标时每拍前进 2，长度为 2 的列表永远从同一个开头。
		const pair = [{ id: "x" }, { id: "y" }];
		const heads = [0, 1, 2, 3].map(() => {
			whiteBox.orderedProjects("running", list);
			return whiteBox.orderedProjects("idle", pair)[0].id;
		});
		expect(heads).toEqual(["x", "y", "x", "y"]);
	});

	it("caps engaged projects by max_running_projects", async () => {
		const { url, client, db } = await startTestServer();
		const p1 = await createProject(client);
		const p2 = await createProject(client);
		const p3 = await createProject(client);
		for (const pid of [p1, p2, p3]) {
			await addStep(client, pid);
		}
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_workers: 8, max_running_projects: 2, max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, {
				runtime: { max_workers: 8, max_running_projects: 2, max_project_workers: 1 },
			}),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		for (let i = 0; i < 5; i += 1) {
			await round(loop);
		}
		const engaged = new Set(calls.map((c) => c.projectId));
		expect(engaged.size).toBe(2);
		expect(engaged.has(p3)).toBe(false);
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(2);
	});

	it("releases the running slot of a project that stays without local work", async () => {
		const { url, client, db } = await startTestServer();
		const p1 = await createProject(client);
		const p2 = await createProject(client);
		await addStep(client, p1);
		await addStep(client, p2);
		// 不让 Decide 介入：被接管的项目做完唯一的步骤后就再没有可做的事，
		// 相当于等待人工处理的停滞项目。
		vi.spyOn(client, "claimDecide").mockResolvedValue({
			statusCode: 409,
			ok: false,
			data: undefined,
			text: "disabled by test",
		});
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_workers: 8, max_running_projects: 1, max_project_workers: 1 });
		let now = 1_000_000;
		const loop = new DispatcherLoop({
			config: testConfig(url, {
				runtime: { max_workers: 8, max_running_projects: 1, max_project_workers: 1 },
			}),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
			now: () => now,
		});

		for (let i = 0; i < 3; i += 1) await round(loop);
		const engaged = () =>
			new Set(calls.filter((c) => c.activity === "execute").map((c) => c.projectId));
		expect(engaged().size).toBe(1);

		// 空闲超过 project_idle_seconds（测试配置 600s）后让出名额，另一个项目得以派发。
		now += 601_000;
		for (let i = 0; i < 2; i += 1) await round(loop);
		expect(engaged()).toEqual(new Set([p1, p2]));
	});

	it("a second close() waits for the same shutdown instead of returning early", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		vi.spyOn(client, "claimDecide").mockResolvedValue({
			statusCode: 409,
			ok: false,
			data: undefined,
			text: "disabled by test",
		});
		let finishTask!: () => void;
		let taskSettled = false;
		const { runners } = recordingRunners({
			// 收到中止后还要再收尾一会儿（模拟等待 Worker 上报终态）。
			execute: (_ctx, signal) =>
				new Promise<Outcome>((resolve) => {
					signal.addEventListener("abort", () => {
						finishTask = () => {
							taskSettled = true;
							resolve("cancelled");
						};
					});
				}),
		});
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		await loop.tick();
		// 信号处理器触发第一次 close()，run() 的 finally 随后触发第二次。
		const first = loop.close();
		let secondDone = false;
		const second = loop.close().then(() => {
			secondDone = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(secondDone).toBe(false);
		finishTask();
		await Promise.all([first, second]);
		expect(taskSettled).toBe(true);
	});

	it("does not fetch project detail for projects with nothing to dispatch", async () => {
		const { url, client } = await startTestServer();
		const idle = await createProject(client);
		const busy = await createProject(client);
		await addStep(client, busy);
		vi.spyOn(client, "claimDecide").mockResolvedValue({
			statusCode: 409,
			ok: false,
			data: undefined,
			text: "no trigger",
		});
		const detail = vi.spyOn(client, "getProjectOverview");
		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		await round(loop);
		// 没有待领取步骤、也没有规划触发的项目只走一次 claimDecide，不拉详情。
		expect(detail.mock.calls.map(([pid]) => pid)).not.toContain(idle);
		expect(detail).not.toHaveBeenCalled();
		expect(calls.filter((c) => c.activity === "execute").map((c) => c.projectId)).toEqual([busy]);
	});

	it("fails the dispatch round when candidate reads fail without falling back to full project reads", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		vi.spyOn(client, "claimDecide").mockResolvedValue({
			ok: false,
			statusCode: 409,
			text: "no trigger",
			data: undefined,
		});
		vi.spyOn(client, "getSchedulingCandidates").mockRejectedValue(
			new Error("scheduling unavailable"),
		);
		const detail = vi.spyOn(client, "getProjectOverview");
		const list = vi.spyOn(client, "listSchedulingProjects");
		const claim = vi.spyOn(client, "claimStep");
		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
		});
		try {
			await expect(loop.tick()).rejects.toThrow("scheduling unavailable");
			expect(detail).not.toHaveBeenCalled();
			expect(list).toHaveBeenCalledTimes(1);
			expect(claim).not.toHaveBeenCalled();
			expect(calls).toHaveLength(0);
		} finally {
			await loop.close();
		}
	});

	it("aborts running tasks when their project stops", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);

		const abortReasons: unknown[] = [];
		const { runners, calls } = recordingRunners({
			execute: (_ctx, signal) =>
				new Promise<Outcome>((resolve) => {
					signal.addEventListener("abort", () => {
						abortReasons.push(signal.reason);
						resolve("cancelled");
					});
				}),
		});
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await loop.tick();
		expect(calls).toHaveLength(1);

		await client.setProjectStatus(pid, "stopped");
		await loop.tick(); // 观察到项目已停止 -> 中止任务
		await loop.whenIdle();

		expect(abortReasons).toEqual(["stopped"]);
		const detail = await inspectClientProject(client, pid);
		expect(detail.steps[0]).toMatchObject({ status: "open", worker: null });
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(0);
	});

	it("a tick in flight during close() never starts an un-abortable task", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		// 本测试要卡在 Execute 的 claimStep 上；直接关闭 Decide claim，避免
		// 在途 Decide 按新语义暂停 Execute。
		vi.spyOn(client, "claimDecide").mockResolvedValue({
			statusCode: 409,
			ok: false,
			data: undefined,
			text: "disabled by test",
		});

		// 真正的 claimStep 在返回成功响应前挂起，close() 后须释放已取得的租约。
		let enterClaim!: () => void;
		const claimEntered = new Promise<void>((resolve) => (enterClaim = resolve));
		let releaseClaim!: () => void;
		const claimGate = new Promise<void>((resolve) => (releaseClaim = resolve));
		const gatedClient = new Proxy(client, {
			get(target, prop, receiver) {
				if (prop === "claimStep") {
					return async (...args: Parameters<typeof target.claimStep>) => {
						const result = await target.claimStep(...args);
						expect(result.ok).toBe(true);
						enterClaim();
						await claimGate;
						return result;
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client: gatedClient,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		const tick = loop.tick();
		await claimEntered;
		await loop.close(); // closed=true；此刻任务尚未注册，whenIdle 立即返回
		releaseClaim();
		await tick;
		await loop.whenIdle();

		// close() 之后完成的认领不得启动任务：否则 runner 永不被 abort，
		// whenIdle 会被拖到 step 截止（分钟级）。
		expect(calls).toHaveLength(0);
		expect(loop.runningTaskCount).toBe(0);
		expect((await inspectClientProject(client, pid)).steps[0]).toMatchObject({
			status: "open",
			worker: null,
		});
	});

	it("releases a decide lease acquired just before close", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		let enterClaim!: () => void;
		const claimEntered = new Promise<void>((resolve) => (enterClaim = resolve));
		let releaseClaim!: () => void;
		const claimGate = new Promise<void>((resolve) => (releaseClaim = resolve));
		const claimDecide = client.claimDecide.bind(client);
		vi.spyOn(client, "claimDecide").mockImplementation(async (...args) => {
			const result = await claimDecide(...args);
			expect(result.ok).toBe(true);
			enterClaim();
			await claimGate;
			return result;
		});
		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		const tick = loop.tick();
		await claimEntered;
		await loop.close();
		releaseClaim();
		await tick;
		expect(calls).toHaveLength(0);
		expect((await inspectClientProject(client, pid)).project.decide).toBeNull();
	});

	it("retains an execution lease when creation outcome cannot be determined", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		const sid = await addStep(client, pid);
		vi.spyOn(client, "claimDecide").mockResolvedValue({
			statusCode: 409,
			ok: false,
			data: undefined,
			text: "disabled by test",
		});
		const { runners, calls } = recordingRunners();
		runners.execute = async (ctx) => {
			calls.push({ activity: "execute", projectId: ctx.projectId, worker: ctx.worker });
			return "uncertain";
		};
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		await round(loop);
		expect(calls).toHaveLength(1);
		expect(
			(await inspectClientProject(client, pid)).steps.find((step) => step.id === sid),
		).toMatchObject({
			status: "claimed",
			worker: calls[0]!.worker,
		});
	});

	it("cools down the execute endpoint after unhealthy outcomes", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		await addStep(client, pid, { description: "do follow-up work" });

		let now = 1_000_000_000;
		let executeCalls = 0;
		const { runners, calls } = recordingRunners({
			execute: async (ctx: ExecuteContext): Promise<Outcome> => {
				executeCalls += 1;
				if (executeCalls === 1) {
					return "unhealthy";
				}
				const result = await ctx.client.concludeStep(ctx.projectId, ctx.stepId, ctx.worker, "done");
				return result.ok ? "success" : "failed";
			},
		});
		seedServerRuntime(db, { max_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { endpoint_cooldown: 60, max_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
			now: () => now,
		});

		await round(loop); // 第一次 execute -> unhealthy
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(1);
		// 失败的 step 被释放回 open
		const detail = await inspectClientProject(client, pid);
		expect(detail.steps.find((s) => s.id === calls[0]?.stepId)).toMatchObject({
			status: "open",
			worker: null,
		});

		await round(loop); // endpoint 冷却中：不派发
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(1);

		now += 61 * 1000;
		await round(loop); // cooldown 过期：恢复派发
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(2);
	});

	it("benches only the offending project after a single unhealthy outcome", async () => {
		const { url, client } = await startTestServer();
		const pidA = await createProject(client);
		const pidB = await createProject(client);
		await addStep(client, pidA);
		await addStep(client, pidB);

		let now = 1_000_000_000;
		const { runners, calls } = recordingRunners({
			execute: async (ctx: ExecuteContext): Promise<Outcome> => {
				if (ctx.projectId === pidA) {
					return "unhealthy";
				}
				return "failed";
			},
		});
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { endpoint_cooldown: 60 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
			now: () => now,
		});

		await round(loop); // A 返回 unhealthy，B 返回 failed
		expect(calls.filter((c) => c.projectId === pidA && c.activity === "execute")).toHaveLength(1);
		expect(calls.filter((c) => c.projectId === pidB && c.activity === "execute")).toHaveLength(1);

		await round(loop); // 只有 A 被按停；B 的 failed 结果既不阻塞 B，也不清除 A 的 cooldown
		expect(calls.filter((c) => c.projectId === pidA && c.activity === "execute")).toHaveLength(1);
		expect(calls.filter((c) => c.projectId === pidB && c.activity === "execute")).toHaveLength(2);

		now += 61 * 1000;
		await round(loop); // A 的窗口过期：恢复执行
		expect(calls.filter((c) => c.projectId === pidA && c.activity === "execute")).toHaveLength(2);
	});

	it("escalates to a whole-activity cooldown after consecutive unhealthy outcomes", async () => {
		const { url, client } = await startTestServer();
		const pidA = await createProject(client);
		const pidB = await createProject(client);
		await addStep(client, pidA);
		await addStep(client, pidB);

		let now = 1_000_000_000;
		const { runners, calls } = recordingRunners({
			execute: async (): Promise<Outcome> => "unhealthy",
		});
		const loop = new DispatcherLoop({
			config: testConfig(url, {
				runtime: { endpoint_cooldown: 60, endpoint_unhealthy_threshold: 2 },
			}),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
			now: () => now,
		});

		await round(loop); // A + B 连续 unhealthy：整个 activity 现在进入冷却
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(2);

		// 从未失败过的新项目也被阻塞：cooldown 现在是整个 activity 级别的
		const pidC = await createProject(client);
		await addStep(client, pidC);
		await round(loop);
		expect(calls.filter((c) => c.projectId === pidA && c.activity === "execute")).toHaveLength(1);
		expect(calls.filter((c) => c.projectId === pidB && c.activity === "execute")).toHaveLength(1);
		expect(calls.filter((c) => c.projectId === pidC && c.activity === "execute")).toHaveLength(0);

		now += 61 * 1000;
		await round(loop); // 所有人的 cooldown 都过期：三个项目都恢复派发
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(5);
	});

	it("a failed outcome does not clear an active activity-wide cooldown", async () => {
		const { url, client } = await startTestServer();
		const pidA = await createProject(client);
		const pidB = await createProject(client);
		const pidC = await createProject(client);
		await addStep(client, pidA);
		await addStep(client, pidB);
		await addStep(client, pidC);

		let now = 1_000_000_000;
		const { runners, calls } = recordingRunners({
			execute: async (ctx: ExecuteContext): Promise<Outcome> => {
				return ctx.projectId === pidC ? "failed" : "unhealthy";
			},
		});
		const loop = new DispatcherLoop({
			config: testConfig(url, {
				runtime: { endpoint_cooldown: 60, endpoint_unhealthy_threshold: 2 },
			}),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
			now: () => now,
		});

		await round(loop); // 两次 unhealthy -> 全局 cooldown；C 的 failed 不能清除它
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(3);

		await round(loop); // 一切仍被阻塞
		expect(calls.filter((c) => c.activity === "execute")).toHaveLength(3);
	});

	it("skips decide while another worker holds the lease", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		const { runners, calls } = recordingRunners();
		seedServerRuntime(db, { max_project_workers: 1 });
		const loop = new DispatcherLoop({
			config: testConfig(url, { runtime: { max_project_workers: 1 } }),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await round(loop); // execute + conclude
		await client.signalDecide(pid, "test");
		const claim = await client.claimDecide(pid, "external");
		expect(claim.ok).toBe(true);
		await round(loop); // 有触发条件但 lease 被他人持有
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(0);

		await client.releaseDecide(pid, "external");
		await round(loop);
		expect(calls.filter((c) => c.activity === "decide")).toHaveLength(1);
	});

	it("skips steps claimed by another worker", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		const sid = await addStep(client, pid);
		const claim = await client.claimStep(pid, sid, "external");
		expect(claim.ok).toBe(true);

		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		await round(loop);
		expect(calls).toHaveLength(0);
	});

	it("reconciles orphan worker containers each round", async () => {
		const { url, client } = await startExecutorTestServer({
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "test",
		});
		const launcher = new FakeLauncher();
		const pid = await createProject(client);

		const { runners } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher,
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		// 两个无主容器（running + exited）都应被回收。
		launcher.states.set("cairn-pw-orphan1", "running");
		launcher.states.set("cairn-pw-orphan2", "exited");

		await round(loop);
		const removed = launcher.removed;
		expect(removed).toContain("cairn-pw-orphan1");
		expect(removed).toContain("cairn-pw-orphan2");
		void pid;
	});

	it("keeps containers of busy projects during reconcile", async () => {
		const { url, client } = await startTestServer();
		const launcher = new FakeLauncher();
		const pid = await createProject(client);
		await addStep(client, pid);

		// execute runner 启动容器后挂起：容器属于活跃任务（与真实
		// execute runner 相同的 launcher.start 调用路径）。
		let release!: (outcome: Outcome) => void;
		const runners = {
			decide: async (): Promise<Outcome> => "success",
			execute: async (ctx: ExecuteContext, _signal: AbortSignal): Promise<Outcome> => {
				await launcher.ensure({
					projectId: ctx.projectId,
					issueToken: async () => "test-token",
					concurrency: 4,
				});
				return new Promise((resolve) => {
					release = () => {
						resolve("cancelled");
					};
				});
			},
		};
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher,
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await loop.tick(); // 派发 execute；runner 挂起
		const handle = containerNameForProject(pid);
		expect(launcher.states.get(handle)).toBe("running");

		await loop.tick(); // 项目容器对账不得触碰活跃项目的容器
		expect(launcher.removed).not.toContain(handle);

		// 项目停止 → 取消任务 → runner 放行。
		await client.setProjectStatus(pid, "stopped");
		await loop.tick();
		release("cancelled");
		await loop.whenIdle();
	});

	it("run --once performs a single round and run() retries dead servers", async () => {
		const { url, client } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid);
		const { runners, calls } = recordingRunners();
		const loop = new DispatcherLoop({
			config: testConfig(url),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		await loop.run({ once: true });
		expect(calls.filter((c) => c.activity === "execute" && c.projectId === pid)).toHaveLength(1);
		const detail = await inspectClientProject(client, pid);
		expect(detail.steps[0]?.status).toBe("concluded");

		const dead = new DispatcherLoop({
			config: testConfig("http://127.0.0.1:1"),
			client: new FgsClient("http://127.0.0.1:1", 500),
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});
		await expect(dead.run({ once: true })).rejects.toBeInstanceOf(ClientError);
	});
});

describe("parallel execute dispatch", () => {
	it("dispatches a second step of the same project while the first is running; each with its own execution id", async () => {
		const { url, client, db } = await startTestServer();
		const pid = await createProject(client);
		await addStep(client, pid, { description: "step one" });
		await addStep(client, pid, { description: "step two" });
		let unblock: (() => void) | null = null;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		let firstCall = true;
		const { runners, calls } = recordingRunners({
			execute: async () => {
				if (firstCall) {
					firstCall = false;
					await blocked; // 占住项目直到第二个 step 被派发，制造真实并行
					return "success";
				}
				unblock?.();
				return "success";
			},
		});
		seedServerRuntime(db, { max_project_workers: 4 });
		const loop = new DispatcherLoop({
			config: testConfig(url, {
				runtime: { max_project_workers: 4 },
			}),
			client,
			runners,
			launcher: new FakeLauncher(),
			logger: silentLogger,
			workerSuffix: WORKER_SUFFIX,
		});

		await loop.tick(); // 同一轮内：两个 step 各自派发一次执行尝试
		await loop.whenIdle();

		const execCalls = calls.filter((c) => c.activity === "execute");
		expect(execCalls).toHaveLength(2);
		// 每次尝试都有独立的 execution_id（uuid，同时是租约身份）。
		expect(execCalls[0]?.worker).not.toBe(execCalls[1]?.worker);
		for (const call of execCalls) {
			expect(call.worker).toMatch(/^[0-9a-f-]{36}$/);
		}
	});
});
