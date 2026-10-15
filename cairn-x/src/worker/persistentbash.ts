/**
 * 持久 bash 工具。
 *

 * 每个工具实例（= 每次 Worker 执行）拥有一个常驻 shell，命令用随机哨兵包裹，
 * 靠 stdout 里的哨兵切分输出与退出码。超时或 shell 退出都会重置 shell，并在
 * 结果里明确告知模型下一次从工作区重新开始。
 *
 * 输出用有界保留缓冲，超出 DSH 风格的字节/行上限时标记前缀丢失，渲染时补
 * LOST_PREFIX 提示。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { BashSession } from "./bashsession.js";
import { sanitizeTerminalOutput } from "./terminal-sanitizer.js";

/** 默认模型可见描述，与 DSH 最新持久 bash 工具的默认描述一致。 */
export const PERSISTENT_BASH_DESCRIPTION =
	"Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.";

/**
 * bash 超时策略的模型可见说明：one-shot（worldtools 的 withBashTimeout）与
 * persistent 共用同一段措辞，避免两处漂移。
 */
export function bashTimeoutPolicyText(defaultSeconds: number): string {
	return (
		`\n\nTimeout policy: each command is killed after ${defaultSeconds}s unless you pass \`timeout\` ` +
		"(seconds); an explicit timeout overrides the default."
	);
}

const BACKTICK = String.fromCharCode(96);
const TRUNCATED_MESSAGE =
	"<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with " +
	BACKTICK +
	"grep -n" +
	BACKTICK +
	" in order to find the line numbers of what you are looking for.</NOTE>";
const LOST_PREFIX_MESSAGE =
	"<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n";
const SHELL_RESET_MESSAGE =
	"The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.";
const TIMEOUT_STATUS_MARKER = "[Command timed out or OOM]";
const STDIN_WAIT_STATUS_MARKER = "[Command interrupted while waiting for stdin]";
const POLL_INTERVAL_MS = 25;
/** 发送后多久才开始探测前台 stdin 等待（避开 shell 还没读到命令的窗口）。 */
const STDIN_PROBE_AFTER_MS = 150;
/** 探测间隔：/proc 扫描不便宜，不必每个 poll 都做。 */
const STDIN_PROBE_INTERVAL_MS = 200;
/** 发出 Ctrl-C 后给前台进程响应的时间；仍不退出就重置 shell。 */
const STDIN_INTERRUPT_GRACE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_OUTPUT_CHARS = 16000;
/** 与 DSH terminal-bash 默认值对齐：4 MiB、最多 10,000 行。 */
const MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_LINES = 10_000;

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
		count += 1;
	}
	return count;
}

interface RetainedTextSnapshot {
	text: string;
	truncated: boolean;
}

/** DSH 风格的有界 scrollback：丢弃最早内容并明确标记前缀不完整。 */
export class RetainedTextBuffer {
	private text = "";
	private bytes = 0;
	private lines = 0;
	private truncated = false;
	private revision = 0;

	constructor(
		private readonly maxBytes = MAX_RETAINED_BYTES,
		private readonly maxLines = MAX_RETAINED_LINES,
	) {}

	append(chunk: string): void {
		if (chunk.length === 0) return;
		this.revision += 1;
		this.text += chunk;
		this.bytes += Buffer.byteLength(chunk, "utf8");
		this.lines += countNewlines(chunk);
		this.trim();
	}

	includes(value: string): boolean {
		return this.text.includes(value);
	}

	get version(): number {
		return this.revision;
	}

	snapshot(): RetainedTextSnapshot {
		return { text: this.text, truncated: this.truncated };
	}

	clear(): void {
		this.revision += 1;
		this.text = "";
		this.bytes = 0;
		this.lines = 0;
		this.truncated = false;
	}

	private trim(): void {
		while (this.bytes > this.maxBytes || this.lines >= this.maxLines) {
			if (this.lines >= this.maxLines) {
				const newline = this.text.indexOf("\n");
				if (newline >= 0) {
					this.dropPrefix(newline + 1);
					continue;
				}
			}
			if (this.bytes > this.maxBytes) this.dropBytesToLimit();
			else break;
		}
	}

	private dropBytesToLimit(): void {
		const target = this.bytes - this.maxBytes;
		let removedBytes = 0;
		let codeUnits = 0;
		while (codeUnits < this.text.length && removedBytes < target) {
			const first = this.text.charCodeAt(codeUnits);
			const paired =
				first >= 0xd800 &&
				first <= 0xdbff &&
				codeUnits + 1 < this.text.length &&
				this.text.charCodeAt(codeUnits + 1) >= 0xdc00 &&
				this.text.charCodeAt(codeUnits + 1) <= 0xdfff;
			const units = paired ? 2 : 1;
			const charBytes = Buffer.byteLength(this.text.slice(codeUnits, codeUnits + units), "utf8");
			if (codeUnits > 0 && removedBytes + charBytes > target) break;
			codeUnits += units;
			removedBytes += charBytes;
		}
		if (codeUnits === 0 && this.text.length > 0) codeUnits = 1;
		this.dropPrefix(codeUnits);
	}

	private dropPrefix(codeUnits: number): void {
		if (codeUnits <= 0) return;
		const removed = this.text.slice(0, codeUnits);
		this.text = this.text.slice(codeUnits);
		this.bytes -= Buffer.byteLength(removed, "utf8");
		this.lines -= countNewlines(removed);
		this.truncated = true;
	}
}

interface CommandMarker {
	start: string;
	end: string;
}

interface CapturedOutput {
	text: string;
	incomplete: boolean;
	exitCode?: number;
}

export function commandMarker(): CommandMarker {
	const nonce = randomUUID();
	return {
		start: "__DSH_PERSISTENT_BASH_START_" + nonce + "__",
		end: "__DSH_PERSISTENT_BASH_END_" + nonce + ":",
	};
}

function quoteForBash(value: string): string {
	return (
		"$'" +
		value
			.replaceAll("\\", "\\\\")
			.replaceAll("'", "\\'")
			.replaceAll("\r", "\\r")
			.replaceAll("\n", "\\n") +
		"'"
	);
}

export function wrapCommand(command: string, marker: CommandMarker): string {
	return (
		"printf '%s\\n' " +
		quoteForBash(marker.start) +
		"; eval -- " +
		quoteForBash(command) +
		"; __dsh_persistent_bash_status=$?; printf '%s%s\\n' " +
		quoteForBash(marker.end) +
		' "$__dsh_persistent_bash_status"'
	);
}

function trimTrailingNewline(text: string): string {
	return text.replace(/(?:\r?\n)+$/, "");
}

export function commandOutput(text: string, marker: CommandMarker): CapturedOutput | undefined {
	const end = text.lastIndexOf(marker.end);
	if (end < 0) return undefined;
	const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1];
	if (status === undefined) return undefined;
	const startMarker = text.lastIndexOf(marker.start, end);
	const start = startMarker < 0 ? 0 : startMarker + marker.start.length;
	return {
		text: trimTrailingNewline(text.slice(start, end).replace(/^\r?\n/, "")),
		incomplete: startMarker < 0,
		exitCode: Number(status),
	};
}

function partialOutput(text: string, marker: CommandMarker, lostFront: boolean): CapturedOutput {
	const startMarker = text.lastIndexOf(marker.start);
	if (startMarker >= 0) {
		return {
			text: trimTrailingNewline(
				text.slice(startMarker + marker.start.length).replace(/^\r?\n/, ""),
			),
			incomplete: false,
		};
	}
	return { text: trimTrailingNewline(text), incomplete: lostFront };
}

export function maybeTruncate(content: string, maxOutputChars: number, incomplete = false): string {
	if (content.length <= maxOutputChars && !incomplete) return content;
	return content.length <= maxOutputChars
		? content + TRUNCATED_MESSAGE
		: content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

/**
 * 单条命令耗时的模型可见写法。
 *
 * 统一用秒加一位小数，不混用分/秒：模型拿它横向比较「这个动作有多贵」
 * （选字典、定扫描范围、决定是否换方法），单位一致才有可比性。
 */
export function formatCommandDuration(ms: number): string {
	return (ms / 1000).toFixed(1) + "s";
}

function appendStatusMarker(content: string, marker: string | undefined): string {
	if (marker === undefined) return content;
	return content.length === 0 ? marker : content + "\n" + marker;
}

function renderCaptured(
	output: CapturedOutput,
	maxOutputChars: number,
	durationMs?: number,
): string {
	// 先清洗再截断：剥掉转义后长度会变，截断要按模型实际读到的文本算。
	const text = sanitizeTerminalOutput(output.text);
	const rendered = maybeTruncate(text, maxOutputChars, output.incomplete);
	const withLost = output.incomplete && text.length > 0 ? LOST_PREFIX_MESSAGE + rendered : rendered;
	return appendStatusMarker(
		withLost,
		output.exitCode === undefined
			? undefined
			: "[Command finished with exit code " +
					output.exitCode +
					(durationMs === undefined ? "" : " in " + formatCommandDuration(durationMs)) +
					"]",
	);
}

function renderShellExitStatus(
	content: string,
	exitCode: number | null,
	signal: string | null,
): string {
	return appendStatusMarker(
		content,
		signal !== null
			? "[shell killed by signal: " + signal + "]"
			: exitCode !== null
				? "[shell exited: code " + exitCode + "]"
				: "[shell exited]",
	);
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

interface PersistentBashOptions {
	workspaceDir: string;
	/** 单条命令的默认墙钟上限（毫秒）；模型可按次用 timeout 参数（秒）覆盖。默认 300000ms。 */
	timeoutMs?: number;
	/** 单条命令返回给模型的输出上限（保留最早前缀）。默认 16000。 */
	maxOutputChars?: number;
	description?: string;
}

export interface PersistentBashHandle {
	tool: AgentTool;
	dispose: () => Promise<void>;
}

export function createPersistentBashTool(options: PersistentBashOptions): PersistentBashHandle {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
	// 超时策略必须写进描述（与 one-shot 的 withBashTimeout 一致）：否则模型既
	// 不知道命令为何被杀，也没有延长手段，长扫描只能被动接受 300s 默认值。
	// 自定义 description 也照常追加——策略是事实行为，不是风格。
	const description =
		(options.description ?? PERSISTENT_BASH_DESCRIPTION) +
		bashTimeoutPolicyText(Math.round(timeoutMs / 1000)) +
		" A timed-out command also resets the shell (working directory and exported variables are lost).";

	const session = new BashSession(options.workspaceDir);
	const buffer = new RetainedTextBuffer();
	let disposed = false;
	session.onData((chunk) => buffer.append(chunk));

	// 同一 shell 的命令必须串行：并发写入会打乱哨兵边界。
	let chain: Promise<unknown> = Promise.resolve();
	const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = chain.then(operation, operation);
		chain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const respondToExit = async (marker: CommandMarker | null): Promise<string> => {
		const status = session.exited ?? { code: null, signal: null };
		const snapshot = buffer.snapshot();
		await session.reset();
		buffer.clear();
		const output =
			marker === null
				? ""
				: renderCaptured(partialOutput(snapshot.text, marker, snapshot.truncated), maxOutputChars);
		return renderShellExitStatus(output, status.code, status.signal) + "\n" + SHELL_RESET_MESSAGE;
	};

	const respondToTimeout = async (
		marker: CommandMarker,
		effectiveTimeoutMs: number,
	): Promise<string> => {
		const snapshot = buffer.snapshot();
		const partial = renderCaptured(
			partialOutput(snapshot.text, marker, snapshot.truncated),
			maxOutputChars,
		);
		await session.reset();
		buffer.clear();
		return (
			"Your command timed out after " +
			Math.round(effectiveTimeoutMs / 1000) +
			" seconds or experienced an OOM error. Below is partial output:\n" +
			appendStatusMarker(partial, TIMEOUT_STATUS_MARKER) +
			"\n" +
			SHELL_RESET_MESSAGE
		);
	};

	const respondToStdinWait = async (marker: CommandMarker): Promise<string> => {
		const snapshot = buffer.snapshot();
		const partial = renderCaptured(
			partialOutput(snapshot.text, marker, snapshot.truncated),
			maxOutputChars,
		);
		// 命令在等 stdin 时立刻把已有输出还给模型，而不是等满超时。
		// 区别是这里会向前台发 Ctrl-C，让 shell 回到提示符、保住 cwd/环境；前台
		// 若忽略 SIGINT 则重置 shell，避免下一条命令被它吞掉。
		session.interruptForeground();
		const deadline = Date.now() + STDIN_INTERRUPT_GRACE_MS;
		while (Date.now() < deadline && session.foregroundStdinWait()) await pause();
		buffer.clear();
		const interrupted = partial
			? `${partial}\n${STDIN_WAIT_STATUS_MARKER}`
			: STDIN_WAIT_STATUS_MARKER;
		if (!session.foregroundStdinWait()) return interrupted;
		await session.reset();
		return interrupted + "\n" + SHELL_RESET_MESSAGE;
	};

	const run = async (
		command: string,
		requestedSeconds: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<string> => {
		if (disposed) throw new Error("persistent bash tool is disposed");
		if (command.trim().length === 0) throw new Error("command must be a non-empty string");
		return serialized(async () => {
			if (disposed) throw new Error("persistent bash tool is disposed");
			signal?.throwIfAborted();
			if (session.exited !== null) return respondToExit(null);
			await session.ensure(signal);
			const marker = commandMarker();
			buffer.clear();
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			// 模型按次覆盖默认超时，语义与 one-shot 的 timeout 参数一致；
			// 非法值（0 / 负数 / 非有限数）回落到配置的默认值。
			const effectiveTimeoutMs =
				typeof requestedSeconds === "number" &&
				Number.isFinite(requestedSeconds) &&
				requestedSeconds > 0
					? requestedSeconds * 1000
					: timeoutMs;
			const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
			// 计时只覆盖命令本身（不含 shell 启动）。取消、超时与正常结束共用它。
			const startedAt = Date.now();
			try {
				try {
					await session.write(wrapCommand(command, marker));
				} catch {
					return await respondToExit(marker);
				}
				let nextStdinProbe = Date.now() + STDIN_PROBE_AFTER_MS;
				let checkedVersion = -1;
				for (;;) {
					if (session.exited !== null) return await respondToExit(marker);
					if (buffer.version !== checkedVersion && buffer.includes(marker.end)) {
						const parsed = commandOutput(buffer.snapshot().text, marker);
						if (parsed !== undefined)
							return renderCaptured(parsed, maxOutputChars, Date.now() - startedAt);
					}
					checkedVersion = buffer.version;
					if (Date.now() >= nextStdinProbe) {
						nextStdinProbe = Date.now() + STDIN_PROBE_INTERVAL_MS;
						if (session.foregroundStdinWait()) return await respondToStdinWait(marker);
					}
					if (controller.signal.aborted) {
						if (signal?.aborted === true) {
							await session.reset();
							buffer.clear();
							signal.throwIfAborted();
						}
						return await respondToTimeout(marker, effectiveTimeoutMs);
					}
					await pause();
				}
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		});
	};

	const parameters = Type.Object({
		command: Type.String({
			description: "The bash command to run. Relative path is preferred in the command.",
		}),
		timeout: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Per-command wall-clock limit in seconds; overrides the default for this command only. " +
					"Use it for long scans; the command is killed and the shell reset when it expires.",
			}),
		),
	});

	const tool: AgentTool<typeof parameters> = {
		name: "bash",
		label: "Bash",
		description,
		parameters,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const text = await run(params.command, params.timeout, signal);
			return { content: [{ type: "text", text }], details: { command: params.command } };
		},
	};

	return {
		tool,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await serialized(() => session.reset());
		},
	};
}
