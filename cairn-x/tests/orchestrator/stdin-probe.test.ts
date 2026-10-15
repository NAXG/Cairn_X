/**
 * 前台 stdin 等待探测：纯解析 + 注入式 /proc 读取。
 *
 * 真机探测依赖 Linux /proc，这里用假 ProcReader 覆盖判定逻辑，macOS 上也能跑。
 */

import { expect, test } from "vitest";

import {
	foregroundStdinWait,
	isTtyReadWchan,
	parseProcStat,
	parseProcSyscall,
	sessionProcessGroups,
	type ProcReader,
} from "../../src/worker/bashsession.js";

function fakeProc(
	files: Record<string, string>,
	links: Record<string, string>,
	pids: string[],
): ProcReader {
	return {
		readText: (path) => files[path] ?? null,
		readLink: (path) => links[path] ?? null,
		listDir: (path) => (path === "/proc" ? pids : []),
	};
}

// /proc/<pid>/stat 字段：pid (comm) state ppid pgrp session tty_nr tpgid ...
const SHELL_STAT = "100 (bash) S 90 100 100 34816 200 4194304 1 0 0 0 0 0 0 0 20 0 1 0 123 456 789";
const CAT_STAT = "200 (cat) S 100 200 200 34816 200 4194304 1 0 0 0 0 0 0 0 20 0 1 0 123 456 789";

test("parseProcStat: 从最后一个 ')' 后切，comm 里的空格/括号不影响", () => {
	expect(parseProcStat(SHELL_STAT)).toEqual({ state: "S", pgrp: 100, session: 100, tpgid: 200 });
	expect(parseProcStat("100 (weird (name) x) R 1 2 3 4 5 6 7")).toEqual({
		state: "R",
		pgrp: 2,
		session: 3,
		tpgid: 5,
	});
	expect(parseProcStat("garbage")).toBeNull();
});

test("parseProcSyscall: 只认读类调用，fd 从第一个参数取", () => {
	expect(parseProcSyscall("0 0x0 0x7ffd 0x1000 0x7f 0x55", "x64")).toEqual({ name: "read", fd: 0 });
	expect(parseProcSyscall("19 0x0 0x7ffd 0x1 0x0 0x55", "x64")).toEqual({ name: "readv", fd: 0 });
	expect(parseProcSyscall("63 0x0 0x7ffd 0x1000 0x7f 0x55", "arm64")).toEqual({
		name: "read",
		fd: 0,
	});
	// nanosleep(35) 不是等待 stdin；fd 非 0 也不是；未知架构不判定。
	expect(parseProcSyscall("35 0x0 0x0 0x0 0x0 0x55", "x64")).toBeNull();
	expect(parseProcSyscall("0 0x3 0x7ffd 0x1000 0x7f 0x55", "x64")).toEqual({ name: "read", fd: 3 });
	expect(parseProcSyscall("0 0x0 0x7ffd 0x1000 0x7f 0x55", "riscv64")).toBeNull();
});

test("foregroundStdinWait: 前台子进程 read(fd 0) 命中", () => {
	const proc = fakeProc(
		{
			"/proc/100/stat": SHELL_STAT,
			"/proc/200/stat": CAT_STAT,
			"/proc/200/syscall": "0 0x0 0x7ffd 0x1000 0x7f 0x55",
		},
		{ "/proc/100/fd/0": "/dev/pts/3", "/proc/200/fd/0": "/dev/pts/3" },
		["100", "200", "self", "uptime"],
	);
	expect(foregroundStdinWait(100, "x64", proc)).toBe(true);
});

test("foregroundStdinWait: shell 自己在前台（提示符）不命中", () => {
	const proc = fakeProc(
		{ "/proc/100/stat": "100 (bash) S 90 90 100 34816 100 4194304 1 0 0 0 0 0 0 0 20 0 1 0 1 2 3" },
		{ "/proc/100/fd/0": "/dev/pts/3" },
		["100"],
	);
	expect(foregroundStdinWait(100, "x64", proc)).toBe(false);
});

test("foregroundStdinWait: 读别的 fd / 别的 TTY / 睡眠都不命中", () => {
	const base = { "/proc/100/stat": SHELL_STAT, "/proc/200/stat": CAT_STAT };
	const links = { "/proc/100/fd/0": "/dev/pts/3", "/proc/200/fd/0": "/dev/pts/3" };
	const otherFd = fakeProc(
		{ ...base, "/proc/200/syscall": "0 0x3 0x7ffd 0x1000 0x7f 0x55" },
		links,
		["100", "200"],
	);
	expect(foregroundStdinWait(100, "x64", otherFd)).toBe(false);
	const otherTty = fakeProc(
		{ ...base, "/proc/200/syscall": "0 0x0 0x7ffd 0x1000 0x7f 0x55" },
		{ "/proc/100/fd/0": "/dev/pts/3", "/proc/200/fd/0": "/dev/pts/9" },
		["100", "200"],
	);
	expect(foregroundStdinWait(100, "x64", otherTty)).toBe(false);
	const sleeping = fakeProc({ ...base, "/proc/200/syscall": "35 0x0 0x0 0x0 0x0 0x55" }, links, [
		"100",
		"200",
	]);
	expect(foregroundStdinWait(100, "x64", sleeping)).toBe(false);
});

test("isTtyReadWchan: 只认 tty 读等待", () => {
	expect(isTtyReadWchan("wait_woken")).toBe(true);
	expect(isTtyReadWchan("n_tty_read")).toBe(true);
	expect(isTtyReadWchan("hrtimer_nanosleep")).toBe(false);
	expect(isTtyReadWchan("do_select")).toBe(false);
	expect(isTtyReadWchan("0")).toBe(false);
	expect(isTtyReadWchan("")).toBe(false);
});

test("foregroundStdinWait: syscall 不可读时用 wchan 回退", () => {
	const base = { "/proc/100/stat": SHELL_STAT, "/proc/200/stat": CAT_STAT };
	const links = { "/proc/100/fd/0": "/dev/pts/3", "/proc/200/fd/0": "/dev/pts/3" };
	// 无 /proc/200/syscall（yama 限制）+ wchan=wait_woken → 命中
	const waiting = fakeProc({ ...base, "/proc/200/wchan": "wait_woken" }, links, ["100", "200"]);
	expect(foregroundStdinWait(100, "x64", waiting)).toBe(true);
	// wchan 是睡眠 → 不命中
	const sleeping = fakeProc({ ...base, "/proc/200/wchan": "hrtimer_nanosleep" }, links, [
		"100",
		"200",
	]);
	expect(foregroundStdinWait(100, "x64", sleeping)).toBe(false);
	// syscall 可读且是 nanosleep 时，即使 wchan 是 wait_woken 也以 syscall 为准
	const trusted = fakeProc(
		{ ...base, "/proc/200/syscall": "35 0x0 0x0 0x0 0x0 0x55", "/proc/200/wchan": "wait_woken" },
		links,
		["100", "200"],
	);
	expect(foregroundStdinWait(100, "x64", trusted)).toBe(false);
});

test("sessionProcessGroups: 收集会话内所有进程组，包括作业控制下的后台作业", () => {
	// 100 = shell（会话首进程），200 = 前台 cat，300/301 = 后台作业（独立进程组、
	// shell 已退出后被挂到 init 下），400 = tmux 这类 setsid 另开会话的守护进程。
	const proc = fakeProc(
		{
			"/proc/100/stat": SHELL_STAT,
			"/proc/200/stat": "200 (cat) S 100 200 100 34816 200 0",
			"/proc/300/stat": "300 (sleep) S 1 300 100 0 -1 0",
			"/proc/301/stat": "301 (sleep) S 300 300 100 0 -1 0",
			"/proc/400/stat": "400 (tmux: server) S 1 400 400 0 -1 0",
		},
		{},
		["100", "200", "300", "301", "400", "self"],
	);
	expect(sessionProcessGroups(100, proc).sort((a, b) => a - b)).toEqual([100, 200, 300]);
});
