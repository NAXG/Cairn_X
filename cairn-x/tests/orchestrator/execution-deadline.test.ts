/** Agent profile、执行截止时间与 Worker 启动校验必须使用同一套预算。 */

import { expect, test } from "vitest";

import {
	DEFAULT_GRACE_MS,
	assertExecutionBudget,
	executionDeadlineSeconds,
} from "../../src/contracts/execution.js";
import { addStep, createProject, startExecutorTestServer } from "./helpers.js";

test("createExecution reports the same budget it writes into deadline_at", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk",
	});
	try {
		const profile = server.control.store.profile("execute");
		const pid = await createProject(server.client);
		const sid = await addStep(server.client, pid);
		const eid = "a0000000-0000-4000-8000-0000000000e1";
		await server.client.claimStep(pid, sid, eid);
		const created = await server.client.createExecution({
			project_id: pid,
			step_id: sid,
			execution_id: eid,
		});
		if (!created.ok || !created.data) throw new Error("createExecution failed");

		// ① 预算以 Agent profile 为准（而不是 dispatch.yaml 的静态值）。
		const expected = executionDeadlineSeconds({
			runSeconds: profile.run_seconds,
			harvestSeconds: profile.harvest_seconds,
			graceMs: DEFAULT_GRACE_MS,
		});
		expect(created.data.deadline_seconds).toBe(expected);
		const serverDeadline = created.data.deadline_seconds;
		expect(typeof serverDeadline).toBe("number");
		// ①b 回归：deadline 必须严格大于 Worker 的最坏自保耗时。
		// Worker 每段 pass 都是「请求回合边界停止，宽限 graceMs 后硬 abort」，两段相加
		// = run + harvest + 2*grace。旧公式（run + harvest + 120）与它恰好相等，
		// 于是"模型用满宽限"的步骤 100% 撞控制端硬杀 —— 2026-09-11 现场 5/5
		// 的 status=lost 耗时都是 1497–1501s，就是这么来的。
		const graceSeconds = DEFAULT_GRACE_MS / 1000;
		const workerWorstCase =
			profile.run_seconds + graceSeconds + profile.harvest_seconds + graceSeconds;
		expect(serverDeadline).toBeGreaterThan(workerWorstCase);
		// ①c 服务端下发的预算必须能通过 Worker 启动自检（同一条不变量的两端）。
		expect(() =>
			assertExecutionBudget({
				stepMs: profile.run_seconds * 1000,
				harvestMs: profile.harvest_seconds * 1000,
				graceMs: DEFAULT_GRACE_MS,
				deadlineSeconds: serverDeadline,
			}),
		).not.toThrow();
		// ② 与写进 deadline_at 的实际截止时间一致（秒级容差）。
		const view = await server.client.getExecution(eid);
		expect(created.data.deadline_at).toBe(view.data!.deadline_at);
		const remaining = (Date.parse(view.data!.deadline_at!) - Date.now()) / 1000;
		expect(Math.abs(remaining - expected)).toBeLessThan(5);
	} finally {
		await server.close();
	}
});

// Worker 启动自检：把"deadline 必须覆盖最坏耗时"从注释里的约定变成会失败的门。
test("worker startup assert rejects a zero-margin budget and accepts the shared formula", () => {
	const worst = { stepMs: 1_200_000, harvestMs: 180_000, graceMs: DEFAULT_GRACE_MS };
	const budget = (graceMs: number) =>
		executionDeadlineSeconds({ runSeconds: 1200, harvestSeconds: 180, graceMs });

	// 共享公式：覆盖最坏耗时 + 启动余量 → 通过。
	expect(() =>
		assertExecutionBudget({ ...worst, deadlineSeconds: budget(DEFAULT_GRACE_MS) }),
	).not.toThrow();

	// 回归：旧公式 run + harvest + 120 = 1500s，恰好等于 Worker 最坏耗时 1500s，
	// 余量为零 —— 2026-09-11 那批 status=lost（1497–1501s）就是它。必须被拦下。
	expect(() => assertExecutionBudget({ ...worst, deadlineSeconds: 1200 + 180 + 120 })).toThrow(
		/not self-consistent/,
	);
	// 只包含最坏运行时间和启动余量，遗漏控制端收尾 margin 的预算也必须被拦下。
	expect(() => assertExecutionBudget({ ...worst, deadlineSeconds: 1200 + 180 + 120 + 60 })).toThrow(
		/not self-consistent/,
	);

	// 把宽限调大后 deadline 必须跟着涨（共享公式会自动跟）；
	// 只调宽限不改 deadline 必须被拦下。
	expect(() =>
		assertExecutionBudget({ ...worst, graceMs: 300_000, deadlineSeconds: budget(300_000) }),
	).not.toThrow();
	expect(() =>
		assertExecutionBudget({ ...worst, graceMs: 300_000, deadlineSeconds: 1500 }),
	).toThrow(/not self-consistent/);
});
