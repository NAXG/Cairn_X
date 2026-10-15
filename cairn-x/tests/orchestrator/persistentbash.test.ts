/**
 * 持久 bash 工具：哨兵协议、状态保留与重置语义。
 *
 * 传输层是 node-pty 硬依赖（无管道兜底）：能分配 PTY 的宿主跑完整集成用例，
 * 不能的（例如受限沙箱）只跑纯解析用例，集成用例显式跳过。
 */

import { expect, onTestFinished, test } from "vitest";

import { canAllocatePty } from "../../src/worker/bashsession.js";
import {
	commandMarker,
	commandOutput,
	createPersistentBashTool,
	maybeTruncate,
	PERSISTENT_BASH_DESCRIPTION,
	RetainedTextBuffer,
	wrapCommand,
} from "../../src/worker/persistentbash.js";

type ToolResult = { content: { type: string; text?: string }[] };

function textOf(result: ToolResult): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

const ptyAvailable = await canAllocatePty();
const shellTest = test.skipIf(!ptyAvailable);
// stdin 探测读 Linux /proc，其它平台恒 false（保持原有超时行为）。
const linuxShellTest = test.skipIf(!ptyAvailable || process.platform !== "linux");

test("commandOutput: 切出输出与退出码", () => {
	const marker = { start: "__S__", end: "__E__:" };
	expect(commandOutput("__S__\nhello\nworld\n__E__:0\n", marker)).toEqual({
		text: "hello\nworld",
		incomplete: false,
		exitCode: 0,
	});
});

test("commandOutput: 结束标记未出现时返回 undefined", () => {
	const marker = { start: "__S__", end: "__E__:" };
	expect(commandOutput("still running", marker)).toBeUndefined();
	expect(commandOutput("__S__\npartial", marker)).toBeUndefined();
});

test("commandOutput: 起始标记缺失标记 incomplete", () => {
	const marker = { start: "__S__", end: "__E__:" };
	expect(commandOutput("output\n__E__:1\n", marker)).toEqual({
		text: "output",
		incomplete: true,
		exitCode: 1,
	});
});

test("wrapCommand: 保留命令原文（引号/分号/换行）", () => {
	const marker = commandMarker();
	const wrapped = wrapCommand("echo 'a b'; echo c\necho d", marker);
	expect(wrapped).toContain(marker.start);
	expect(wrapped).toContain(marker.end);
	expect(wrapped.startsWith("printf ")).toBe(true);
});

test("maybeTruncate: 超限保留最早前缀并附裁剪提示", () => {
	const out = maybeTruncate("x".repeat(10), 4);
	expect(out.startsWith("xxxx")).toBe(true);
	expect(out).toContain("<response clipped>");
});

test("persistent bash: 默认描述与 DSH 一致", () => {
	expect(PERSISTENT_BASH_DESCRIPTION).toBe(
		"Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.",
	);
});

test("persistent bash: 描述携带超时策略，自定义描述也追加", () => {
	// 否则模型既不知道命令为何被杀，也没有延长手段（与 one-shot 的 withBashTimeout 对齐）。
	const handle = createPersistentBashTool({ workspaceDir: process.cwd() });
	expect(handle.tool.description).toContain("Run commands in a persistent bash shell");
	expect(handle.tool.description).toContain("killed after 300s");
	expect(handle.tool.description).toContain("an explicit timeout overrides the default");
	expect(handle.tool.description).toContain("A timed-out command also resets the shell");

	const custom = createPersistentBashTool({
		workspaceDir: process.cwd(),
		timeoutMs: 90000,
		description: "Custom shell tool.",
	});
	expect(custom.tool.description).toContain("Custom shell tool.");
	expect(custom.tool.description).toContain("killed after 90s");
});

test("RetainedTextBuffer: DSH 风格限制字节数并标记截断", () => {
	const buffer = new RetainedTextBuffer(8, 100);
	buffer.append("123456789");
	expect(buffer.snapshot()).toEqual({ text: "23456789", truncated: true });
});

test("RetainedTextBuffer: DSH 风格限制行数并保留最新内容", () => {
	const buffer = new RetainedTextBuffer(100, 3);
	buffer.append("a\nb\nc\n");
	expect(buffer.snapshot()).toEqual({ text: "b\nc\n", truncated: true });
});

shellTest("persistent bash: 结果标记携带单条命令耗时", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 5000 });
	onTestFinished(() => handle.dispose());
	const text = textOf(await handle.tool.execute("t", { command: "true" }, undefined));
	// 与 one-shot 的 withBashTimeout 拼同款标记：两种 bash 模式给模型的代价信号要一致。
	expect(text).toMatch(/\[Command finished with exit code 0 in \d+\.\d+s\]/);
});

shellTest("persistent bash: cwd/env 跨调用保留，exit 后重置", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 5000 });
	onTestFinished(() => handle.dispose());
	const run = (command: string) => handle.tool.execute("t", { command }, undefined);
	expect(textOf(await run("cd /tmp && pwd"))).toContain("/tmp");
	expect(textOf(await run("pwd"))).toContain("/tmp");
	expect(textOf(await run("export CAIRN_PB=ok; echo $CAIRN_PB"))).toContain("ok");
	const exited = textOf(await run("exit 7"));
	expect(exited).toContain("[shell exited: code 7]");
	// shell 已重置：下一次调用从工作区重新开始。
	expect(textOf(await run("pwd"))).not.toContain("/tmp");
});

shellTest("persistent bash: 超时后重置并告知模型", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 400 });
	onTestFinished(() => handle.dispose());
	const result = await handle.tool.execute("t", { command: "sleep 5; echo never" }, undefined);
	expect(textOf(result)).toContain("timed out");
	expect(textOf(result)).toContain("persistent bash shell was reset");
});

shellTest("persistent bash: 显式 timeout 延长默认值，长命令不被杀", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 300 });
	onTestFinished(() => handle.dispose());
	const result = await handle.tool.execute(
		"t",
		{ command: "sleep 1; echo done", timeout: 10 },
		undefined,
	);
	expect(textOf(result)).toContain("done");
	expect(textOf(result)).not.toContain("timed out");
});

shellTest("persistent bash: 显式 timeout 缩短默认值并反映在超时消息里", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 20000 });
	onTestFinished(() => handle.dispose());
	const result = await handle.tool.execute(
		"t",
		{ command: "sleep 5; echo never", timeout: 1 },
		undefined,
	);
	expect(textOf(result)).toContain("timed out after 1 seconds");
	expect(textOf(result)).toContain("persistent bash shell was reset");
});

shellTest("persistent bash: 非法 timeout 回落到默认值", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 1200 });
	onTestFinished(() => handle.dispose());
	// timeout: 0 不是合法覆盖：回落到 1200ms 默认，sleep 5 会被杀。
	const result = await handle.tool.execute(
		"t",
		{ command: "sleep 5; echo never", timeout: 0 },
		undefined,
	);
	expect(textOf(result)).toContain("timed out after 1 seconds");
});

shellTest("persistent bash: xterm 回应终端状态查询", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 5000 });
	onTestFinished(() => handle.dispose());
	const result = await handle.tool.execute(
		"t",
		{
			command: String.raw`printf '\033[5n'; IFS= read -r -n 4 reply; printf 'terminal-reply=%q\n' "$reply"`,
		},
		undefined,
	);
	expect(textOf(result)).toContain("terminal-reply=$'\\E[0n'");
});

linuxShellTest("persistent bash: 交互命令等 stdin 时提前返回且 shell 状态保留", async () => {
	const handle = createPersistentBashTool({ workspaceDir: process.cwd(), timeoutMs: 20000 });
	onTestFinished(() => handle.dispose());
	const run = (command: string) => handle.tool.execute("t", { command }, undefined);
	// 先改 cwd，验证 Ctrl-C 只中断前台、不丢 shell 状态。
	await run("cd /tmp");
	const started = Date.now();
	const result = await run("cat");
	expect(Date.now() - started).toBeLessThan(5000); // 远小于 20s 超时
	expect(textOf(result)).not.toContain("timed out");
	// shell 还在，cwd 仍是 /tmp。
	expect(textOf(await run("pwd"))).toContain("/tmp");
});
