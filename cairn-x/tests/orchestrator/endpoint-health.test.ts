import { inspectClientProject } from "../support/project-state.js";
/**
 * 端点健康信号回归（P0-2）：
 *
 * 修复前：execution 的 failed 与 unhealthy 在控制端完全不可区分 ——
 * result_outcome 一律是 "failed"、error 是 null，于是 DispatcherLoop 的
 * recordUnhealthy 永远收不到信号，execute 的 endpoint 冷却是死代码。
 *
 * 修复后：Worker 在 error 里写入 UNHEALTHY_ERROR_MARKER，execute runner
 * 据此上浮为 "unhealthy"，冷却恢复工作；同时步骤仍走 release→open 重试，
 * 不像 lost 那样被关闭交回 Decide。
 *
 * 冷却机制本身（项目级 → 活动级升级、成功清零）已在
 * tests/orchestrator/loop.test.ts 覆盖，这里只验证「真实 Worker 失败 →
 * 冷却被触发」这一段此前从未打通的链路。
 */

import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import { UNHEALTHY_ERROR_MARKER } from "../../src/contracts/execution.js";
import { createProjectExecuteRunner } from "../../src/scheduler/execute.js";
import { DispatcherLoop } from "../../src/scheduler/loop.js";
import {
	addStep,
	createProject,
	scriptConnectionWithFaux,
	silentLogger,
	startExecutorTestServer,
	testConfig,
} from "./helpers.js";
import { WorkerInProcessLauncher } from "./worker-launcher.js";

const EID = "a0000000-0000-4000-8000-0000000000f1";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test(
	"endpoint failure: execution carries the unhealthy marker and the runner reports unhealthy",
	{ timeout: 60_000 },
	async () => {
		const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
		faux.setResponses(
			Array.from({ length: 5 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 529 overloaded" }),
			),
		);
		const server = await startExecutorTestServer({
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "sk-long-term-upstream-key",
		});
		await scriptConnectionWithFaux(server.control, "imported-execute", faux);
		const launcher = new WorkerInProcessLauncher({ controlUrl: server.url, logger: silentLogger });
		const runner = createProjectExecuteRunner({
			config: testConfig(server.url),
			client: server.client,
			projectLauncher: launcher,
			logger: silentLogger,
		});

		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId, { description: "find the flag" });
		await server.client.claimStep(projectId, stepId, EID);
		const outcome = await runner(
			{
				client: server.client,
				projectId,
				stepId,
				worker: EID,
			},
			new AbortController().signal,
		);

		// ① 控制端可区分：状态仍是 failed（协议取向没有 unhealthy），
		//    但 error 带标记、不再是 null。
		expect(outcome).toBe("unhealthy");
		const view = await server.client.getExecution(EID);
		expect(view.data?.status).toBe("failed");
		expect(view.data?.error).toContain(UNHEALTHY_ERROR_MARKER);
		// ② 端点故障不是 lost：步骤未被关闭，重试计划仍然有效。
		const after = await inspectClientProject(server.client, projectId);
		expect(after.steps[0]!.status).not.toBe("abandoned");
	},
);

test(
	"a real worker endpoint failure reaches the dispatcher and benches the project",
	{ timeout: 60_000 },
	async () => {
		const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
		faux.setResponses(
			Array.from({ length: 5 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 529 overloaded" }),
			),
		);
		const server = await startExecutorTestServer({
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "sk-long-term-upstream-key",
		});
		await scriptConnectionWithFaux(server.control, "imported-execute", faux);
		const launcher = new WorkerInProcessLauncher({ controlUrl: server.url, logger: silentLogger });
		const logs: string[] = [];
		const logger = {
			debug: () => {},
			info: (m: string) => logs.push(m),
			warn: (m: string) => logs.push(m),
			error: (m: string) => logs.push(m),
		};
		let clock = 1_000_000_000;
		const config = testConfig(server.url, {
			runtime: { endpoint_cooldown: 60, max_workers: 1, max_project_workers: 1 },
		});
		const loop = new DispatcherLoop({
			config,
			client: server.client,
			launcher,
			runners: {
				decide: async () => "failed",
				execute: createProjectExecuteRunner({
					config,
					client: server.client,
					projectLauncher: launcher,
					logger,
				}),
			},
			logger,
			workerSuffix: "endpoint-health-test",
			now: () => clock,
		});
		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId, { description: "find the flag" });

		await loop.tick();
		await loop.whenIdle();

		// 修复前：outcome = failed → 这条冷却日志永远不会出现。
		expect(
			logs.some((m) => m.includes("project cooling down") && m.includes("activity=execute")),
		).toBe(true);
		// 步骤被释放回 open（保留原 id / 优先级 / 血缘），等待冷却后重试。
		const detail = await inspectClientProject(server.client, projectId);
		expect(detail.steps.find((s) => s.id === stepId)).toMatchObject({
			status: "open",
			worker: null,
		});

		// 冷却窗口内同一项目不再派发（此时 worker 名相同，只有冷却能挡住它）。
		const before = logs.length;
		await loop.tick();
		expect(logs.slice(before).some((m) => m.includes("dispatched execute"))).toBe(false);

		// 冷却过期后恢复派发。
		clock += 61 * 1000;
		await loop.close();
		await server.close();
	},
);
test(
	"explore failure still runs the harvest pass and salvages unsubmitted facts",
	{ timeout: 90_000 },
	async () => {
		const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
		// 有限脚本：探索阶段一直干 tool 调用，第 40 次之后开始返回流错误 ——
		// 模拟"探索在提交完事实之前就失败"。一旦进入收割阶段立刻转为提交残留事实。
		let llmCalls = 0;
		faux.setResponses(
			Array.from({ length: 200 }, () => async (context: Context) => {
				await sleep(20);
				const userText = (m: { role: string; content: unknown }) =>
					m.role === "user" ? JSON.stringify(m.content) : "";
				const inHarvest = context.messages.some((m) => userText(m).includes("现在是收尾阶段"));
				llmCalls += 1;
				if (inHarvest) {
					if (
						context.messages.some(
							(m) => m.role === "toolResult" && JSON.stringify(m.content).includes("salvaged"),
						)
					) {
						return fauxAssistantMessage("Harvest done: salvaged the late fact.");
					}
					return fauxAssistantMessage(
						[
							fauxToolCall("submit_fact", {
								confidence: "observed",
								description: "salvaged: target exposes SSH on 22",
							}),
						],
						{ stopReason: "toolUse" },
					);
				}
				if (llmCalls > 40) {
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "upstream stream dropped mid-explore",
					});
				}
				return fauxAssistantMessage([fauxToolCall("search_execution_events", { query: "x" })], {
					stopReason: "toolUse",
				});
			}),
		);
		const server = await startExecutorTestServer(
			{ api: "openai-completions", base_url: "http://unused", api_key: "k" },
			{ timeouts: { step_ms: 20_000, harvest_ms: 30_000, grace_ms: 2_000 } },
		);
		await scriptConnectionWithFaux(server.control, "imported-execute", faux);
		const launcher = new WorkerInProcessLauncher({ controlUrl: server.url, logger: silentLogger });
		const eid = "a0000000-0000-4000-8000-0000000000f2";
		const runner = createProjectExecuteRunner({
			config: testConfig(server.url, {
				tasks: {
					execute: {
						step_timeout: 20,
						harvest_timeout: 30,
						bash_timeout: 120,
					},
				},
			}),
			client: server.client,
			projectLauncher: launcher,
			logger: silentLogger,
		});
		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId, { description: "find the flag" });
		await server.client.claimStep(projectId, stepId, eid);
		const outcome = await runner(
			{
				client: server.client,
				projectId,
				stepId,
				worker: eid,
			},
			new AbortController().signal,
		);

		expect(outcome).not.toBe("success");
		const view = await server.client.getExecution(eid);
		expect(view.data?.status).toBe("failed");
		// ② 关键（P1-3）：探索失败之后收割仍然跑过，把残留事实提交进了图。
		//    修复前这里会是空数组 —— 探索失败直接 return，收割从不执行。
		const after = await inspectClientProject(server.client, projectId);
		expect(after.facts.some((f) => f.description.includes("salvaged"))).toBe(true);
	},
);
