/**
 * 终端输出清洗：剥 CSI/OSC、跨块 carry、CR 归一。
 */

import { expect, test } from "vitest";

import { sanitizeTerminalOutput, TerminalSanitizer } from "../../src/worker/terminal-sanitizer.js";

test("剥离 CSI 颜色/清屏序列", () => {
	expect(sanitizeTerminalOutput("\x1b[0;32mOK\x1b[0m done")).toBe("OK done");
	expect(sanitizeTerminalOutput("\x1b[2J\x1b[Htext")).toBe("text");
});

test("剥 OSC（BEL 与 ST 两种终止）", () => {
	expect(sanitizeTerminalOutput("\x1b]0;title\x07visible")).toBe("visible");
	expect(sanitizeTerminalOutput("\x1b]0;title\x1b\\visible")).toBe("visible");
	const s = new TerminalSanitizer();
	const pushed = s.push("pre\x1b]133;D;0\x07post");
	expect(pushed.text).toBe("prepost");
});

test("跨块截断的转义序列被拼起来剥掉", () => {
	const s = new TerminalSanitizer();
	expect(s.push("\x1b[0;3").text).toBe("");
	expect(s.push("2mOK").text).toBe("OK");
	const t = new TerminalSanitizer();
	expect(t.push("\x1b]0;ti").text).toBe("");
	expect(t.push("tle\x07x").text).toBe("x");
});

test("CRLF 与独立 CR 归一成 LF，BEL 删除", () => {
	expect(sanitizeTerminalOutput("a\r\nb\rc")).toBe("a\nb\nc");
	expect(sanitizeTerminalOutput("ding\x07")).toBe("ding");
});

test("块尾 CR 延迟到下一块处理", () => {
	const s = new TerminalSanitizer();
	expect(s.push("a\r").text).toBe("a");
	expect(s.push("\nb").text).toBe("\nb");
});

test("flush：丢弃不完整转义，并补上挂起的 CR", () => {
	const s = new TerminalSanitizer();
	s.push("hello\r");
	expect(s.flush()).toBe("\n");
	const t = new TerminalSanitizer();
	t.push("\x1b[0;32");
	expect(t.flush()).toBe("");
	expect(sanitizeTerminalOutput("hello\r")).toBe("hello\n");
});
