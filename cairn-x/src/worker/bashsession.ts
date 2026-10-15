/**
 * 长驻 shell 会话：持久 bash 工具的传输层。
 *
 * 只使用 node-pty 分配真正的 TTY —— 没有管道兜底。node-pty 缺失或 PTY 分配
 * 失败都是配置错误，直接抛出，让上层显式失败，而不是悄悄降级成非 TTY 会话
 * （ssh/sudo 等交互程序会因此静默出错）。
 */

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import xtermHeadless from "@xterm/headless";

interface BashExitStatus {
	code: number | null;
	signal: string | null;
}

interface ShellTransport {
	initialize(signal?: AbortSignal): Promise<void>;
	write(line: string): Promise<void>;
	onData(handler: (chunk: string) => void): void;
	onExit(handler: (status: BashExitStatus) => void): void;
	/** 前台子进程是否阻塞在 fd 0 的 read 上（Linux /proc 探测；其他平台恒 false）。 */
	foregroundStdinWait(): boolean;
	/** 向前台进程组发 SIGINT（写入 Ctrl-C，由 PTY 行规程派发）。 */
	interrupt(): void;
	kill(): Promise<void>;
}

/** 等不到退出事件时的兜底，避免 reset 永久挂起。 */
const EXIT_GRACE_MS = 2000;
/** DSH terminal-bash 的 PTY 启动就绪上限。 */
const STARTUP_TIMEOUT_MS = 30000;
/** 交互式、无 profile/rc（拿到 job control）。 */
const BASH_SHELL = "/bin/bash";
const BASH_ARGS = ["--noprofile", "--norc", "-i"];
/** 受控提示符；提示符总在哨兵之前打印，切片时被丢弃。 */
const CONTROLLED_PROMPT = "dsh> ";
const PROMPT_COMMAND = 'printf "\\033]133;D;%s\\007" "$?"; PS1=\'dsh> \'';
/** PTY 尺寸与终端类型：TERM=dumb 让程序不做颜色/ANSI 渲染。 */
const PTY_COLS = 160;
const PTY_ROWS = 40;
const PTY_TERM = "dumb";
const { Terminal: HeadlessTerminal } = xtermHeadless;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 过滤 process.env 里的 undefined，得到 node-pty 可用的环境。 */
function shellEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...extra };
}

export interface ProcReader {
	readText(path: string): string | null;
	readLink(path: string): string | null;
	listDir(path: string): string[];
}

const DEFAULT_PROC: ProcReader = {
	readText: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	readLink: (path) => {
		try {
			return readlinkSync(path);
		} catch {
			return null;
		}
	},
	listDir: (path) => {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
};

/** 解析 /proc/<pid>/stat。comm 可能含空格/括号，所以从最后一个 ')' 之后切。 */
export function parseProcStat(
	raw: string,
): { state: string; pgrp: number; session: number; tpgid: number } | null {
	const close = raw.lastIndexOf(")");
	if (close < 0) return null;
	const fields = raw
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	if (fields.length < 6) return null;
	const pgrp = Number(fields[2]);
	const session = Number(fields[3]);
	const tpgid = Number(fields[5]);
	if (!Number.isInteger(pgrp) || !Number.isInteger(session) || !Number.isInteger(tpgid))
		return null;
	return { state: fields[0], pgrp, session, tpgid };
}

/**
 * 某个会话里的全部进程组。PTY 把 shell 作为会话首进程启动（会话号 = shell pid），
 * 交互式 shell 开了作业控制，后台作业（`cmd &`、tmux 以外的守护进程）各自在
 * 独立的进程组里；只杀 shell 自己的进程组会把它们漏掉。
 */
export function sessionProcessGroups(session: number, proc: ProcReader = DEFAULT_PROC): number[] {
	const groups = new Set<number>();
	for (const entry of proc.listDir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const raw = proc.readText("/proc/" + entry + "/stat");
		if (raw === null) continue;
		const stat = parseProcStat(raw);
		if (stat !== null && stat.session === session && stat.pgrp > 0) groups.add(stat.pgrp);
	}
	return [...groups];
}

/**
 * 只识别"可能在 fd 0 上阻塞"的读类系统调用，避免把 nanosleep/epoll 等误判成
 * 等输入。索引是 syscall 号，按架构区分（x86_64 的 read=0，aarch64 的 read=63）。
 */
const STDIN_READ_SYSCALLS: Record<string, Record<number, string>> = {
	x64: { 0: "read", 19: "readv" },
	arm64: { 63: "read", 65: "readv" },
};

/** 解析 /proc/<pid>/syscall，返回读类调用名与 fd（第一个参数）。 */
export function parseProcSyscall(raw: string, arch: string): { name: string; fd: number } | null {
	const table = STDIN_READ_SYSCALLS[arch];
	if (table === undefined) return null;
	const fields = raw.trim().split(/\s+/);
	const nr = Number(fields[0]);
	if (!Number.isInteger(nr)) return null;
	const name = table[nr];
	if (name === undefined) return null;
	const fd = Number(fields[1]);
	if (!Number.isInteger(fd)) return null;
	return { name, fd };
}

/**
 * 判断 PTY 的前台子进程是否正阻塞在 fd 0（我们的 TTY）的 read 上。
 *
 * 读 /proc/<shellPid>/stat 得到前台进程组 tpgid，再在前台组里找 fd 0 指向同一
 * TTY、且当前停在读类系统调用上的进程。任何一步读不到都返回 false：宁可等超时，
 * 也不误判正常命令。shell 自身在前台（tpgid == shellPid）时返回 false —— 那是
 * 提示符就绪，不是子进程等输入。
 */
/**
 * 读不到 /proc/<pid>/syscall 时的回退判据（宿主 yama.ptrace_scope=2 会 EPERM）。
 * 实测 tty 读等待的 wchan 是 wait_woken（cat、python input()），而 sleep/tail -f
 * 是 hrtimer_nanosleep、nc/curl 是 do_select/do_poll，因此不会误伤这些常见阻塞。
 */
const TTY_READ_WCHAN = /(wait_woken|n_tty_read|tty_read|pty_read)/;

export function isTtyReadWchan(wchan: string): boolean {
	const value = wchan.trim();
	return value.length > 0 && value !== "0" && TTY_READ_WCHAN.test(value);
}

export function foregroundStdinWait(
	pid: number,
	arch: string,
	proc: ProcReader = DEFAULT_PROC,
): boolean {
	const shellRaw = proc.readText("/proc/" + pid + "/stat");
	if (shellRaw === null) return false;
	const shell = parseProcStat(shellRaw);
	if (shell === null || shell.tpgid <= 0 || shell.tpgid === pid) return false;
	const tty = proc.readLink("/proc/" + pid + "/fd/0");
	for (const entry of proc.listDir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const candidate = Number(entry);
		if (candidate === pid) continue;
		const raw = proc.readText("/proc/" + candidate + "/stat");
		if (raw === null) continue;
		const stat = parseProcStat(raw);
		if (stat === null || stat.pgrp !== shell.tpgid) continue;
		if (tty !== null && proc.readLink("/proc/" + candidate + "/fd/0") !== tty) continue;
		const syscall = proc.readText("/proc/" + candidate + "/syscall");
		if (syscall !== null) {
			// 能读到 syscall 就精确判断：只有 read/readv(fd 0) 才算等 stdin。
			const parsed = parseProcSyscall(syscall, arch);
			if (parsed !== null && parsed.fd === 0) return true;
			continue;
		}
		// syscall 不可读（ptrace 受限）时退回 wchan，且只认 tty 读等待。
		const wchan = proc.readText("/proc/" + candidate + "/wchan");
		if (wchan !== null && isTtyReadWchan(wchan)) return true;
	}
	return false;
}

interface PtyTerminal {
	readonly pid: number;
	write(data: string): void;
	onData(handler: (data: string) => void): void;
	onExit(handler: (event: { exitCode: number; signal?: number }) => void): void;
	kill(signal?: string): void;
}

interface PtyModule {
	spawn(file: string, args: string[], options: Record<string, unknown>): PtyTerminal;
}

class PtyTransport implements ShellTransport {
	private readonly terminal: PtyTerminal;
	private readonly exited: Promise<void>;
	private readonly emulator = new HeadlessTerminal({
		cols: PTY_COLS,
		rows: PTY_ROWS,
		scrollback: 0,
	});
	private emulatorWrites: Promise<void> = Promise.resolve();
	private responseWrites: Promise<void> = Promise.resolve();
	private protocolError: Error | null = null;
	private readonly ready: Promise<boolean>;
	private readyResolve: ((ready: boolean) => void) | null = null;
	private readySettled = false;
	private readyText = "";
	private initialized = false;
	private dataHandler: ((chunk: string) => void) | null = null;
	private exitHandler: ((status: BashExitStatus) => void) | null = null;

	constructor(
		pty: PtyModule,
		cwd: string,
		shell: string,
		args: string[],
		env: Record<string, string>,
	) {
		// PTY 分配失败会在这里抛错，由 createTransport 包成配置错误抛出。
		this.terminal = pty.spawn(shell, args, {
			name: PTY_TERM,
			cols: PTY_COLS,
			rows: PTY_ROWS,
			cwd,
			env: shellEnv(env),
		});
		this.ready = new Promise<boolean>((resolve) => {
			this.readyResolve = resolve;
		});
		this.exited = new Promise<void>((resolve) => {
			this.terminal.onExit(({ exitCode, signal }) => {
				if (!this.readySettled) this.resolveReady(false);
				// node-pty 正常退出时 signal 是 0（不是 undefined），0 表示无信号。
				const signalled = signal !== undefined && signal !== 0;
				this.exitHandler?.({
					code: exitCode ?? null,
					signal: signalled ? String(signal) : null,
				});
				resolve();
			});
		});
		this.emulator.onData((data) => this.queueTerminalResponse(data));
		this.terminal.onData((data) => {
			// DSH 使用 @xterm/headless 消费输出并把终端查询响应写回 PTY。
			// 原始数据仍交给上层做命令哨兵解析和模型可见输出清洗。
			this.queueTerminalOutput(data);
			this.readyText = (this.readyText + data).slice(-8192);
			if (this.readyText.includes(CONTROLLED_PROMPT)) this.resolveReady(true);
			this.dataHandler?.(data);
		});
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		signal?.throwIfAborted();
		this.initialized = true;
		try {
			// DSH 在首次发送前关闭回显，并等待 PTY 报告提示符已就绪。
			await this.write("stty -echo");
		} catch (error) {
			throw new Error("persistent bash failed to initialize: " + errorText(error));
		}
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timeoutId = setTimeout(() => resolve(false), STARTUP_TIMEOUT_MS);
		});
		let abort: Promise<never> | undefined;
		let onAbort: (() => void) | undefined;
		if (signal !== undefined) {
			abort = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort!, { once: true });
			});
		}
		try {
			const ready = await Promise.race([
				this.ready,
				timeout,
				...(abort === undefined ? [] : [abort]),
			]);
			if (!ready)
				throw new Error("persistent bash shell did not reach readiness before startup timeout");
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			if (signal !== undefined && onAbort !== undefined)
				signal.removeEventListener("abort", onAbort);
		}
	}

	private resolveReady(value: boolean): void {
		if (this.readySettled) return;
		this.readySettled = true;
		this.readyResolve?.(value);
	}

	/** 将 PTY 输出按顺序交给 xterm；xterm 生成的查询响应会再写回 PTY。 */
	private queueTerminalOutput(data: string): void {
		this.emulatorWrites = this.emulatorWrites
			.then(
				() =>
					new Promise<void>((resolve, reject) => {
						try {
							this.emulator.write(data, resolve);
						} catch (error) {
							reject(error);
						}
					}),
			)
			.catch((error: unknown) => {
				this.protocolError ??= new Error("persistent bash terminal emulation failed", {
					cause: error,
				});
			});
	}

	private queueTerminalResponse(data: string): void {
		this.responseWrites = this.responseWrites.then(() => {
			try {
				this.terminal.write(data);
			} catch (error) {
				this.protocolError ??= new Error("persistent bash terminal response failed", {
					cause: error,
				});
			}
		});
	}

	/** 等待 xterm 解析输出并把任何终端协议响应送达 shell。 */
	private async drainTerminalProtocol(): Promise<void> {
		for (;;) {
			const emulatorWrites = this.emulatorWrites;
			await emulatorWrites;
			const responseWrites = this.responseWrites;
			await responseWrites;
			if (emulatorWrites === this.emulatorWrites && responseWrites === this.responseWrites) break;
		}
		if (this.protocolError !== null) throw this.protocolError;
	}

	async write(line: string): Promise<void> {
		await this.drainTerminalProtocol();
		this.terminal.write(line.endsWith("\n") ? line : line + "\n");
	}

	onData(handler: (chunk: string) => void): void {
		this.dataHandler = handler;
	}

	onExit(handler: (status: BashExitStatus) => void): void {
		this.exitHandler = handler;
	}

	foregroundStdinWait(): boolean {
		return process.platform === "linux" && foregroundStdinWait(this.terminal.pid, process.arch);
	}

	interrupt(): void {
		try {
			this.terminal.write("\u0003");
		} catch {
			// 前台可能已经退出。
		}
	}

	async kill(): Promise<void> {
		const pid = this.terminal.pid;
		try {
			this.terminal.kill();
		} catch {
			// 已经退出。
		}
		if (Number.isSafeInteger(pid) && pid > 0) {
			// shell 退出后，后台作业被挂到 init 下但会话号不变，仍能按会话找到。
			// shell 自身的组始终放进去兜底（非 Linux 没有 /proc 时只剩这一组）。
			// tmux 等用 setsid 另开会话的守护进程不在此列，可跨步骤存活。
			const groups = new Set([pid, ...sessionProcessGroups(pid)]);
			for (const group of groups) {
				try {
					process.kill(-group, "SIGKILL");
				} catch {
					// 进程组可能已消失。
				}
			}
		}
		await Promise.race([this.exited, sleep(EXIT_GRACE_MS)]);
		this.emulator.dispose();
	}
}

let ptyModule: PtyModule | undefined;

/** 加载 node-pty。缺失即抛错：持久 bash 没有管道兜底。 */
async function loadPty(): Promise<PtyModule> {
	if (ptyModule !== undefined) return ptyModule;
	let loaded: ({ default?: PtyModule } & Partial<PtyModule>) | undefined;
	try {
		// 用变量而不是字面量：node-pty 是运行时必需依赖，但不应在编译期解析。
		const specifier = "node-pty";
		loaded = (await import(/* @vite-ignore */ specifier)) as {
			default?: PtyModule;
		} & Partial<PtyModule>;
	} catch (error) {
		throw new Error(
			"persistent bash requires node-pty, but it could not be loaded: " + errorText(error),
		);
	}
	const resolved = (loaded.default ?? loaded) as PtyModule;
	if (typeof resolved.spawn !== "function") {
		throw new Error("persistent bash requires node-pty, but the loaded module has no spawn()");
	}
	ptyModule = resolved;
	return resolved;
}

/**
 * 探测当前宿主能否分配 PTY。
 *
 * 仅供测试决定是否跳过真起 shell 的集成用例；生产路径失败会直接抛错，
 * 不会回退到非 TTY 会话。
 */
export async function canAllocatePty(): Promise<boolean> {
	try {
		const pty = await loadPty();
		const probe = pty.spawn("true", [], {
			name: PTY_TERM,
			cols: 80,
			rows: 24,
			cwd: process.cwd(),
			env: shellEnv({ TERM: PTY_TERM }),
		});
		try {
			probe.kill();
		} catch {
			// 探测进程可能已经退出。
		}
		return true;
	} catch {
		return false;
	}
}

async function createTransport(
	cwd: string,
	shell: string,
	args: string[],
	env: Record<string, string>,
): Promise<ShellTransport> {
	const pty = await loadPty();
	try {
		return new PtyTransport(pty, cwd, shell, args, env);
	} catch (error) {
		throw new Error("persistent bash could not allocate a PTY: " + errorText(error));
	}
}

export class BashSession {
	private transport: ShellTransport | null = null;
	private generation = 0;
	private status: BashExitStatus | null = null;
	private dataHandler: ((chunk: string) => void) | null = null;

	private readonly shell: string;
	private readonly args: string[];
	private readonly sessionId = randomUUID();
	private readonly env: Record<string, string>;

	constructor(
		private readonly cwd: string,
		shell: string = BASH_SHELL,
		args: string[] = BASH_ARGS,
	) {
		this.shell = shell;
		this.args = args;
		// 对齐 DSH childEnvironment：会话 ID 跨 shell reset 保持，PTY ID 每次
		// 新建 shell 变化；Cairn 当前没有独立的 owner 服务，所以 sessionId
		// 代表这个 Worker 内的 Bash 工具实例。
		this.env = {
			TERM: PTY_TERM,
			PAGER: "cat",
			GIT_PAGER: "cat",
			PS1: CONTROLLED_PROMPT,
			PROMPT_COMMAND,
			BASH_SILENCE_DEPRECATION_WARNING: "1",
			DSH_SHELL: "1",
			DSH_SESSION_ID: this.sessionId,
		};
	}

	/** 当前 shell 的退出状态；null = 仍在运行或尚未启动。 */
	get exited(): BashExitStatus | null {
		return this.status;
	}

	onData(handler: (chunk: string) => void): void {
		this.dataHandler = handler;
	}

	/** 前台子进程是否阻塞在等 stdin（见 foregroundStdinWait）。 */
	foregroundStdinWait(): boolean {
		return this.transport?.foregroundStdinWait() ?? false;
	}

	/** 向前台进程组发 SIGINT，保留 shell 与它的 cwd/环境。 */
	interruptForeground(): void {
		this.transport?.interrupt();
	}

	/** 确保有一个运行中的 shell；已退出或从未启动时新起一个。 */
	async ensure(signal?: AbortSignal): Promise<void> {
		if (this.transport !== null && this.status === null) return;
		signal?.throwIfAborted();
		await this.start(signal);
	}

	private async start(signal?: AbortSignal): Promise<void> {
		const generation = ++this.generation;
		this.status = null;
		const transport = await createTransport(this.cwd, this.shell, this.args, {
			...this.env,
			DSH_PTY_SESSION_ID: randomUUID(),
		});
		if (generation !== this.generation) {
			await transport.kill();
			return;
		}
		this.transport = transport;
		transport.onData((chunk) => {
			if (generation === this.generation) this.dataHandler?.(chunk);
		});
		transport.onExit((status) => {
			if (generation === this.generation) this.status = status;
		});
		try {
			await transport.initialize(signal);
		} catch (error) {
			if (generation === this.generation) {
				this.transport = null;
				this.generation += 1;
				this.status = null;
			}
			await transport.kill();
			throw error;
		}
	}

	/** 向 shell 写入一行命令（自动补换行）。 */
	async write(line: string): Promise<void> {
		const transport = this.transport;
		if (transport === null || this.status !== null) {
			throw new Error("bash session is not running");
		}
		await transport.write(line);
	}

	/** 结束当前 shell 并等待其进程组退出；幂等。 */
	async reset(): Promise<void> {
		const transport = this.transport;
		this.transport = null;
		this.generation += 1; // 旧进程的 exit 回调就此失效
		this.status = null;
		if (transport === null) return;
		await transport.kill();
	}
}
