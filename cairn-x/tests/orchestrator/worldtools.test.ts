/**
 * 世界工具的 bash 超时注入。
 *
 * 收割阶段的"关闭世界动作"已不在这一层：它由会话层的 beforeToolCall 硬闸门
 * 统一处理（见 worker-run.test.ts 的 gate 用例与 control/session.ts）。
 */

import { expect, test } from "vitest";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createLocalWorldTools, withBashTimeout } from "../../src/worker/worldtools.js";

function fakeTool(run: () => void): AgentTool {
	return {
		name: "bash",
		label: "Bash",
		description: "fake",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			run();
			return { content: [{ type: "text", text: "executed" }], details: {} };
		},
	} as AgentTool;
}

// PI 的 bash 把 timeout 设为可选且无默认值；不注入就会出现"单条命令卡死整个
// agent loop"，软预算与进度提醒都在回合边界、永远不触发，只能等控制端硬杀。

function capturingTool(): { tool: AgentTool; seen: () => Record<string, unknown> } {
	let seen: Record<string, unknown> = {};
	const tool = fakeTool(() => {});
	tool.execute = async (_id, params) => {
		seen = params as Record<string, unknown>;
		return { content: [{ type: "text", text: "executed" }], details: {} };
	};
	return { tool, seen: () => seen };
}

test("bash timeout: injects the default when the model omits it", async () => {
	const { tool, seen } = capturingTool();
	const wrapped = withBashTimeout(tool, 300);
	await wrapped.execute("t1", { command: "nmap -p- target" }, undefined, undefined);
	expect(seen().timeout).toBe(300);
	expect(seen().command).toBe("nmap -p- target");
});

test("bash timeout: uses the configured default as-is", async () => {
	const { tool, seen } = capturingTool();
	const wrapped = withBashTimeout(tool, 600);
	await wrapped.execute("t1", { command: "x" }, undefined, undefined);
	expect(seen().timeout).toBe(600);
});

test("bash timeout: preserves an explicit timeout as-is", async () => {
	const { tool, seen } = capturingTool();
	const wrapped = withBashTimeout(tool, 300);
	await wrapped.execute("t1", { command: "x", timeout: 9999 }, undefined, undefined);
	expect(seen().timeout).toBe(9999);
	await wrapped.execute("t2", { command: "x", timeout: 45 }, undefined, undefined);
	expect(seen().timeout).toBe(45);
	// 非法值（0 / 负数 / 非数字）一律回落到默认值。
	await wrapped.execute("t3", { command: "x", timeout: 0 }, undefined, undefined);
	expect(seen().timeout).toBe(300);
});

test("bash timeout: the tool description carries the policy to the model", () => {
	const wrapped = withBashTimeout(
		fakeTool(() => {}),
		300,
	);
	expect(wrapped.description).toContain("an explicit timeout overrides the default");
});

test("bash timeout: reports how long the command took in the result", async () => {
	const { tool } = capturingTool();
	const wrapped = withBashTimeout(tool, 300);
	const result = (await wrapped.execute("t1", { command: "x" }, undefined, undefined)) as {
		content: { type: string; text?: string }[];
	};
	// 耗时是模型判断「这个动作有多贵」的唯一样本：PI 自带的 bash 不报它，
	// 缺了就只能凭感觉选字典与扫描范围。persistent 模式由 persistentbash 拼同款标记。
	expect(result.content.at(-1)?.text).toMatch(/\[Command finished in \d+\.\d+s\]$/);
});

test("bash timeout: non-text results are left untouched", async () => {
	const image = { type: "image" as const, data: "...", mimeType: "image/png" };
	const tool = fakeTool(() => {});
	tool.execute = async () => ({ content: [image], details: {} });
	const result = (await withBashTimeout(tool, 300).execute(
		"t1",
		{ command: "x" },
		undefined,
		undefined,
	)) as { content: unknown[] };
	expect(result.content).toEqual([image]);
});

test("createLocalWorldTools: 按 toolNames 过滤并支持持久 bash", async () => {
	const oneShot = await createLocalWorldTools({
		workspaceDir: process.cwd(),
		toolNames: ["read", "bash"],
	});
	expect(oneShot.tools.map((t) => t.name)).toEqual(["read", "bash"]);
	await oneShot.dispose();

	const minimal = await createLocalWorldTools({
		workspaceDir: process.cwd(),
		toolNames: ["bash"],
		bashMode: "persistent",
	});
	expect(minimal.tools.map((t) => t.name)).toEqual(["bash"]);
	expect(minimal.tools[0]?.description).toContain("persists across calls for this agent");
	// persistent 模式与 one-shot 一样，必须把超时策略告诉模型。
	expect(minimal.tools[0]?.description).toContain("killed after 300s");
	expect(minimal.tools[0]?.description).toContain("an explicit timeout overrides the default");
	await minimal.dispose();
});

test("createLocalWorldTools: 重复的持久 bash 只创建一个会话", async () => {
	const tools = await createLocalWorldTools({
		workspaceDir: process.cwd(),
		toolNames: ["bash", "bash"],
		bashMode: "persistent",
	});
	expect(tools.tools.map((tool) => tool.name)).toEqual(["bash"]);
	await tools.dispose();
});
