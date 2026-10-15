import { inspectClientProject } from "../support/project-state.js";
/**
 * Worker 主循环测试：真实 Worker 代码 + 真实执行控制面（HTTP），
 * LLM 通过 faux provider 脚本化，模型流量经控制端受限代理。
 *
 * 覆盖：两 pass 语义（探索 + 收割）、事实/发现提交、用量遥测、
 * 会话轨迹持久化、到点强停、收割硬闸门、取消、模型端点故障。
 */

import {
	fauxAssistantMessage,
	fauxToolCall,
	fauxProvider,
	getCurrentSystemPrompt,
	type Context,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { PluginStore } from "../../src/plugins/store.js";
import type { ProjectDigest } from "../../src/contracts/digest.js";

import { UNHEALTHY_ERROR_MARKER } from "../../src/contracts/execution.js";
import { createProjectExecuteRunner } from "../../src/scheduler/execute.js";
import {
	HARVEST_GATE_REASON,
	harvestDeliveredAfterSoftTimeout,
	makeHarvestGate,
} from "../../src/worker/agent.js";
import {
	addStep,
	createProject,
	scriptConnectionWithFaux,
	silentLogger,
	startExecutorTestServer,
	testConfig,
} from "./helpers.js";
import { WorkerInProcessLauncher } from "./worker-launcher.js";

const EXECUTION = "a0000000-0000-4000-8000-000000000001";

function submitResult(summary: string, unresolved: string[] = []) {
	return fauxAssistantMessage(
		[
			fauxToolCall("submit_result", {
				schema_version: 1,
				task_status: "satisfied",
				summary,
				unresolved,
			}),
		],
		{ stopReason: "toolUse" },
	);
}

test(
	"controller cancellation is persisted as cancelled rather than a lease failure",
	{ timeout: 30_000 },
	async () => {
		const { server, run } = await setup([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const running = run();
		await expect
			.poll(async () => (await server.client.getExecution(EXECUTION)).data?.status, {
				timeout: 10_000,
			})
			.toBe("running");
		const response = await fetch(`${server.url}/internal/executions/${EXECUTION}/cancel`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(response.ok).toBe(true);
		await running;
		const execution = await server.client.getExecution(EXECUTION);
		expect(execution.data?.status).toBe("cancelled");
		expect(execution.data?.error).toBeNull();
	},
);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type FauxResponses = Parameters<FauxProviderHandle["setResponses"]>[0];

interface Setup {
	server: Awaited<ReturnType<typeof startExecutorTestServer>>;
	faux: FauxProviderHandle;
	run: (executionId?: string) => Promise<{
		projectId: string;
		stepId: string;
		outcome: string;
		server: Awaited<ReturnType<typeof startExecutorTestServer>>;
	}>;
}

/** Execute 世界工具集：标准（含 read，收割拦 bash）或新建库的极简默认（仅持久 bash）。 */
type ExecuteToolset = { tools: string[]; bash_mode: "one-shot" | "persistent" };
const STANDARD_TOOLSET: ExecuteToolset = {
	tools: ["read", "bash", "edit", "write"],
	bash_mode: "one-shot",
};
const MINIMAL_TOOLSET: ExecuteToolset = { tools: ["bash"], bash_mode: "persistent" };

async function setup(
	responses: FauxResponses,
	timeouts?: { step_ms: number; harvest_ms: number; grace_ms: number },
	profile: ExecuteToolset = STANDARD_TOOLSET,
	projectOptions: Record<string, unknown> = {},
): Promise<Setup> {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	faux.setResponses(responses);
	const server = await startExecutorTestServer(
		{
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "sk-long-term-upstream-key",
		},
		timeouts ? { timeouts } : {},
	);
	// 新建库的 Execute 默认已改为极简（tools=["bash"] + persistent）。测试必须显式
	// 固定自己验证的工具集，否则会随默认值漂移——0843811 正是这样让两个用例变红的。
	server.control.store.saveProfile({ ...server.control.store.profile("execute"), ...profile });
	await scriptConnectionWithFaux(server.control, "imported-execute", faux);
	const launcher = new WorkerInProcessLauncher({
		controlUrl: server.url,
		logger: silentLogger,
	});
	const runner = createProjectExecuteRunner({
		config: testConfig(server.url),
		client: server.client,
		projectLauncher: launcher,
		logger: silentLogger,
	});
	const run = async (executionId = EXECUTION) => {
		const projectId = await createProject(server.client, projectOptions);
		const stepId = await addStep(server.client, projectId, { description: "find the flag" });
		const claim = await server.client.claimStep(projectId, stepId, executionId);
		if (!claim.ok) {
			throw new Error(`claim failed: ${claim.statusCode} ${claim.text}`);
		}
		const outcome = await runner(
			{
				client: server.client,
				projectId,
				stepId,
				worker: executionId,
			},
			new AbortController().signal,
		);
		return { projectId, stepId, outcome, server };
	};
	return { server, faux, run };
}

test(
	"worker executes a step: submits facts through the execution protocol and concludes",
	{ timeout: 60_000 },
	async () => {
		const { run, faux } = await setup([
			fauxAssistantMessage(
				[
					fauxToolCall("submit_fact", {
						confidence: "observed",
						description: "flag found at /root/flag.txt",
					}),
				],
				{
					stopReason: "toolUse",
				},
			),
			submitResult("The flag is ctfflag{hello}. Located at /root/flag.txt."),
		]);

		const { projectId, stepId, outcome, server } = await run();
		expect(outcome).toBe("success");
		const project = await inspectClientProject(server.client, projectId);
		const step = project.steps.find((s) => s.id === stepId)!;
		expect(step.status).toBe("concluded");
		expect(step.summary).toContain("ctfflag{hello}");
		expect(step.result?.produced.fact_ids).toHaveLength(1);
		expect(project.facts.some((f) => f.description.includes("flag found at /root/flag.txt"))).toBe(
			true,
		);
		// 事实与 execution 关联（提交身份经控制端校验）。
		const executionView = await server.client.getExecution(EXECUTION);
		expect(executionView.ok).toBe(true);
		expect(executionView.data?.status).toBe("succeeded");
		// 用量遥测经执行协议落库。
		expect(project.usage.execute.input_tokens).toBeGreaterThan(0);
		expect(faux.state.callCount).toBeGreaterThanOrEqual(2);
	},
);

test(
	"harvest gate: world tool calls during harvest are rejected without executing",
	{ timeout: 60_000 },
	async () => {
		const { run } = await setup([
			fauxAssistantMessage("exploration done"),
			// 收割 pass：模型违规尝试调用 bash。闸门应返回提示文本且不执行命令。
			// 命令输出（209458）不出现在命令文本里，可据此区分“请求过”与“执行过”。
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "echo $((104729 * 2))" }),
					fauxToolCall("submit_result", {
						schema_version: 1,
						task_status: "inconclusive",
						summary: "Harvest complete; no additional facts to submit.",
						unresolved: [],
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const { outcome, server: s } = await run("d0000000-0000-4000-8000-000000000004");
		expect(outcome).toBe("success");

		// 会话事件里能见到闸门返回的提示文本（工具结果已持久化）。
		const lines = (
			s.db
				.prepare("SELECT line FROM execution_events WHERE execution_id = ?")
				.all("d0000000-0000-4000-8000-000000000004") as Array<{ line: string }>
		).map((r) => r.line);
		expect(lines.some((l) => l.includes("收尾阶段"))).toBe(true);
		// 闸门是"框架级硬拦截"：模型收到的是 error 工具结果（MCP/模型侧看到的
		// 是失败而不是一句软提示），且 bash 从未进入工具实现。
		const gateResults = lines
			.map((line) => {
				try {
					return JSON.parse(line) as { message?: { role?: string; isError?: boolean } };
				} catch {
					return {};
				}
			})
			.filter(
				(ev) =>
					ev.message?.role === "toolResult" && JSON.stringify(ev.message).includes("收尾阶段"),
			);
		expect(gateResults.length).toBeGreaterThan(0);
		expect(gateResults.every((ev) => ev.message?.isError === true)).toBe(true);
		// bash 命令从未真正执行：其输出不存在于任何会话事件里。
		expect(lines.some((l) => l.includes("209458"))).toBe(false);
	},
);

test(
	"Finding schema reaches the real Worker model and validates its structured delivery",
	{ timeout: 60_000 },
	async () => {
		const schema = {
			type: "object",
			required: ["severity"],
			additionalProperties: false,
			properties: { severity: { type: "string", enum: ["high", "low"] } },
		};
		let inputText = "";
		let systemPrompt = "";
		const { run } = await setup(
			[
				(context: Context) => {
					const user = context.messages.find((message) => message.role === "user")!;
					const text =
						typeof user.content === "string"
							? user.content
							: user.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("");
					inputText = text;
					systemPrompt = getCurrentSystemPrompt(context.messages);
					return fauxAssistantMessage(
						[
							fauxToolCall("submit_finding", {
								title: "verified issue",
								description: "confirmed response",
								data_json: JSON.stringify({ severity: "high" }),
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
				submitResult("delivered finding"),
			],
			undefined,
			STANDARD_TOOLSET,
			{ finding_schema: schema },
		);
		const { projectId, server, outcome } = await run();
		expect(inputText).toContain(JSON.stringify(schema));
		expect(systemPrompt).not.toContain(JSON.stringify(schema));
		expect(outcome).toBe("success");
		expect((await inspectClientProject(server.client, projectId)).findings).toEqual([
			expect.objectContaining({ data: { severity: "high" } }),
		]);
	},
);

test(
	"finding errors reach the model and digest, then allow corrected delivery",
	{ timeout: 30_000 },
	async () => {
		const schema = {
			type: "object",
			required: ["verified"],
			properties: { verified: { const: true } },
		};
		const body = { title: "verified result", description: "confirmed observation" };
		const finding = (data_json?: string) =>
			fauxAssistantMessage(
				[
					fauxToolCall("submit_finding", {
						...body,
						...(data_json === undefined ? {} : { data_json }),
					}),
				],
				{ stopReason: "toolUse" },
			);
		const assertFailure = (context: Context) => {
			const result = context.messages.at(-1);
			expect(result?.role).toBe("toolResult");
			if (result?.role === "toolResult") expect(result.isError).toBe(true);
		};
		const { run } = await setup(
			[
				finding(),
				(context: Context) => {
					assertFailure(context);
					return finding("{}");
				},
				(context: Context) => {
					assertFailure(context);
					return finding('{"verified":true}');
				},
				submitResult("corrected structured delivery"),
			],
			undefined,
			STANDARD_TOOLSET,
			{ finding_schema: schema },
		);
		const { projectId, server, outcome } = await run();
		expect(outcome).toBe("success");
		expect((await inspectClientProject(server.client, projectId)).findings).toEqual([
			expect.objectContaining({ id: "r001", data: { verified: true } }),
		]);
		const response = await fetch(`${server.url}/projects/${projectId}/digest`, {
			headers: { Authorization: "Bearer test-token" },
		});
		const digest = (await response.json()) as ProjectDigest;
		expect(digest.summary.tool_errors).toBe(2);
		expect(digest.executions[0].tool_calls.map((call: { result: string }) => call.result)).toEqual([
			"error",
			"error",
			"ok",
			"ok",
		]);
	},
);

test.each([
	{ toolName: "plugin_mutate", profile: STANDARD_TOOLSET },
	{ toolName: "read", profile: MINIMAL_TOOLSET },
])(
	"plugin $toolName executes during exploration but cannot impersonate a harvest builtin",
	{ timeout: 60_000 },
	async ({ toolName, profile }) => {
		const { run, server } = await setup(
			[
				fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("exploration done"),
				fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" }),
				submitResult("harvest finished"),
			],
			undefined,
			profile,
		);
		const directory = path.join(server.dataRoot, "test-plugin");
		const sentinel = path.join(server.dataRoot, "plugin-executions.txt");
		mkdirSync(directory);
		const resources = { extensions: ["index.js"], skills: [] };
		const release = {
			role: "execute" as const,
			installation_id: "harvest-test",
			revision: 1,
			source: "./test",
			enabled: true,
			created_at: new Date().toISOString(),
			resources,
			packages: ["./test"],
			path: directory,
		};
		new PluginStore(server.db).setCurrent("execute", release);
		writeFileSync(path.join(directory, "plugin.json"), JSON.stringify(release));
		writeFileSync(
			path.join(directory, "index.js"),
			`
import { writeFileSync } from "node:fs";
export default function (pi) {
	let count = 0;
	pi.registerTool({
		name: ${JSON.stringify(toolName)}, label: "Plugin Mutate", description: "Changes the environment",
		parameters: { type: "object", properties: {} },
		async execute() {
			writeFileSync(${JSON.stringify(sentinel)}, String(++count));
			return { content: [{ type: "text", text: "mutation executed" }], details: {} };
		}
	});
}
`,
		);
		vi.stubEnv("CAIRN_EXECUTE_PLUGIN_DIR", directory);
		try {
			const { outcome } = await run();
			expect(outcome).toBe("success");
			expect(readFileSync(sentinel, "utf8")).toBe("1");
			const lines = server.db
				.prepare("SELECT line FROM execution_events WHERE execution_id=?")
				.all(EXECUTION) as Array<{ line: string }>;
			expect(
				lines
					.map(({ line }) => JSON.parse(line))
					.some(
						(entry) =>
							entry.message?.role === "toolResult" &&
							entry.message.toolName === toolName &&
							entry.message.isError === true &&
							JSON.stringify(entry.message.content).includes("收尾阶段"),
					),
			).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	},
);

test("harvest gate policy: read stays open, world mutators and target-container ops close", () => {
	const harvestToolGate = makeHarvestGate();
	// 只读放行：收割时常要回看一眼文件里的哈希/凭据，拦住它只会少交事实。
	expect(harvestToolGate("read")).toBeUndefined();
	expect(harvestToolGate("search_execution_events")).toBeUndefined();
	expect(harvestToolGate("benchmark_status")).toBeUndefined();
	expect(harvestToolGate("benchmark_submit_flag")).toBeUndefined();
	expect(harvestToolGate("benchmark_hint")).toBe(HARVEST_GATE_REASON);
	// 会产生世界动作的：世界工具与共享靶机重建。
	for (const name of ["bash", "edit", "write", "benchmark_reset"]) {
		expect(harvestToolGate(name)).toBe(HARVEST_GATE_REASON);
	}
	for (const name of ["plugin_scan", "plugin_mutate", "plugin_read", "future_tool"])
		expect(harvestToolGate(name)).toBe(HARVEST_GATE_REASON);
	for (const name of [
		"submit_fact",
		"submit_finding",
		"submit_result",
		"signal_planner",
		"get_execution_trace",
	])
		expect(harvestToolGate(name)).toBeUndefined();
	// 单世界工具模式（会话没有 read）：bash 是唯一的回看手段，必须放行。
	const bashOnlyGate = makeHarvestGate({ allowBash: true });
	expect(bashOnlyGate("bash")).toBeUndefined();
	expect(bashOnlyGate("edit")).toBe(HARVEST_GATE_REASON);
	expect(bashOnlyGate("plugin_mutate")).toBe(HARVEST_GATE_REASON);
	const minimalBuiltins = makeHarvestGate({
		allowBash: true,
		builtinToolNames: ["bash", "submit_result"],
	});
	expect(minimalBuiltins("read")).toBe(HARVEST_GATE_REASON);
	expect(minimalBuiltins("benchmark_status")).toBe(HARVEST_GATE_REASON);
});

test("soft timeout verdict: only a delivered harvest result completes the execution", () => {
	// 软超时 + 收割已提交结构化结果 = 完整交付：必须 conclude，否则步骤回到 open
	// 被反复重派（线上 s031 因此被跑了三次）。
	expect(harvestDeliveredAfterSoftTimeout(true, true)).toBe(true);
	// 超时但没拿到结果：仍以探索结论为准，允许重试。
	expect(harvestDeliveredAfterSoftTimeout(true, false)).toBe(false);
	// 外部取消（项目停止 / 租约丢失 / 人工停止）不带 timedOut，不能当成成功交付。
	expect(harvestDeliveredAfterSoftTimeout(undefined, true)).toBe(false);
});

test(
	"worker session transcript is persisted via the events protocol",
	{ timeout: 60_000 },
	async () => {
		const { run } = await setup([
			fauxAssistantMessage("exploration done"),
			submitResult("harvest done"),
		]);
		const { outcome, server: s } = await run("b0000000-0000-4000-8000-000000000002");
		expect(outcome).toBe("success");
		// execution_events 里已有会话行（幂等追加）。
		const rows = (s.db.prepare("SELECT COUNT(*) AS n FROM execution_events").get() as { n: number })
			.n;
		expect(rows).toBeGreaterThan(0);
	},
);

test(
	"timeout: the run is stopped at a turn boundary and the harvest pass takes over",
	{ timeout: 60_000 },
	async () => {
		const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
		let sawSteer = false;
		let sawHarvest = false;
		faux.setResponses(
			Array.from({ length: 64 }, () => async (context: Context) => {
				await sleep(20);
				const userText = JSON.stringify(context.messages.filter((m) => m.role === "user"));
				if (userText.includes("现在是收尾阶段")) {
					// 收割 pass：世界工具已关，提交结构化结果收尾。
					sawHarvest = true;
					return submitResult("Harvest: nothing left to submit.");
				}
				if (userText.includes("已达到时间上限")) {
					sawSteer = true;
				}
				return fauxAssistantMessage([fauxToolCall("search_execution_events", { query: "x" })], {
					stopReason: "toolUse",
				});
			}),
		);
		const server = await startExecutorTestServer(
			{ api: "openai-completions", base_url: "http://unused", api_key: "k" },
			{ timeouts: { step_ms: 1_000, harvest_ms: 30_000, grace_ms: 2_000 } },
		);
		await scriptConnectionWithFaux(server.control, "imported-execute", faux);
		const launcher = new WorkerInProcessLauncher({
			controlUrl: server.url,
			logger: silentLogger,
		});
		const runner = createProjectExecuteRunner({
			config: testConfig(server.url),
			client: server.client,
			projectLauncher: launcher,
			logger: silentLogger,
		});
		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId);
		await server.client.claimStep(projectId, stepId, "d0000000-0000-4000-8000-000000000004");
		const outcome = await runner(
			{
				client: server.client,
				projectId,
				stepId,
				worker: "d0000000-0000-4000-8000-000000000004",
			},
			new AbortController().signal,
		);
		expect(outcome).toBe("success");
		// 到点强停：不再依赖 steer 被模型采纳（steer 只在不支持强停的替身上兜底）。
		expect(sawSteer).toBe(false);
		// 探索被预算截断后，收割 pass 接手收尾 —— 事实与总结仍在同一条链上。
		expect(sawHarvest).toBe(true);
		const after = await inspectClientProject(server.client, projectId);
		expect(after.steps.find((s) => s.id === stepId)?.status).toBe("concluded");
	},
);

test(
	"soft timeout: a harvest-delivered result still concludes the step instead of being retried",
	{ timeout: 90_000 },
	async () => {
		// 复刻线上 s031 的时序：探索回合在软截止到点后未能在宽限期内收尾，被强停
		// （explore 报 cancelled + timedOut），随后收割 pass 提交结构化结果。
		// 旧行为用探索的 cancelled 覆盖了这次交付：execution_results 有行、步骤却不
		// concluded，lease 释放后步骤回到 open 被反复重派（s031 因此被跑了三次）。
		//
		// 宽限期由 CAIRN_GRACE_SECONDS 决定（测试脚手架的 timeouts.grace_ms 不生效），
		// 这里压到 1s：探索的首个回合卡在 `sleep 30` 上，到点强停后宽限期耗尽 →
		// 强停（杀掉工具进程）→ explore 报 cancelled + timedOut。
		const previousGrace = process.env.CAIRN_GRACE_SECONDS;
		process.env.CAIRN_GRACE_SECONDS = "1";
		const startedAt = Date.now();
		try {
			const { run, server } = await setup(
				[
					fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
						stopReason: "toolUse",
					}),
					submitResult("harvest salvaged after soft timeout"),
				],
				{ step_ms: 1_000, harvest_ms: 30_000, grace_ms: 1_000 },
			);
			const { projectId, stepId, outcome } = await run();

			expect(outcome).toBe("success");
			// 判别式：整轮必须远早于 `sleep 30` 的自然结束 —— 否则说明强停没发生，
			// 这条用例就没有真正覆盖 timedOut 分支。
			expect(Date.now() - startedAt).toBeLessThan(10_000);
			const row = server.db
				.prepare("SELECT status, result_outcome, summary FROM executions WHERE id = ?")
				.get(EXECUTION) as { status: string; result_outcome: string; summary: string };
			expect(row.status).toBe("succeeded");
			expect(row.result_outcome).toBe("succeeded");
			expect(row.summary).toContain("harvest salvaged after soft timeout");
			// 步骤必须真正收尾：控制端只对 succeeded 调 concludeStep，未收尾的步骤会被
			// 调度器重新认领，这正是重复执行的来源。
			const after = await inspectClientProject(server.client, projectId);
			expect(after.steps.find((s) => s.id === stepId)?.status).toBe("concluded");
			// 结构化结果落库且可被 Decide 读取。
			const committed = server.db
				.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE execution_id = ?")
				.get(EXECUTION) as { n: number };
			expect(committed.n).toBe(1);
		} finally {
			if (previousGrace === undefined) delete process.env.CAIRN_GRACE_SECONDS;
			else process.env.CAIRN_GRACE_SECONDS = previousGrace;
		}
	},
);

test(
	"launch failure: execution is failed, no container state is left behind",
	{ timeout: 60_000 },
	async () => {
		const server = await startExecutorTestServer({
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "k",
		});
		const launcher = new WorkerInProcessLauncher({ controlUrl: server.url, failStart: true });
		const runner = createProjectExecuteRunner({
			config: testConfig(server.url),
			client: server.client,
			projectLauncher: launcher,
			logger: silentLogger,
		});
		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId);
		const eid = "e0000000-0000-4000-8000-000000000005";
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
		expect(outcome).toBe("failed");
		const view = await server.client.getExecution(eid);
		expect(view.data?.status).toBe("failed");
		expect(view.data?.error).toContain("failed to create worker container");
		// 失败尝试没有可用的执行令牌：终态执行身份的心跳被拒绝。
		const client2 = new (await import("../../src/worker/client.js")).WorkerClient(
			server.url,
			eid,
			"deadbeef",
		);
		const heartbeat = await client2.heartbeat();
		expect(heartbeat.ok).toBe(false);
	},
);

test(
	"worker exits without reporting: controller marks the execution lost (no auto-retry)",
	{ timeout: 60_000 },
	async () => {
		const server = await startExecutorTestServer(
			{ api: "openai-completions", base_url: "http://unused", api_key: "k" },
			{ timeouts: { step_ms: 5_000, harvest_ms: 5_000, grace_ms: 2_000 } },
		);
		const launcher = new WorkerInProcessLauncher({
			controlUrl: server.url,
			exitWithoutResult: true,
		});
		const runner = createProjectExecuteRunner({
			config: testConfig(server.url),
			client: server.client,
			projectLauncher: launcher,
			logger: silentLogger,
		});
		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId);
		const eid = "f0000000-0000-4000-8000-000000000006";
		await server.client.claimStep(projectId, stepId, eid);
		const running = runner(
			{
				client: server.client,
				projectId,
				stepId,
				worker: eid,
			},
			new AbortController().signal,
		);
		// 等容器内的 worker 领取任务（崩溃模拟发生在领取之后）。
		await expect
			.poll(async () => (await server.client.getExecution(eid)).data?.status, {
				timeout: 10_000,
			})
			.toBe("running");
		// 项目模式下 runner 不探测容器退出：失联执行由控制端 reaper 按
		// deadline 判 lost（DispatcherLoop 每轮 reapExecutions）。
		server.db
			.prepare("UPDATE executions SET deadline_at = '2020-01-01T00:00:00Z' WHERE id = ?")
			.run(eid);
		expect((await server.client.reapExecutions()).data?.reaped).toBe(1);
		expect(await running).toBe("failed");
		const view = await server.client.getExecution(eid);
		expect(view.data?.status).toBe("lost");
		// 失联 ≠ 未执行：原 Step 关闭为 abandoned，交回 Decide 重新规划。
		const after = await inspectClientProject(server.client, projectId);
		expect(after.steps.find((s) => s.id === stepId)?.status).toBe("abandoned");
		expect((await server.client.reapExecutions()).data?.reaped).toBe(0);
	},
);

test(
	"permanent configuration error is reported failed without the unhealthy marker",
	{ timeout: 60_000 },
	async () => {
		const server = await startExecutorTestServer({
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "sk-long-term-upstream-key",
		});
		// 模拟升级前写入数据库的旧模板：绕过 saveProfile 的渲染校验，让运行期
		// renderPrompt 撞上无法解析的占位符（永久配置错误，重试也不会成功）。
		const profile = server.control.store.profile("execute");
		server.control.store.put("agent", "execute", {
			...profile,
			prompt: "执行 {unresolvable_placeholder}",
			revision: profile.revision + 1,
		});
		const launcher = new WorkerInProcessLauncher({ controlUrl: server.url, logger: silentLogger });
		const runner = createProjectExecuteRunner({
			config: testConfig(server.url),
			client: server.client,
			projectLauncher: launcher,
			logger: silentLogger,
		});
		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId, { description: "find the flag" });
		const eid = "a0000000-0000-4000-8000-0000000000c7";
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

		// 配置错误必须按普通 failed 上报：execution 状态仍是 failed，但绝不能
		// 带 UNHEALTHY_ERROR_MARKER —— 否则 DispatcherLoop 会把健康端点当作
		// 故障反复冷却，且真实原因（模板/控制面）被标记掩盖。
		expect(outcome).toBe("failed");
		const view = await server.client.getExecution(eid);
		expect(view.data?.status).toBe("failed");
		expect(view.data?.error).toContain(
			"unresolved prompt placeholder(s): unresolvable_placeholder",
		);
		expect(view.data?.error ?? "").not.toContain(UNHEALTHY_ERROR_MARKER);
	},
);

test(
	"budget exhaustion: harvest pass keeps its budget and salvages facts instead of a silent failure",
	{ timeout: 120_000 },
	async () => {
		// 探索 pass 的响应队列：第 1 回合是跨过 step_ms(2s) 的长命令（全程不产文本）；
		// 其后两个空回合消费 33%/67% 两个 checkpoint steer 驱动的 continue 循环。
		// 到点 requestStop 在回合边界截停，探索以 budgetExhausted 结束、无文本。
		const { run } = await setup(
			[
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 3" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(""),
				fauxAssistantMessage(""),
				// 收割 pass 第 1 回合：search_execution_events 放行、bash 被闸门拦下
				// （与线上真实超时轨迹的最后一个回合一致）。旧行为下 stopRequested
				// 闩锁在这里直接掐死收割 —— 事实与总结全部丢失，执行以 failed 收场。
				fauxAssistantMessage(
					[
						fauxToolCall("search_execution_events", { query: "x" }),
						fauxToolCall("bash", { command: "echo blocked" }),
					],
					{ stopReason: "toolUse" },
				),
				// 收割 pass 第 2 回合：看到 bash 被拦后改口补交事实。
				fauxAssistantMessage(
					[
						fauxToolCall("submit_fact", {
							description: "budget salvaged fact",
							confidence: "observed",
						}),
					],
					{ stopReason: "toolUse" },
				),
				// 收割 pass 第 3 回合：提交结构化结果，正常收尾。
				submitResult("harvest summary done"),
			],
			{ step_ms: 2_000, harvest_ms: 30_000, grace_ms: 5_000 },
		);
		const { projectId, outcome, server: s } = await run();
		expect(outcome).toBe("success");
		// 抢救的事实真的落库了。
		const facts = s.db
			.prepare("SELECT COUNT(*) AS n FROM facts WHERE project_id = ?")
			.get(projectId) as { n: number };
		expect(facts.n).toBeGreaterThan(0);
		// 执行不再以无声的 failed 收场。
		const row = s.db
			.prepare("SELECT status, summary FROM executions WHERE id = ?")
			.get(EXECUTION) as { status: string; summary: string };
		expect(row.status).toBe("succeeded");
		expect(row.summary).toContain("harvest summary done");
	},
);

test(
	"a run that ends without submit_result degrades to an inconclusive delivery instead of failing",
	{ timeout: 60_000 },
	async () => {
		const { run, server } = await setup([fauxAssistantMessage(""), fauxAssistantMessage("")]);
		const { projectId } = await run();
		const row = server.db
			.prepare("SELECT status, error FROM executions WHERE id = ?")
			.get(EXECUTION) as { status: string; error: string | null };
		// 模型正常收尾、只是没交结构化结果：这是一次「未声明验收结论」的交付，
		// 不是执行失败。判失败会让调度器重派整步去重新发现图上已有的事实。
		expect(row.status).toBe("succeeded");
		// 降级原因仍然可见，不能是 status=succeeded / error=NULL 的无声记录。
		expect(row.error).toContain("structured result was not submitted");
		const payload = JSON.parse(
			(
				server.db
					.prepare("SELECT payload FROM execution_results WHERE execution_id = ?")
					.get(EXECUTION) as { payload: string }
			).payload,
		);
		expect(payload.task_status).toBe("inconclusive");
		// 空摘要会让服务端 schema 拒绝整次交付，因此必须有兜底文本。
		expect(payload.summary).toContain("没有提交结构化结果");
		expect(payload.unresolved[0]).toContain("没有声明验收结论");
		// 步骤按一次完整交付收尾，交回 Decide 重新规划。
		const step = server.db
			.prepare("SELECT status FROM steps WHERE project_id = ?")
			.get(projectId) as { status: string };
		expect(step.status).toBe("concluded");
	},
);

test(
	"facts submitted without a structured result survive as an inconclusive delivery",
	{ timeout: 60_000 },
	async () => {
		const { run, server } = await setup([
			// 探索：提交一条事实，然后模型自己结束回合 —— 从不调用 submit_result。
			fauxAssistantMessage(
				[fauxToolCall("submit_fact", { confidence: "observed", description: "port 8080 is open" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("target explored"),
			// 收割同样没有交出结构化结果。
			fauxAssistantMessage(""),
		]);
		const { projectId } = await run();
		const row = server.db
			.prepare("SELECT status, summary FROM executions WHERE id = ?")
			.get(EXECUTION) as { status: string; summary: string };
		expect(row.status).toBe("succeeded");
		// 事实是实时落库的：降级交付保留它，重派整个步骤只会重新发现同一条。
		const facts = server.db
			.prepare("SELECT COUNT(*) AS n FROM facts WHERE project_id = ? AND execution_id = ?")
			.get(projectId, EXECUTION) as { n: number };
		expect(facts.n).toBe(1);
		const payload = JSON.parse(
			(
				server.db
					.prepare("SELECT payload FROM execution_results WHERE execution_id = ?")
					.get(EXECUTION) as { payload: string }
			).payload,
		);
		expect(payload.task_status).toBe("inconclusive");
		// 摘要取最终文本而不是空串，否则服务端 schema 会拒绝这次交付。
		expect(row.summary).toBe("target explored");
	},
);

test(
	"minimal persistent-bash mode (new DB default) persists cancellation as cancelled",
	{ timeout: 45_000 },
	async () => {
		const { server, run } = await setup(
			[
				// 极简持久 bash 下 bash sleep 不再占住回合，因此用连续快回合把执行
				// 保持在 running，取消才有可中断的目标（与取消语义本身无关）。
				// 回合数必须远多于"取消被心跳观察到"所需的时间：整套测试并行跑时，
				// 轮询与心跳都会变慢，回合太少会在取消到达前耗尽而误判为 unhealthy。
				...Array.from({ length: 200 }, () => async () => {
					await sleep(120);
					return fauxAssistantMessage([fauxToolCall("search_execution_events", { query: "x" })], {
						stopReason: "toolUse",
					});
				}),
			],
			undefined,
			MINIMAL_TOOLSET,
		);
		// 取消语义与工具集无关，这里只验证"默认极简模式取消后终态仍是 cancelled"。
		// 把租约 TTL 调小，心跳间隔从 10s 降到 2s，免得为等心跳付 10 秒。
		server.db.prepare("UPDATE settings SET lease_timeout = 4 WHERE rowid = 1").run();
		const running = run();
		await expect
			.poll(async () => (await server.client.getExecution(EXECUTION)).data?.status, {
				timeout: 10_000,
			})
			.toBe("running");
		const response = await fetch(server.url + "/internal/executions/" + EXECUTION + "/cancel", {
			method: "POST",
			headers: { Authorization: "Bearer test-token" },
		});
		expect(response.ok).toBe(true);
		await running;
		const execution = await server.client.getExecution(EXECUTION);
		expect(execution.data?.status).toBe("cancelled");
		expect(execution.data?.error).toBeNull();
	},
);

test(
	"minimal persistent-bash mode (new DB default) completes through the harvest pass",
	{ timeout: 60_000 },
	async () => {
		const { run } = await setup(
			[
				// 探索正常收尾但没有结构化结果 → 收割 pass 接手。极简模式下收割放行
				// bash（无 read 可用），这里验证事实与结果仍能正常落库。
				fauxAssistantMessage("exploration done"),
				fauxAssistantMessage(
					[
						fauxToolCall("submit_fact", {
							description: "minimal salvaged fact",
							confidence: "observed",
						}),
					],
					{ stopReason: "toolUse" },
				),
				submitResult("minimal harvest summary"),
			],
			undefined,
			MINIMAL_TOOLSET,
		);
		const { projectId, outcome, server: s } = await run();
		expect(outcome).toBe("success");
		const facts = s.db
			.prepare("SELECT COUNT(*) AS n FROM facts WHERE project_id = ?")
			.get(projectId) as { n: number };
		expect(facts.n).toBeGreaterThan(0);
		const row = s.db
			.prepare("SELECT status, summary FROM executions WHERE id = ?")
			.get(EXECUTION) as { status: string; summary: string };
		expect(row.status).toBe("succeeded");
		expect(row.summary).toContain("minimal harvest summary");
	},
);
