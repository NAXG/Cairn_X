import { inspectClientProject } from "../support/project-state.js";
/**
 * Decide runner 测试：仅使用图管理工具的图管理 activity。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	fauxAssistantMessage,
	fauxToolCall,
	fauxProvider,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";

import { createDecideRunner } from "../../src/agents/decide/runner.js";
import { backfillDecideUsage, transcriptUsage } from "../../src/server/core/usage-backfill.js";
import type { DecideContext } from "../../src/scheduler/types.js";
import {
	createProject,
	scriptConnectionWithFaux,
	silentLogger,
	startExecutorTestServer,
} from "./helpers.js";

const WORKER = "decide:mock-decide";

const dataRoots: string[] = [];

afterEach(() => {
	for (const dir of dataRoots.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * 所有用例共享的准备动作：装好 faux 模型的执行服务器 + 已认领 Decide 租约的
 * 项目 + 隔离 dataRoot（afterEach 统一清理）+ 就绪的 runner 与 ctx。
 */
async function setupDecideRunner(
	faux: Parameters<typeof scriptConnectionWithFaux>[2],
	options: { trigger?: string; decideTimeoutSeconds?: number } = {},
) {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "test",
	});
	if (options.decideTimeoutSeconds !== undefined) {
		// 把 decide 租约 TTL 调到下限，使心跳间隔缩到 2s，测试才能在秒级复现租约回收。
		const updated = server.db
			.prepare("UPDATE settings SET decide_timeout = ? WHERE rowid = 1")
			.run(options.decideTimeoutSeconds);
		expect(updated.changes).toBe(1);
	}
	await scriptConnectionWithFaux(server.control, "imported-decide", faux);
	const client = server.client;
	const projectId = await createProject(client);
	const claim = await client.claimDecide(projectId, WORKER);
	expect(claim.ok).toBe(true);
	const dataRoot = mkdtempSync(path.join(tmpdir(), "cairn-x-decide-"));
	dataRoots.push(dataRoot);
	const runner = createDecideRunner({ client, logger: silentLogger, dataRoot });
	const ctx: DecideContext = {
		client,
		projectId,
		projectTitle: claim.data!.title,
		trigger: options.trigger ?? "initial_run",
		planningVersion: 0,
		worker: WORKER,
	};
	return { server, client, projectId, dataRoot, runner, ctx };
}

test("adjusts the graph through its tools and records decide usage", async () => {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("get_graph", { view: "planning" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			[fauxToolCall("add_step", { from: ["origin"], description: "probe the service" })],
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage("Graph adjusted."),
	]);

	const { server, client, projectId, dataRoot, runner, ctx } = await setupDecideRunner(faux, {
		trigger: "fact_added:1->2",
	});
	const outcome = await runner(ctx, new AbortController().signal);

	expect(outcome).toBe("success");
	const after = await inspectClientProject(client, projectId);
	const created = after.steps.find((s) => s.description === "probe the service");
	expect(created).toBeDefined();
	expect(created!.creator).toBe(WORKER);
	expect(after.usage.decide.input_tokens).toBeGreaterThan(0);
	// 用量带上产生它的会话轨迹文件名：控制端据此做幂等，也据此在丢账时补账。
	const flushed = server.db
		.prepare("SELECT * FROM usage_events WHERE project_id = ? AND activity = 'decide'")
		.get(projectId) as { source_file: string; input_tokens: number };
	expect(flushed.source_file).toMatch(/^decide-.*\.jsonl$/);
	expect(existsSync(path.join(dataRoot, projectId, "sessions", flushed.source_file))).toBe(true);
	expect(flushed.input_tokens).toBe(after.usage.decide.input_tokens);
});

test("a decide round whose usage report fails is recovered from its session file", async () => {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("get_graph", { view: "planning" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Graph adjusted."),
	]);

	const { server, client, projectId, dataRoot, runner, ctx } = await setupDecideRunner(faux);

	// 运行结束时的那次上报失败（真实事故里是控制面瞬时不可达：status=0 fetch failed）。
	client.recordUsage = async () => ({
		statusCode: 0,
		ok: false,
		data: undefined,
		text: "fetch failed",
	});

	const outcome = await runner(ctx, new AbortController().signal);
	expect(outcome).toBe("success");
	const lost = server.db
		.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE project_id = ?")
		.get(projectId) as { n: number };
	expect(lost.n).toBe(0);

	// 控制端按轨迹补账（真实部署里由 complete/release/启动扫描触发）。
	expect(backfillDecideUsage(server.db, projectId, dataRoot)).toBe(1);
	const recovered = server.db
		.prepare("SELECT * FROM usage_events WHERE project_id = ?")
		.get(projectId) as { source_file: string; input_tokens: number; output_tokens: number };
	const lines = readFileSync(
		path.join(dataRoot, projectId, "sessions", recovered.source_file),
		"utf8",
	).split("\n");
	const expected = lines
		.filter((line) => line.includes('"usage"'))
		.map((line) => transcriptUsage(line))
		.filter((usage) => usage !== null)
		.reduce(
			(total, usage) => ({
				input: total.input + usage.input,
				output: total.output + usage.output,
			}),
			{ input: 0, output: 0 },
		);
	expect(recovered.input_tokens).toBe(expected.input);
	expect(recovered.output_tokens).toBe(expected.output);
	expect(recovered.input_tokens).toBeGreaterThan(0);
	// 幂等：再补一次不会重复计数。
	expect(backfillDecideUsage(server.db, projectId, dataRoot)).toBe(0);
});

test("sub goals can be created and the root goal achieved to complete the project", async () => {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("get_graph", { view: "planning" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("goal", { action: "add", description: "stage one done" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			[
				fauxToolCall("goal", {
					action: "achieve",
					goal_id: "g001",
					from: [{ type: "fact", id: "origin" }],
					description: "stage done",
				}),
				fauxToolCall("goal", {
					action: "achieve",
					goal_id: "goal",
					from: [{ type: "fact", id: "origin" }],
					description: "the origin fact already satisfies the root goal",
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Done."),
	]);

	const { client, projectId, runner, ctx } = await setupDecideRunner(faux);
	const outcome = await runner(ctx, new AbortController().signal);

	expect(outcome).toBe("success");
	const after = await inspectClientProject(client, projectId);
	expect(after.project.status).toBe("completed");
	expect(after.goals.some((g) => g.id !== "goal" && g.description === "stage one done")).toBe(true);
});

test("LLM endpoint error: returns unhealthy", async () => {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	faux.setResponses([
		fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "upstream exploded" }),
	]);
	const { runner, ctx } = await setupDecideRunner(faux);
	const outcome = await runner(ctx, new AbortController().signal);
	expect(outcome).toBe("unhealthy");
});

/**
 * 系统提示词与具体项目无关（origin/goal/步骤清单都走 get_graph），
 * 首条用户消息只带项目名与触发原因，跨项目复用同一段缓存前缀。
 */
test("project identity stays out of the system prompt; the rest is read via get_graph", async () => {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	let systemPrompt = "";
	let firstUserMessage = "";
	faux.setResponses([
		async (context: TranscriptContext) => {
			// 0.86 起 provider 只拿到 TranscriptContext：提示词从 system 消息里取。
			systemPrompt = getCurrentSystemPrompt(context.messages);
			const firstUser = context.messages.find((message) => message.role === "user");
			firstUserMessage = JSON.stringify(firstUser?.content ?? "");
			return fauxAssistantMessage("Graph adjusted.");
		},
	]);

	const { runner, ctx } = await setupDecideRunner(faux);
	const outcome = await runner(ctx, new AbortController().signal);

	expect(outcome).toBe("success");
	expect(firstUserMessage).toContain("项目：test");
	expect(firstUserMessage).toContain("调度触发");
	expect(firstUserMessage).toContain("调用 get_graph");
	expect(firstUserMessage).not.toContain("起点（Origin）");
	expect(firstUserMessage).not.toContain("目标（Goal）");
	expect(firstUserMessage).not.toContain("认领时");
	expect(systemPrompt).toContain("FGS 图谱");
	expect(systemPrompt).not.toContain("starting point");
	expect(systemPrompt).not.toContain("finish the thing");
});

/**
 * 回归：Decide 自己达成根目标后，服务端会回收它的租约（心跳 403），这是正常
 * 收尾而不是规划失败。旧实现把 lease.failure 一律判为 failed，产生误导日志并
 * 跳过端点冷却清理。
 */
test("a decide that completes the project is not reported as a lease failure", async () => {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("get_graph", { view: "planning" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			[
				fauxToolCall("goal", {
					action: "achieve",
					goal_id: "goal",
					from: [{ type: "fact", id: "origin" }],
					description: "the origin fact satisfies the root goal",
				}),
			],
			{ stopReason: "toolUse" },
		),
		// 项目此时已被达成；停 3s 让心跳（间隔 2s）在租约被回收后再打一次。
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			return fauxAssistantMessage("Done.");
		},
	]);

	const { client, projectId, runner, ctx } = await setupDecideRunner(faux, {
		decideTimeoutSeconds: 5,
	});

	const detail = vi
		.spyOn(client, "getProjectOverview")
		.mockRejectedValue(new Error("full project read forbidden"));
	const state = vi.spyOn(client, "getSchedulingProjectState");
	const outcome = await runner(ctx, new AbortController().signal);

	expect(outcome).toBe("success");
	expect(detail).not.toHaveBeenCalled();
	expect(state).toHaveBeenCalledWith(projectId);
	detail.mockRestore();
	expect((await inspectClientProject(client, projectId)).project.status).toBe("completed");
}, 20_000);
