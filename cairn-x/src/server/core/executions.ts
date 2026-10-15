/**
 * 执行尝试（execution）的服务层：状态机、短期令牌、租约版本校验、
 * 会话事件幂等追加与结果持久化。
 *
 * 一个 execution = 一次 Step 执行尝试：
 * - dispatcher 以 execution_id 作为 worker 身份认领 step，然后调用
 *   createExecution 绑定「本次尝试 ↔ 当前租约版本」；
 * - 项目 Worker 通过 next 原子领取 queued execution，控制端随即签发短期令牌，
 *   Worker 再用它 heartbeat/写证据/报结果；
 * - step 被重新认领后 lease_version 递增，旧 execution 的所有写入
 *   （心跳、事实、结果、模型代理）都会被 403 拒绝。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import type {
	CommittedExecutionResult,
	ExecutionResultBody,
	ExecutionResultAck,
	ExecutionStatus,
	ExecutionView,
	EscalationAck,
} from "../../contracts/execution.js";
import {
	EXECUTION_TERMINAL_STATUSES,
	MAX_EXECUTION_ESCALATIONS,
	parseCommittedExecutionResultJson,
} from "../../contracts/execution.js";
import type { Db } from "../db.js";
import { ApiError, utcnow } from "./base.js";
import { cascadeAbandonBlockedSteps, closeLostExecutionSteps } from "./execution-cascade.js";
import { checkProjectActive, getProjectOr404, getStepOr404 } from "./project-guards.js";
import { leaseDeadline, getLeaseTimeout } from "./lease-expiry.js";
import { signalDecideExternal } from "./decide.js";
import { ESCALATION_DETAIL_PREFIX } from "./decide-changes.js";
import { annotateInterruptedTool } from "./event-search.js";
import { hashToken } from "./tokens.js";
import { concludeStep } from "./steps.js";
import { recordUsage } from "./usage.js";
import { backfillExecutionUsage } from "./usage-backfill.js";

export interface ExecutionRowLike {
	id: string;
	project_id: string;
	step_id: string;
	attempt: number;
	lease_version: number;
	status: ExecutionStatus;
	cancel_requested: number;
	token_hash: string | null;
	created_at: string;
	started_at: string | null;
	last_heartbeat_at: string | null;
	lease_expires_at: string | null;
	deadline_at: string | null;
	finished_at: string | null;
	result_outcome: string | null;
	summary: string | null;
	error: string | null;
	exit_code: number | null;
	dropped_events: number;
}

/** 非抛异常的 execution 查找：幂等创建需要区分「不存在」与「读取失败」。 */
function findExecutionRow(db: Db, executionId: string): ExecutionRowLike | undefined {
	return db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId) as
		ExecutionRowLike | undefined;
}

export function getExecutionRow(db: Db, executionId: string): ExecutionRowLike {
	const row = findExecutionRow(db, executionId);
	if (row === undefined) {
		throw new ApiError(404, "Execution not found");
	}
	return row;
}

/** 由已存行反推本次执行的总预算（秒）；与 executionToView 的口径一致。 */
function storedDeadlineSeconds(row: ExecutionRowLike): number {
	return Math.max(
		0,
		Math.round((Date.parse(row.deadline_at ?? "") - Date.parse(row.created_at)) / 1000) || 0,
	);
}

export function executionToView(db: Db, row: ExecutionRowLike): ExecutionView {
	const sessionSeq = (
		db.prepare("SELECT MAX(seq) AS s FROM execution_events WHERE execution_id = ?").get(row.id) as {
			s: number | null;
		}
	).s;
	return {
		id: row.id,
		project_id: row.project_id,
		step_id: row.step_id,
		attempt: row.attempt,
		lease_version: row.lease_version,
		status: row.status,
		cancel_requested: row.cancel_requested === 1,
		created_at: row.created_at,
		started_at: row.started_at,
		heartbeat_at: row.last_heartbeat_at,
		finished_at: row.finished_at,
		deadline_at: row.deadline_at,
		result_outcome: row.result_outcome,
		result: getCommittedExecutionResult(db, row.id),
		summary: row.summary,
		error: row.error,
		exit_code: row.exit_code,
		dropped_events: row.dropped_events ?? 0,
		session_seq: sessionSeq ?? 0,
	};
}

/** 读取已提交的结构化结果；无记录时返回 null。 */
function getCommittedExecutionResult(db: Db, executionId: string): CommittedExecutionResult | null {
	const row = db
		.prepare("SELECT payload FROM execution_results WHERE execution_id = ?")
		.get(executionId) as { payload: string } | undefined;
	if (row === undefined) return null;
	return parseCommittedExecutionResultJson(row.payload);
}

/** 模型只交业务结论；产出清单必须由控制端按 execution_id 权威生成。 */
function compileExecutionResult(
	db: Db,
	row: ExecutionRowLike,
	body: NonNullable<ExecutionResultBody["result"]>,
): CommittedExecutionResult {
	const ids = (table: "facts" | "findings"): string[] =>
		(
			db
				.prepare(`SELECT id FROM ${table} WHERE project_id = ? AND execution_id = ? ORDER BY rowid`)
				.all(row.project_id, row.id) as Array<{ id: string }>
		).map(({ id }) => id);
	return {
		schema_version: 1,
		task_status: body.task_status,
		summary: body.summary.trim(),
		unresolved: [...body.unresolved],
		produced: {
			fact_ids: ids("facts"),
			finding_ids: ids("findings"),
		},
	};
}

/**
 * dispatcher 创建一次执行尝试：要求 step 已由 execution_id 认领
 * （租约绑定），attempt 自增并建立 queued execution；短期令牌在项目 Worker
 * 领取任务时才签发。
 *
 * **幂等**：同一个 execution_id 只创建一次。dispatcher 在响应丢失后会重发
 * 同一个 POST（见 scheduler/execute.ts 的重试），重复请求必须回放首次创建
 * 的结果，而不是报错或再插一行；只有 project/step 与首次不一致才是 409。
 */
export function createExecution(
	db: Db,
	body: { project_id: string; step_id: string; execution_id: string },
	deadlineSeconds?: number,
): {
	id: string;
	attempt: number;
	lease_version: number;
	deadline_at: string;
	/** 本次执行的总预算（秒）；项目 Worker 领取任务时用于启动预算校验。 */
	deadline_seconds: number;
	/** true = 命中既有记录（幂等重放），本次没有写入任何状态。 */
	replayed: boolean;
} {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.execution_id)) {
		throw new ApiError(400, "execution_id must be a uuid");
	}
	// 重放检查必须早于租约校验：响应丢失后的重发可能发生在 Worker 已领取
	// （甚至执行已终态、Step 租约已释放）之后，此时再校验租约会把一次成功的
	// 创建误判为冲突。
	const existing = findExecutionRow(db, body.execution_id);
	if (existing !== undefined) {
		if (existing.project_id !== body.project_id || existing.step_id !== body.step_id) {
			throw new ApiError(409, `execution_id ${body.execution_id} already belongs to another step`);
		}
		const storedBudget = storedDeadlineSeconds(existing);
		return {
			id: existing.id,
			attempt: existing.attempt,
			lease_version: existing.lease_version,
			deadline_at: existing.deadline_at ?? leaseDeadline(deadlineSeconds ?? 3600),
			deadline_seconds: storedBudget > 0 ? storedBudget : (deadlineSeconds ?? 3600),
			replayed: true,
		};
	}
	getProjectOr404(db, body.project_id);
	const step = getStepOr404(db, body.project_id, body.step_id);
	if (step.status !== "claimed" || step.worker !== body.execution_id) {
		throw new ApiError(
			409,
			`Step lease must be claimed by the execution (step worker=${step.worker ?? "null"}, execution=${body.execution_id})`,
		);
	}
	const attempt =
		(
			db
				.prepare(
					"SELECT COALESCE(MAX(attempt), 0) AS n FROM executions WHERE project_id = ? AND step_id = ?",
				)
				.get(body.project_id, body.step_id) as { n: number }
		).n + 1;
	const budgetSeconds = deadlineSeconds ?? 3600;
	const deadlineAt = leaseDeadline(budgetSeconds);
	db.prepare(
		`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, cancel_requested, token_hash, created_at, deadline_at)
		 VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?)`,
	).run(
		body.execution_id,
		body.project_id,
		body.step_id,
		attempt,
		step.lease_version,
		utcnow(),
		deadlineAt,
	);
	return {
		id: body.execution_id,
		attempt,
		lease_version: step.lease_version,
		deadline_at: deadlineAt,
		deadline_seconds: budgetSeconds,
		replayed: false,
	};
}

/** 通过短期令牌解析 execution（所有 Worker 接口的身份入口）。 */
export function requireExecutionByToken(db: Db, token: string | undefined): ExecutionRowLike {
	if (!token) {
		throw new ApiError(401, "Execution token required");
	}
	const row = db.prepare("SELECT * FROM executions WHERE token_hash = ?").get(hashToken(token)) as
		Record<string, unknown> | undefined;
	if (row === undefined) {
		throw new ApiError(401, "Invalid execution token");
	}
	return row as unknown as ExecutionRowLike;
}

function requireTerminalOrAlive(row: ExecutionRowLike): void {
	if (EXECUTION_TERMINAL_STATUSES.includes(row.status)) {
		throw new ApiError(403, `Execution is ${row.status}; its credentials are revoked`);
	}
}

/**
 * 校验执行仍然有效：非终态 + step 租约仍由本 execution 持有（worker
 * 身份与租约版本都匹配）。租约被重新认领或释放后，旧执行者的一切
 * 写入都在这里被拒绝。
 */
export function requireExecutionAlive(db: Db, row: ExecutionRowLike): void {
	row = getExecutionRow(db, row.id);
	requireTerminalOrAlive(row);
	const step = getStepOr404(db, row.project_id, row.step_id);
	if (
		step.status !== "claimed" ||
		step.worker !== row.id ||
		step.lease_version !== row.lease_version
	) {
		throw new ApiError(409, "Execution lease version is stale; writes rejected");
	}
	if (
		(row.deadline_at !== null && Date.parse(row.deadline_at) <= Date.now()) ||
		(row.lease_expires_at !== null && Date.parse(row.lease_expires_at) <= Date.now()) ||
		(step.status === "claimed" &&
			step.lease_expires_at !== null &&
			Date.parse(step.lease_expires_at) <= Date.now())
	) {
		throw new ApiError(409, "Execution lease expired");
	}
}

/** Worker 领取任务：queued → running。重复领取（幂等）返回已运行状态。 */
function claimExecution(db: Db, row: ExecutionRowLike, leaseTimeoutSeconds: number): void {
	requireExecutionAlive(db, row);
	const now = utcnow();
	const deadline = leaseDeadline(leaseTimeoutSeconds);
	db.transaction(() => {
		db.prepare(
			"UPDATE executions SET status = 'running', started_at = COALESCE(started_at, ?), last_heartbeat_at = ?, lease_expires_at = ? WHERE id = ?",
		).run(now, now, deadline, row.id);
		db.prepare(
			"UPDATE steps SET last_heartbeat_at = ?, lease_expires_at = ? WHERE project_id = ? AND id = ?",
		).run(now, deadline, row.project_id, row.step_id);
	})();
}

/** Worker 心跳同时续租 execution 与 Step；已失效的租约不能复活。 */
export function heartbeatExecution(db: Db, row: ExecutionRowLike): void {
	claimExecution(db, row, getLeaseTimeout(db));
}

export function listQueuedExecutions(db: Db, projectId: string): ExecutionRowLike[] {
	return db
		.prepare(
			"SELECT * FROM executions WHERE project_id = ? AND status = 'queued' ORDER BY created_at, id",
		)
		.all(projectId) as unknown as ExecutionRowLike[];
}

interface ClaimedQueuedExecution {
	row: ExecutionRowLike;
	token: string;
}

/**
 * 原子地领取 queued execution 并签发执行令牌。被并发循环领走或租约已失效
 * （被重认领/回收）时返回 undefined，调用方顺延到下一个候选。
 * 调用方必须已成功组装任务载荷；领取后不会再执行可能失败的组装步骤。
 */
export function claimQueuedExecution(
	db: Db,
	projectId: string,
	executionId: string,
): ClaimedQueuedExecution | undefined {
	return db
		.transaction(() => {
			const row = db
				.prepare("SELECT * FROM executions WHERE id = ? AND project_id = ? AND status = 'queued'")
				.get(executionId, projectId) as Record<string, unknown> | undefined;
			if (row === undefined) return undefined;
			try {
				claimExecution(db, row as unknown as ExecutionRowLike, getLeaseTimeout(db));
			} catch (err) {
				if (err instanceof ApiError) return undefined;
				throw err;
			}
			const token = randomBytes(32).toString("hex");
			db.prepare("UPDATE executions SET token_hash = ? WHERE id = ?").run(
				hashToken(token),
				executionId,
			);
			return { row: getExecutionRow(db, executionId), token };
		})
		.immediate();
}

/** 控制端状态迁移（controller actor）：启动失败 / 超时失联 / 强制取消。 */
export function transitionExecution(
	db: Db,
	row: ExecutionRowLike,
	next: Exclude<ExecutionStatus, "succeeded" | "running">,
	extra: { error?: string | null; exit_code?: number | null; leaseTimeoutSeconds?: number } = {},
): void {
	const allowed: Record<string, ExecutionStatus[]> = {
		queued: ["failed", "cancelled", "lost"],
		running: ["cancelled", "lost"],
	};
	const from = row.status;
	if (!allowed[from]?.includes(next)) {
		throw new ApiError(409, `Illegal execution transition ${from} -> ${next}`);
	}
	const now = utcnow();
	db.transaction(() => {
		// 带上原状态做 CAS：调用方读到的行可能已被并发的收尾或回收推进到终态。
		const changed = db
			.prepare(
				`UPDATE executions SET status = ?, finished_at = ?, error = COALESCE(?, error), exit_code = COALESCE(?, exit_code) WHERE id = ? AND status = ?`,
			)
			.run(next, now, extra.error ?? null, extra.exit_code ?? null, row.id, from).changes;
		if (changed === 0) {
			throw new ApiError(409, `Execution ${row.id} is no longer ${from}`);
		}
		// 强制终态时 Worker 已来不及上报用量：从已持久化的轨迹回填，否则这次执行
		// 在成本视图里不存在（其余终态路径都会回填）。
		backfillExecutionUsage(db, row.id, now);
		if (next === "lost") closeLostExecutionSteps(db, now, row.project_id);
	})();
}

/** 取消请求：非终态时打标（Worker 心跳可见）；已终态则忽略（幂等）。 */
export function requestCancel(db: Db, row: ExecutionRowLike): ExecutionView {
	if (!EXECUTION_TERMINAL_STATUSES.includes(row.status)) {
		db.prepare("UPDATE executions SET cancel_requested = 1 WHERE id = ?").run(row.id);
	}
	return executionToView(db, getExecutionRow(db, row.id));
}

/** 同名环境变量覆盖最大 Step 尝试次数；默认 3。 */
const MAX_STEP_ATTEMPTS = (() => {
	const parsed = Number.parseInt(process.env.CAIRN_MAX_STEP_ATTEMPTS ?? "3", 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 3;
})();

/**
 * 连续失败达到上限后关闭 Step，避免 dispatcher 无上限重试同一动作。
 * 只关闭仍由本次 execution 持有的租约，已完成/被接管/被人工处理时不介入。
 */
function abandonExhaustedStep(db: Db, row: ExecutionRowLike): boolean {
	// attempt 是不可回退的审计序号，不是业务重试预算。queued → failed
	// 表示控制端准备失败：Worker 尚未 claim，也没有提交结果；仅排除这种尝试。
	// 已启动的失败（包括端点失败）、取消等保持原有计数语义，历史行保守计数。
	const attempts = (
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM executions WHERE project_id = ? AND step_id = ?
			 AND NOT (status = 'failed' AND started_at IS NULL AND result_outcome IS NULL)`,
			)
			.get(row.project_id, row.step_id) as { n: number }
	).n;
	if (attempts < MAX_STEP_ATTEMPTS) return false;
	const now = utcnow();
	const summary =
		"已达最大尝试次数 " +
		MAX_STEP_ATTEMPTS +
		"，自动放弃；副作用与结果未知，请先核对现有证据再决定替代步骤。";
	const changed = db
		.prepare(
			"UPDATE steps SET status = 'abandoned', worker = NULL, lease_expires_at = NULL, " +
				"lease_version = lease_version + 1, concluded_at = ?, summary = ? " +
				"WHERE project_id = ? AND id = ? AND worker = ? AND lease_version = ? AND status = 'claimed'",
		)
		.run(now, summary, row.project_id, row.step_id, row.id, row.lease_version).changes;
	if (changed === 0) return false;
	cascadeAbandonBlockedSteps(db, row.project_id, now);
	return true;
}

/**
 * Worker 结果上报（持久化确认）：
 * - running：写入终态并确认（committed=true）；
 * - 已终态且取向一致：幂等确认（committed=false）；
 * - 已终态且取向不同：409 携带当前状态（迟到结果，不得改写终态）。
 */
export function applyExecutionResult(
	db: Db,
	row: ExecutionRowLike,
	body: ExecutionResultBody,
): ExecutionResultAck {
	return db.transaction((): ExecutionResultAck => {
		row = getExecutionRow(db, row.id);
		if (EXECUTION_TERMINAL_STATUSES.includes(row.status)) {
			if (row.status === body.outcome) {
				const storedResult = getCommittedExecutionResult(db, row.id);
				return {
					committed: false,
					status: row.status,
					...(storedResult === null ? {} : { result: storedResult }),
				};
			}
			throw new ApiError(409, `Execution already ${row.status}; late result not applied`);
		}
		requireExecutionAlive(db, row);
		if (row.status !== "running") {
			throw new ApiError(409, `Execution is ${row.status}; result only accepted while running`);
		}
		const result = body.result;
		const summary = result?.summary ?? null;
		if (body.outcome === "succeeded") {
			if (result === undefined)
				throw new ApiError(400, "Successful execution requires a structured result");
			// Step 与 Execution 在同一事务内收尾；重复提交由上面的终态检查拦下。
			concludeStep(db, row.project_id, row.step_id, row.id, result.summary, true);
		}
		let committedResult: CommittedExecutionResult | null = null;
		if (result !== undefined) {
			committedResult = compileExecutionResult(db, row, result);
			db.prepare(
				"INSERT INTO execution_results (execution_id, schema_version, payload, created_at) VALUES (?, 1, ?, ?)",
			).run(row.id, JSON.stringify(committedResult), utcnow());
		}
		if (body.usage) {
			recordUsage(db, row.project_id, {
				...body.usage,
				activity: "execute",
				step_id: row.step_id,
				execution_id: row.id,
			});
		}
		db.prepare(
			"UPDATE executions SET status = ?, result_outcome = ?, summary = ?, error = ?, dropped_events = ?, finished_at = ? WHERE id = ?",
		).run(
			body.outcome,
			body.outcome,
			summary,
			body.error ?? null,
			Math.max(0, Math.floor(body.dropped_events ?? 0)),
			utcnow(),
			row.id,
		);
		if (body.outcome === "failed") {
			const exhausted = abandonExhaustedStep(db, row);
			// 未耗尽的失败也交回一次规划机会：失败尝试抢救出的事实正是
			// 「继续重试还是换路」的判断依据。信号不加派发屏障、不拦截重试
			// —— 步骤未被关闭（调度器释放后回到 open 可重试），Decide 认为
			// 该放弃时再显式 abandon。
			if (getProjectOr404(db, row.project_id).status === "active") {
				signalDecideExternal(
					db,
					row.project_id,
					exhausted ? "step_failed" : "step_attempt_failed",
					null,
					row.step_id,
				);
			}
		}
		return {
			committed: true,
			status: body.outcome,
			...(committedResult === null ? {} : { result: committedResult }),
		};
	})();
}

/** 执行者升级上报的 operation 标记。 */
const ESCALATION_OPERATION = "escalate";

/**
 * 执行者上报「当前计划的前提已经不成立」，立刻唤醒规划器。
 *
 * 语义是通知而不是中断：当前步骤继续跑，规划器在下一个节拍带着新证据重规划。
 * 同一 execution 的重复理由只记一次，累计到 {@link MAX_EXECUTION_ESCALATIONS}
 * 后拒绝——上限与去重共同保证单个执行者无法把规划器拉成热循环。返回 ack 是为了
 * 让模型知道自己有没有被听见，否则它会反复重发同一条上报。
 */
export function escalateFromExecution(
	db: Db,
	execution: ExecutionRowLike,
	reason: string,
): EscalationAck {
	const trimmed = reason.trim();
	if (trimmed === "") throw new ApiError(400, "Escalation reason must not be empty");
	// 身份使用完整原文；500 字的可见预算只在规划/触发投影层应用。
	// 旧记录可能已截断，只能与其现存文字精确比较，不能推断或补回丢失的尾部。
	const detail = `${ESCALATION_DETAIL_PREFIX}${trimmed}`;
	return db.transaction((): EscalationAck => {
		// The route awaits the body after authentication; write authority may have expired since.
		requireExecutionAlive(db, execution);
		// 已停止/已达成的项目不会被调度器认领，信号只会留在库里成噪声。
		checkProjectActive(db, execution.project_id);
		const previous = db
			.prepare(
				`SELECT detail FROM decide_changes
				 WHERE project_id = ? AND kind = 'signal' AND operation = ? AND actor = ?
				 ORDER BY seq`,
			)
			.all(execution.project_id, ESCALATION_OPERATION, execution.id) as Array<{
			detail: string;
		}>;
		const limit = MAX_EXECUTION_ESCALATIONS;
		if (previous.some((row) => row.detail === detail))
			return { status: "duplicate", accepted: false, count: previous.length, limit };
		if (previous.length >= limit)
			return { status: "limit_reached", accepted: false, count: previous.length, limit };
		signalDecideExternal(
			db,
			execution.project_id,
			detail,
			execution.id,
			execution.step_id,
			ESCALATION_OPERATION,
		);
		return { status: "accepted", accepted: true, count: previous.length + 1, limit };
	})();
}

/** 会话事件幂等追加：seq 必须严格递增；回退/重复行被忽略，空洞直接接受（不阻塞重传）。 */
export function appendExecutionEvents(
	db: Db,
	row: ExecutionRowLike,
	events: Array<{ seq: number; line: string }>,
): { session_seq: number; applied: number } {
	requireExecutionAlive(db, row);
	const insert = db.prepare(
		"INSERT OR IGNORE INTO execution_events (execution_id, seq, line) VALUES (?, ?, ?)",
	);
	for (const event of events) {
		if (!Number.isSafeInteger(event.seq) || event.seq < 1)
			throw new ApiError(400, "event seq must be a positive integer");
		if (
			typeof event.line !== "string" ||
			event.line.length === 0 ||
			event.line.length > 8_000_000
		) {
			throw new ApiError(400, "event line must be a non-empty string up to 8MB");
		}
	}
	// 先校验整批再统一落库：避免后半批非法时前半批已提交，造成无法重试的脏批次。
	return db.transaction(() => {
		const current =
			(
				db
					.prepare("SELECT MAX(seq) AS s FROM execution_events WHERE execution_id = ?")
					.get(row.id) as { s: number | null }
			).s ?? 0;
		let maxSeq = current;
		let applied = 0;
		for (const event of events) {
			if (event.seq <= current) continue;
			applied += insert.run(row.id, event.seq, event.line).changes;
			if (event.seq > maxSeq) maxSeq = event.seq;
		}
		return { session_seq: maxSeq, applied };
	})();
}

/**
 * 执行终态后把会话事件落盘为控制台可读的 session JSONL
 * （<dataRoot>/<projectId>/sessions/execute-<step>-<attempt>-<ts>.jsonl）。
 * 第一行是 {"type":"session"} 头（与 SessionManager 格式一致），其后是
 * Worker 流式上报的原始事件行。幂等：重复调用不会产生重复文件。
 */
export function flushExecutionEvents(
	db: Db,
	row: ExecutionRowLike,
	dataRoot: string,
): string | null {
	const finished = row.finished_at;
	if (finished === null) {
		return null;
	}
	const dir = path.join(dataRoot, row.project_id, "sessions");
	mkdirSync(dir, { recursive: true });
	const stamp = finished.replaceAll(/[:.]/g, "-");
	const file = path.join(dir, `execute-${row.step_id}-a${row.attempt}-${stamp}.jsonl`);
	if (existsSync(file)) {
		return file;
	}
	const lines = db
		.prepare("SELECT line FROM execution_events WHERE execution_id = ? ORDER BY seq")
		.all(row.id) as Array<{ line: string }>;
	if (lines.length === 0) {
		return null;
	}
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: `exec-${row.id}`,
		timestamp: row.created_at,
		cwd: "/workspace",
	});
	const payload = [header, ...lines.map((l) => l.line)].join("\n") + "\n";
	const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, payload, { flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
	return file;
}

export function listActiveExecutions(db: Db): ExecutionRowLike[] {
	const rows = db
		.prepare("SELECT * FROM executions WHERE status IN ('queued','running') ORDER BY created_at")
		.all() as unknown as ExecutionRowLike[];
	return rows;
}

/** 供 reaper：截止时间已过 → lost（Worker 失联/超时的控制端权威兜底）。 */
export function reapExpiredExecutions(
	db: Db,
	nowIso: string,
): Array<{ id: string; project_id: string }> {
	return db
		.transaction(() => {
			// 逐行更新（而不是一条批量 UPDATE）：lost 的 error 需要带上「中断时卡在哪个
			// 工具上」——那要从该执行的轨迹里反推，批量语句做不到。
			const expired = db
				.prepare(
					`SELECT id, project_id FROM executions
				 WHERE status IN ('queued','running') AND deadline_at IS NOT NULL AND deadline_at < ?`,
				)
				.all(nowIso) as Array<{ id: string; project_id: string }>;
			const update = db.prepare(
				`UPDATE executions SET status = 'lost', finished_at = ?, error = COALESCE(error, ?)
			 WHERE id = ? AND status IN ('queued','running') AND deadline_at IS NOT NULL AND deadline_at < ?`,
			);
			const reaped: Array<{ id: string; project_id: string }> = [];
			for (const row of expired) {
				const result = update.run(
					nowIso,
					annotateInterruptedTool(db, row.id, "deadline exceeded or heartbeat lost"),
					row.id,
					nowIso,
				);
				if (result.changes > 0) reaped.push(row);
			}
			for (const projectId of new Set(reaped.map((row) => row.project_id)))
				closeLostExecutionSteps(db, nowIso, projectId);
			return reaped;
		})
		.immediate();
}
