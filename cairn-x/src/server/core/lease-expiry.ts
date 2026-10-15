import { cachedPrepare, type Db } from "../db.js";
import { utcnow } from "./base.js";
import { getCheckpoint, signalDecideExternal } from "./decide.js";
import { closeLostExecutionSteps } from "./execution-cascade.js";
import { backfillExecutionUsage } from "./usage-backfill.js";

/**
 * 步骤**租约 TTL**（秒）：心跳缺失多久视为租约过期。注意它与执行预算无关 ——
 * Agent profile 的 run_seconds / harvest_seconds 是另外两个概念，历史上三者
 * 同名，极易混淆。
 */
export function getLeaseTimeout(db: Db): number {
	const row = cachedPrepare(db, "SELECT lease_timeout FROM settings WHERE rowid = 1").get() as {
		lease_timeout: number;
	};
	return row.lease_timeout;
}

export function getDecideTimeout(db: Db): number {
	const row = cachedPrepare(db, "SELECT decide_timeout FROM settings WHERE rowid = 1").get() as {
		decide_timeout: number;
	};
	return row.decide_timeout;
}

/**
 * 心跳间隔默认值（秒）。刻意与租约 TTL 解耦：TTL 决定"多久没续上算掉线"
 * 的容错窗口，间隔只决定续租频率与取消感知延迟。
 */
const DEFAULT_HEARTBEAT_INTERVAL_S = 10;

/** 心跳间隔（秒）：固定短周期，仅保证显著小于 TTL。 */
export function heartbeatIntervalFor(ttlSeconds: number): number {
	return Math.min(DEFAULT_HEARTBEAT_INTERVAL_S, Math.max(2, Math.floor(ttlSeconds / 2)));
}

export function clearProjectDecide(db: Db, projectId: string): void {
	cachedPrepare(
		db,
		`UPDATE projects
		 SET decide_worker = NULL,
		     decide_trigger = NULL,
		     decide_started_at = NULL,
		     decide_last_heartbeat_at = NULL, decide_expires_at = NULL
		 WHERE id = ?`,
	).run(projectId);
}

/** Settings changes apply to subsequent renewals; a granted lease retains its deadline. */
export function expireWorkers(db: Db, projectId?: string): void {
	const filter = projectId === undefined ? "" : " AND project_id = ?";
	const args = projectId === undefined ? [] : [projectId];
	db.transaction(() => {
		// 已经启动的执行租约过期意味着结果未知，不能重新派发同一步骤。
		const now = utcnow();
		const lost = db
			.prepare(
				`SELECT id FROM executions
				WHERE status = 'running' AND EXISTS (
					SELECT 1 FROM steps s WHERE s.project_id = executions.project_id AND s.id = executions.step_id
					AND s.worker = executions.id AND s.lease_version = executions.lease_version AND s.status = 'claimed'
					AND julianday(COALESCE(s.lease_expires_at, datetime(s.last_heartbeat_at, '+' || ? || ' seconds'))) < julianday(?)
				)${filter}`,
			)
			.all(getLeaseTimeout(db), now, ...args) as Array<{ id: string }>;
		db.prepare(
			`UPDATE executions SET status = 'lost', finished_at = ?, error = COALESCE(error, 'Step lease expired')
			WHERE status = 'running' AND EXISTS (
				SELECT 1 FROM steps s WHERE s.project_id = executions.project_id AND s.id = executions.step_id
				AND s.worker = executions.id AND s.lease_version = executions.lease_version AND s.status = 'claimed'
				AND julianday(COALESCE(s.lease_expires_at, datetime(s.last_heartbeat_at, '+' || ? || ' seconds'))) < julianday(?)
			)${filter}`,
		).run(now, getLeaseTimeout(db), now, ...args);
		for (const row of lost) backfillExecutionUsage(db, row.id, now);
		closeLostExecutionSteps(db, now, projectId);
		// 仍在排队、没被 Worker 领走的执行：下面会把它的 Step 重新打开，执行本身
		// 若留在 queued，Worker 再也领不到（租约已易主），调度器却要一直等到截止
		// 时间。这里一并判为未启动的 failed —— 不计入尝试预算，Step 可以直接重派。
		db.prepare(
			`UPDATE executions SET status = 'failed', finished_at = ?,
			 error = COALESCE(error, 'Step lease expired before a worker picked up the execution')
			WHERE status = 'queued' AND EXISTS (
				SELECT 1 FROM steps s WHERE s.project_id = executions.project_id AND s.id = executions.step_id
				AND s.worker = executions.id AND s.lease_version = executions.lease_version AND s.status = 'claimed'
				AND julianday(COALESCE(s.lease_expires_at, datetime(s.last_heartbeat_at, '+' || ? || ' seconds'))) < julianday(?)
			)${filter}`,
		).run(now, getLeaseTimeout(db), now, ...args);
		db.prepare(
			`UPDATE steps SET worker = NULL, status = 'open', lease_expires_at = NULL, lease_version = lease_version + 1
	  WHERE status = 'claimed' AND julianday(COALESCE(lease_expires_at, datetime(last_heartbeat_at, '+' || ? || ' seconds'))) < julianday(?)${filter}`,
		).run(getLeaseTimeout(db), now, ...args);
		// Server and Dispatcher share this WAL database. Acquire the writer lock before
		// reading leases so another connection cannot invalidate the snapshot before UPDATE.
	}).immediate();
}

/**
 * 读路径专用：过期回收节流到最多每 2s 一次（按 db 记时，避免跨测试串扰）。
 * dispatcher 每 3s 一次 GET /projects 会触发全局全表扫描，这里挡掉重复的。
 */
const lastExpireWorkersAt = new WeakMap<Db, Map<string, number>>();
export function expireWorkersThrottled(db: Db, projectId?: string): void {
	// 按范围分别记时：全局回收与各项目回收互不遮挡，A 项目的读不能挡住 B。
	const scope = projectId ?? "*";
	let times = lastExpireWorkersAt.get(db);
	if (times === undefined) lastExpireWorkersAt.set(db, (times = new Map()));
	const now = Date.now();
	if (now - (times.get(scope) ?? 0) < 2_000) return;
	expireWorkers(db, projectId);
	times.set(scope, now);
}

export function expireDecideLeases(db: Db, projectId?: string): void {
	const filter = projectId === undefined ? "" : " AND id = ?";
	db.transaction(() => {
		const expired = db
			.prepare(
				`SELECT id, status, decide_worker FROM projects
			 WHERE decide_worker IS NOT NULL AND julianday(COALESCE(decide_expires_at, datetime(decide_last_heartbeat_at, '+' || ? || ' seconds'))) < julianday(?)${filter}`,
			)
			.all(
				getDecideTimeout(db),
				utcnow(),
				...(projectId === undefined ? [] : [projectId]),
			) as Array<{ id: string; status: string; decide_worker: string }>;
		for (const row of expired) {
			// 改图是逐工具提交；租约失效不意味着半成品计划已验收。
			// 已 complete 但未 release 的租约则不需要重新规划。
			if (
				row.status === "active" &&
				getCheckpoint(db, row.id)?.last_completed_by !== row.decide_worker
			) {
				signalDecideExternal(db, row.id, "decide_interrupted", row.decide_worker);
			}
			clearProjectDecide(db, row.id);
		}
	}).immediate();
}

export function leaseDeadline(seconds: number): string {
	return new Date(Date.now() + seconds * 1000).toISOString();
}
