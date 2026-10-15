/**
 * 中断/失联活动的用量回填。
 *
 * Execute：Worker 在 finalizeWorkerRun 里上报 usage，但被控制端取消（项目完成
 * 统一收尾、步骤/路线放弃、租约过期/截止）的那批执行往往等不到收尾：容器被停掉，
 * token 就永久丢账，StepModel.cost 与 stats 对被取消的步骤显示为「几乎没花钱」，
 * 而它们恰恰是通关瞬间仍在长跑的那批。
 *
 * Decide：用量在运行结束时**一次性**上报，没有任何终态事务兜底 —— 上报请求本身
 * 失败（容器被掐、控制面瞬时不可达、项目刚好切到终态）就永久丢账。它的会话文件
 * 同样逐条落盘，因此控制端可以在「本项目已无在跑的 decide」时按文件补账。
 *
 * 两条路径都读同一批 assistant.usage，幂等键分别是 execution_id 与 trace 文件名；
 * 回填只在没有对应记录时才写，因此不会与 Worker 的迟到上报重复计数。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { SESSION_FILE_PATTERN } from "../../contracts/transcripts.js";
import type { Db } from "../db.js";
import { writeUsageEvent } from "./usage-store.js";
import { consoleLogger } from "../../shared/logger.js";

interface TranscriptUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	model: string | null;
}

const TERMINAL = ["succeeded", "failed", "cancelled", "lost"];
const positiveInt = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** 从一条会话事件里提取 assistant usage；非 assistant 或无 usage 返回 null。 */
export function transcriptUsage(line: string): TranscriptUsage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const message = record.message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return null;
	const msg = message as Record<string, unknown>;
	if (msg.role !== "assistant") return null;
	const usage = msg.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
	const u = usage as Record<string, unknown>;
	const model =
		typeof msg.model === "string"
			? msg.model
			: typeof record.model === "string"
				? record.model
				: null;
	return {
		input: positiveInt(u.input),
		output: positiveInt(u.output),
		cache_read: positiveInt(u.cacheRead),
		cache_write: positiveInt(u.cacheWrite),
		model,
	};
}

/**
 * 为一次执行回填用量。执行非终态、已有 execution_id 记录、或轨迹里没有任何
 * usage 时返回 false（不写零值行，避免把「没跑起来」伪装成「跑了但没花钱」）。
 */
export function backfillExecutionUsage(db: Db, executionId: string, now: string): boolean {
	const existing = db
		.prepare("SELECT 1 AS ok FROM usage_events WHERE execution_id = ?")
		.get(executionId);
	if (existing !== undefined) return false;
	const execution = db
		.prepare("SELECT project_id, step_id, status FROM executions WHERE id = ?")
		.get(executionId) as { project_id: string; step_id: string | null; status: string } | undefined;
	if (execution === undefined || !TERMINAL.includes(execution.status)) return false;
	// 只解析带 usage 的行：一次执行里 assistant 消息是少数，避免全量 JSON.parse。
	const rows = db
		.prepare(`SELECT line FROM execution_events WHERE execution_id = ? AND line LIKE '%"usage"%'`)
		.all(executionId) as Array<{ line: string }>;
	const totals = accumulateUsage(rows.map((row) => row.line));
	if (totals === null) return false;
	db.prepare(
		`INSERT INTO usage_events (project_id, activity, step_id, execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
		 VALUES (?, 'execute', ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		execution.project_id,
		execution.step_id,
		executionId,
		totals.model ?? "unknown",
		totals.input,
		totals.output,
		totals.cache_read,
		totals.cache_write,
		now,
	);
	return true;
}

/**
 * 逐行累加轨迹里的 usage（model 取第一条非空）。一条都没读到、或合计为 0 时
 * 返回 null：调用方据此避免写入「没跑起来」的零值行。
 */
function accumulateUsage(lines: Iterable<string>): TranscriptUsage | null {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let model: string | null = null;
	for (const line of lines) {
		const usage = transcriptUsage(line);
		if (usage === null) continue;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cache_read;
		cacheWrite += usage.cache_write;
		model ??= usage.model;
	}
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
	return { input, output, cache_read: cacheRead, cache_write: cacheWrite, model };
}

/** 一份 Decide 会话轨迹里的用量合计（与 Worker 内存里累计的是同一批数字）。 */
interface DecideUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	model: string | null;
	/** 会话文件最后写入时间：这次运行真实的结束时刻。 */
	ended_at: string;
}

/** 读一个 Decide 会话文件；没有任何 assistant usage 时返回 null（不写零值行）。 */
function decideSessionUsage(filePath: string): DecideUsage | null {
	let raw: string;
	let endedAt: Date;
	try {
		raw = readFileSync(filePath, "utf8");
		endedAt = statSync(filePath).mtime;
	} catch {
		return null;
	}
	// 只解析带 usage 的行：一次 Decide 里 assistant 消息是少数。
	const usage = accumulateUsage(raw.split("\n").filter((line) => line.includes('"usage"')));
	return usage === null ? null : { ...usage, ended_at: endedAt.toISOString() };
}

/**
 * 把一个项目里「跑完但没有记账」的 Decide 会话按轨迹补上用量，返回补了几笔。
 *
 * 只在「本项目已无在跑的 decide」时调用（运行已 release、租约已过期回收、或服务
 * 启动时确认没有活动租约）：正在写的会话文件是一份部分观测，提前记账会让后来
 * 那笔完整上报被幂等键挡掉。已经上报过的文件由 source_file 唯一约束跳过，
 * 因此这个函数可以反复调用。
 */
export function backfillDecideUsage(db: Db, projectId: string, dataRoot: string): number {
	const dir = path.join(dataRoot, projectId, "sessions");
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		// 没有 sessions 目录 = 该项目从未跑过活动，不是错误。
		return 0;
	}
	const known = new Set(
		(
			db
				.prepare(
					"SELECT source_file FROM usage_events WHERE project_id = ? AND source_file IS NOT NULL",
				)
				.all(projectId) as Array<{ source_file: string }>
		).map((row) => row.source_file),
	);
	let written = 0;
	for (const file of files) {
		if (known.has(file) || !file.startsWith("decide-") || !SESSION_FILE_PATTERN.test(file)) {
			continue;
		}
		const usage = decideSessionUsage(path.join(dir, file));
		if (usage === null) continue;
		writeUsageEvent(
			db,
			projectId,
			{
				activity: "decide",
				source_file: file,
				model: usage.model ?? "unknown",
				input_tokens: usage.input,
				output_tokens: usage.output,
				cache_read_tokens: usage.cache_read,
				cache_write_tokens: usage.cache_write,
			},
			// 记会话文件最后写入时间而不是补账时刻：这才是这次运行真正花钱的时间，
			// 启动兜底扫描（可能晚很多）不该把历史用量记到当下。
			usage.ended_at,
		);
		written += 1;
	}
	return written;
}

/**
 * 服务启动时的兜底扫描：分派器可能带着一轮未上报的 decide 一起挂掉，而项目一旦
 * 终态就再也没有认领（认领会 403）来触发补账。跳过仍持有活动 decide 租约的项目
 * ——那说明这一轮还在跑，会话文件还会继续写。
 */
export function backfillDecideUsageOnStartup(db: Db, dataRoot: string, now: string): number {
	const timeout = (
		db.prepare("SELECT decide_timeout FROM settings WHERE rowid = 1").get() as {
			decide_timeout: number;
		}
	).decide_timeout;
	const projects = db
		.prepare(
			`SELECT id FROM projects
			  WHERE decide_worker IS NULL
			     OR julianday(COALESCE(decide_expires_at, datetime(decide_last_heartbeat_at, '+' || ? || ' seconds'))) < julianday(?)`,
		)
		.all(timeout, now) as Array<{ id: string }>;
	let written = 0;
	for (const project of projects) {
		try {
			written += backfillDecideUsage(db, project.id, dataRoot);
		} catch (error) {
			consoleLogger.warn(`decide usage backfill failed for ${project.id}: ${String(error)}`);
		}
	}
	return written;
}
