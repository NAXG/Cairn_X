import { readEvidenceInput } from "../../contracts/decide-tools.js";
import { readDecideEvidence } from "../core/decide-evidence.js";
import { z } from "zod";
import { Hono } from "hono";

import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import { decideClaimSchema, decideGraphSchema, heartbeatSchema } from "../models.js";
import { ApiError, utcnow } from "../core/base.js";
import { checkProjectActive, getProjectOr404, requireDecideLease } from "../core/project-guards.js";
import {
	clearProjectDecide,
	expireDecideLeases,
	getDecideTimeout,
	heartbeatIntervalFor,
	leaseDeadline,
} from "../core/lease-expiry.js";
import { projectMetaFromRow } from "../core/model-mappers.js";
import {
	completeDecide,
	beginDecideRead,
	computeDecideTrigger,
	getCheckpoint,
	signalDecideExternal,
} from "../core/decide.js";
import { decideCompleteSchema, decideSignalSchema } from "../models.js";
import { readDecideGraph } from "../core/planning-graph.js";
import { backfillDecideUsage } from "../core/usage-backfill.js";

/**
 * decide 路由的共同前置（须在事务内调用）：项目须活跃、过期租约先回收，
 * 再读出当前租约持有者与项目行。
 */
function beginDecideRoute(db: Db, pid: string) {
	checkProjectActive(db, pid);
	expireDecideLeases(db, pid);
	const row = getProjectOr404(db, pid);
	return { row, current: row.decide_worker };
}

export function decideRoutes(db: Db, dataRoot: string): Hono {
	const app = new Hono();

	/**
	 * Decide 的用量在运行结束时一次性上报，请求失败就永久丢账；会话文件却一直留
	 * 在数据目录里。每个「本项目这一轮已经跑完」的入口都顺手补一次：上报成功的
	 * 文件已有记录会被跳过，只有真正丢账的那几轮才会被写回。
	 */
	const backfill = (projectId: string) => backfillDecideUsage(db, projectId, dataRoot);

	app.post("/projects/:id/decide/claim", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, decideClaimSchema);
		checkProjectActive(db, pid);
		expireDecideLeases(db, pid);
		const row = getProjectOr404(db, pid);
		const current = row.decide_worker;
		if (current !== null && current !== body.worker) {
			throw new ApiError(409, `Project decide is currently claimed by ${current}`);
		}
		if (current === null) {
			// 只有「没有在跑的 decide」（首次规划，或上一轮租约已过期回收）才补账：
			// 正在写的会话文件是部分观测，提前记账会让这一轮结束时的完整上报被
			// source_file 幂等键挡掉。
			backfill(pid);
		}
		if (current === body.worker) {
			// 幂等重申领：返回租约记录的原触发与当前规划版本，不重新计算。
			c.header("X-Lease-Timeout", String(getDecideTimeout(db)));
			return c.json({
				...projectMetaFromRow(row),
				trigger: row.decide_trigger ?? "",
				planning_version: getCheckpoint(db, pid)?.planning_version ?? 0,
			});
		}
		// 触发计算可能写入静默基线：必须在申领写事务之外提交，
		// 否则“无触发”抛错会把基线一并回滚。
		const computed = computeDecideTrigger(db, pid, body.min_interval_seconds);
		if (computed === null) {
			throw new ApiError(409, "No decide trigger; no graph changes since last checkpoint");
		}
		const claim = db.transaction(() => {
			checkProjectActive(db, pid);
			const latest = getProjectOr404(db, pid);
			if (latest.decide_worker !== null)
				throw new ApiError(409, `Project decide is currently claimed by ${latest.decide_worker}`);
			const now = utcnow();
			db.prepare(
				`UPDATE projects
				 SET decide_worker = ?, decide_trigger = ?, decide_started_at = ?, decide_last_heartbeat_at = ?, decide_expires_at = ?
				 WHERE id = ?`,
			).run(body.worker, computed.trigger, now, now, leaseDeadline(getDecideTimeout(db)), pid);
			beginDecideRead(db, pid, body.worker);
			return {
				...projectMetaFromRow(getProjectOr404(db, pid)),
				trigger: computed.trigger,
				planning_version: computed.planningVersion,
			};
		});
		c.header("X-Lease-Timeout", String(getDecideTimeout(db)));
		return c.json(claim.immediate());
	});

	app.post("/projects/:id/decide/graph", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, decideGraphSchema);
		const read = db.transaction(() => {
			requireDecideLease(db, pid, body.worker);
			return readDecideGraph(db, pid, body);
		});
		return c.json(read.immediate());
	});

	app.post("/projects/:id/decide/evidence", async (c) => {
		const body = await parseBody(c, readEvidenceInput.extend({ worker: z.string().trim().min(1) }));
		const { worker, ...input } = body;
		const read = db.transaction(() => readDecideEvidence(db, c.req.param("id"), worker, input));
		return c.json(read.immediate());
	});

	// Decide 成功收尾：CAS 推进 planning_version，只确认该租约最后一次读图的水位。
	// 并发到达的外部变化保留，自身修改按 actor 排除回声。
	app.post("/projects/:id/decide/complete", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, decideCompleteSchema);
		// 这一轮已经跑完（Worker 在收尾时才发 complete），先把可能丢掉的那笔用量
		// 从轨迹补上。补账不参与下面的写事务：项目刚被这一轮达成时 complete 会
		// 因项目不再 active 而 409/403，用量该记的仍然要记上。
		backfill(pid);
		// 回收在事务外落库：后面的 409 不能回滚租约失效和恢复信号。
		expireDecideLeases(db, pid);
		const done = db.transaction(() => {
			checkProjectActive(db, pid);
			const row = getProjectOr404(db, pid);
			if (row.decide_worker !== body.worker) {
				throw new ApiError(409, "Project decide is not claimed by this worker");
			}
			return completeDecide(db, pid, body.worker, body.planning_version, row.decide_trigger);
		});
		return c.json(done.immediate());
	});

	// 外部信号（人工/webhook）：下一次认领以 external_signal 触发一次。
	app.post("/projects/:id/decide/signal", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, decideSignalSchema);
		db.transaction(() => {
			checkProjectActive(db, pid);
			signalDecideExternal(db, pid, body.signal);
		}).immediate();
		return c.body(null, 204);
	});

	app.post("/projects/:id/decide/heartbeat", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, heartbeatSchema);
		const beat = db.transaction(() => {
			const { current } = beginDecideRoute(db, pid);
			if (current === null) {
				throw new ApiError(409, "Project decide is not currently claimed");
			}
			if (current !== body.worker) {
				throw new ApiError(409, `Project decide is currently claimed by ${current}`);
			}
			db.prepare(
				"UPDATE projects SET decide_last_heartbeat_at = ?, decide_expires_at = ? WHERE id = ?",
			).run(utcnow(), leaseDeadline(getDecideTimeout(db)), pid);
			return projectMetaFromRow(getProjectOr404(db, pid));
		});
		c.header("X-Lease-Timeout", String(getDecideTimeout(db)));
		// 心跳间隔与 TTL 解耦（同执行租约），否则调大 decide_timeout 会连带
		// 拉长 decide 的续租频率与取消感知延迟。
		c.header("X-Heartbeat-Interval", String(heartbeatIntervalFor(getDecideTimeout(db))));
		return c.json(beat.immediate());
	});

	app.post("/projects/:id/decide/release", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, heartbeatSchema);
		// release 一定发生在某轮 decide 结束之后，是补账最可靠的入口：项目在这轮
		// 里被达成时下面的 checkProjectActive 会 403，所以补账必须在事务之外先做。
		backfill(pid);
		const release = db.transaction(() => {
			const { row, current } = beginDecideRoute(db, pid);
			if (current === null) {
				return projectMetaFromRow(row);
			}
			if (current !== body.worker) {
				throw new ApiError(409, `Project decide is currently claimed by ${current}`);
			}
			if (getCheckpoint(db, pid)?.last_completed_by !== current) {
				signalDecideExternal(db, pid, "decide_interrupted", current);
			}
			clearProjectDecide(db, pid);
			return projectMetaFromRow(getProjectOr404(db, pid));
		});
		let cleanupToken = false;
		try {
			const result = release.immediate();
			cleanupToken = true;
			return c.json(result);
		} catch (err) {
			const project = db.prepare("SELECT status FROM projects WHERE id = ?").get(pid) as
				{ status: string } | undefined;
			cleanupToken = project?.status === "completed" || project?.status === "stopped";
			throw err;
		} finally {
			// The activity has settled before the dispatcher calls release, even if
			// this project's root goal already completed and the lease was cleared.
			if (
				cleanupToken &&
				db
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_objects'",
					)
					.get() !== undefined
			) {
				db.prepare(
					`DELETE FROM configuration_objects WHERE kind='activity-token'
					 AND json_extract(body,'$.project_id')=? AND json_extract(body,'$.worker')=?`,
				).run(pid, body.worker);
			}
		}
	});

	return app;
}
