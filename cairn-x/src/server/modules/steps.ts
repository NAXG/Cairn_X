import { replayDecideCreation } from "../core/decide-mutations.js";
import { Hono } from "hono";
import { concludeStep } from "../core/steps.js";
import { hasPendingStepResultBarrier } from "../core/decide.js";
import { requireConcludedDependencies } from "../core/scheduling.js";

import type { Db } from "../db.js";
import { parseBody } from "../http.js";
import {
	abandonStepSchema,
	concludeStepSchema,
	createStepSchema,
	heartbeatSchema,
	updateStepPrioritySchema,
} from "../models.js";
import { ApiError, utcnow } from "../core/base.js";
import { nextStepId } from "../core/ids.js";
import {
	checkProjectActive,
	getClaimableOpenStepOr404,
	getGoalOr404,
	getProjectOr404,
	getRouteOr404,
	requireStepLease,
	requireGraphWriter,
	getStepOr404,
	validateFactsExist,
	validateGoalNotInSources,
	validateStepCreatorWorker,
} from "../core/project-guards.js";
import {
	expireDecideLeases,
	expireWorkers,
	getLeaseTimeout,
	leaseDeadline,
} from "../core/lease-expiry.js";
import { cancelStepExecutions, cascadeAbandonBlockedSteps } from "../core/execution-cascade.js";
import { stepToModel } from "../core/model-mappers.js";

export function stepRoutes(db: Db): Hono {
	const app = new Hono();

	app.post("/projects/:id/steps", async (c) => {
		const pid = c.req.param("id");
		const body = await parseBody(c, createStepSchema);
		const create = db.transaction(() =>
			replayDecideCreation(db, pid, body.decide_worker, body.request_id, "add_step", body, () => {
				requireGraphWriter(db, pid, { worker: body.decide_worker, actor: body.actor });
				validateGoalNotInSources(body.from);
				validateFactsExist(db, pid, body.from);
				validateStepCreatorWorker(body.creator, body.worker);
				if (body.goal_id != null) {
					getGoalOr404(db, pid, body.goal_id);
				}
				if (body.route_id != null) {
					getRouteOr404(db, pid, body.route_id);
				}
				// 依赖必须指向同项目的既有步骤；自依赖不可能（id 在此处才生成），
				// 且 id 单调递增保证不会出现环。
				for (const dep of body.waiting_on ?? []) {
					const dependency = getStepOr404(db, pid, dep);
					if (dependency.status === "abandoned")
						throw new ApiError(409, `Cannot wait on abandoned step ${dep}`);
				}
				// 与进行中步骤逐字重复的描述直接拒绝，防止 Decide 重复创建同一动作。
				const duplicate = db
					.prepare(
						"SELECT id, status FROM steps WHERE project_id = ? AND status IN ('open', 'claimed') AND trim(description) = trim(?)",
					)
					.get(pid, body.description) as { id: string; status: string } | undefined;
				if (duplicate !== undefined) {
					throw new ApiError(
						409,
						`Step ${duplicate.id} with identical description is already ${duplicate.status}`,
					);
				}
				const now = utcnow();
				const sid = nextStepId(db, pid);
				const claimed = body.worker != null;
				db.prepare(
					`INSERT INTO steps (id, project_id, description, priority, goal_id, route_id, status, creator, worker, waiting_on, last_heartbeat_at, created_at, concluded_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				).run(
					sid,
					pid,
					body.description,
					body.priority ?? 0,
					body.goal_id ?? null,
					body.route_id ?? null,
					claimed ? "claimed" : "open",
					body.creator,
					body.worker ?? null,
					body.waiting_on !== undefined && body.waiting_on.length > 0
						? JSON.stringify(body.waiting_on)
						: null,
					claimed ? now : null,
					now,
				);
				for (const fid of body.from) {
					db.prepare(
						"INSERT INTO step_sources (step_id, project_id, fact_id) VALUES (?, ?, ?)",
					).run(sid, pid, fid);
				}
				if (claimed)
					db.prepare("UPDATE steps SET lease_expires_at = ? WHERE id = ? AND project_id = ?").run(
						leaseDeadline(getLeaseTimeout(db)),
						sid,
						pid,
					);
				return stepToModel(db, getStepOr404(db, pid, sid), pid);
			}),
		);
		const result = create.immediate();
		return c.json(result.data, result.replayed ? 200 : 201);
	});

	for (const operation of ["claim", "heartbeat"] as const) {
		app.post(`/projects/:id/steps/:sid/${operation}`, async (c) => {
			const pid = c.req.param("id");
			const sid = c.req.param("sid");
			const body = await parseBody(c, heartbeatSchema);
			if (operation === "claim") {
				checkProjectActive(db, pid);
				expireWorkers(db, pid);
				expireDecideLeases(db, pid);
			}
			const beat = db.transaction(() => {
				checkProjectActive(db, pid);
				let repeatedClaim = false;
				if (operation === "claim") {
					const target = getClaimableOpenStepOr404(db, pid, sid, body.worker, false);
					repeatedClaim = target.status === "claimed" && target.worker === body.worker;
					if (!repeatedClaim) {
						const project = getProjectOr404(db, pid);
						if (project.decide_worker !== null) {
							throw new ApiError(409, "Decide is running; new steps cannot be claimed");
						}
						if (hasPendingStepResultBarrier(db, pid)) {
							throw new ApiError(
								409,
								"Decide must process the latest completed step before new work is claimed",
							);
						}
						requireConcludedDependencies(db, pid, sid);
					}
				} else requireStepLease(db, pid, sid, body.worker);
				db.prepare(
					"UPDATE steps SET worker = ?, status = 'claimed', last_heartbeat_at = ?, lease_expires_at = ?, lease_version = lease_version + ? WHERE id = ? AND project_id = ?",
				).run(
					body.worker,
					utcnow(),
					leaseDeadline(getLeaseTimeout(db)),
					operation === "claim" && !repeatedClaim ? 1 : 0,
					sid,
					pid,
				);
				return stepToModel(db, getStepOr404(db, pid, sid), pid);
			});
			c.header("X-Lease-Timeout", String(getLeaseTimeout(db)));
			return c.json(beat.immediate());
		});
	}

	app.post("/projects/:id/steps/:sid/release", async (c) => {
		const pid = c.req.param("id");
		const sid = c.req.param("sid");
		const body = await parseBody(c, heartbeatSchema);
		const release = db.transaction(() => {
			checkProjectActive(db, pid);
			const row = getClaimableOpenStepOr404(db, pid, sid, body.worker);
			if (row.worker === body.worker) {
				db.prepare(
					"UPDATE steps SET worker = NULL, status = 'open', lease_expires_at = NULL, lease_version = lease_version + 1 WHERE id = ? AND project_id = ? AND worker = ? AND lease_version = ?",
				).run(sid, pid, body.worker, row.lease_version);
			}
			return stepToModel(db, getStepOr404(db, pid, sid), pid);
		});
		return c.json(release.immediate());
	});

	app.post("/projects/:id/steps/:sid/conclude", async (c) => {
		const pid = c.req.param("id");
		const sid = c.req.param("sid");
		const body = await parseBody(c, concludeStepSchema);
		return c.json({ step: concludeStep(db, pid, sid, body.worker, body.description) });
	});

	app.post("/projects/:id/steps/:sid/abandon", async (c) => {
		const pid = c.req.param("id");
		const sid = c.req.param("sid");
		const body = await parseBody(c, abandonStepSchema);
		const abandon = db.transaction(() => {
			checkProjectActive(db, pid);
			expireWorkers(db, pid);
			expireDecideLeases(db, pid);
			const row = getStepOr404(db, pid, sid);
			if (row.status === "concluded") {
				throw new ApiError(409, "Step already concluded");
			}
			if (row.status === "abandoned") {
				throw new ApiError(409, "Step already abandoned");
			}
			const project = getProjectOr404(db, pid);
			const isClaimer = row.worker !== null && row.worker === body.worker;
			const holdsDecideLease =
				project.decide_worker !== null && project.decide_worker === body.worker;
			if (holdsDecideLease) requireGraphWriter(db, pid, { worker: body.worker });
			if (!isClaimer && !holdsDecideLease) {
				if (row.worker !== null) {
					throw new ApiError(409, `Step is currently claimed by ${row.worker}`);
				}
				throw new ApiError(409, "Step is not claimed and caller does not hold the decide lease");
			}
			const executing = db
				.prepare("SELECT id FROM executions WHERE project_id=? AND status IN ('queued','running')")
				.all(pid) as Array<{ id: string }>;
			const now = utcnow();
			db.prepare(
				// concluded_at 兼作记录的关闭时间：dashboard 时间线靠它生成
				// 「放弃」事件（status=abandoned 时渲染为 step-abandoned）。
				// lease_version 递增：任何改变 worker 归属的写入都要作废在途执行者的
				// 写入资格，与 release / 过期回收路径保持一致（否则租约代数会出现断层）。
				"UPDATE steps SET status = 'abandoned', worker = NULL, last_heartbeat_at = NULL, summary = ?, concluded_at = ?, lease_version = lease_version + 1 WHERE id = ? AND project_id = ?",
			).run(body.reason ?? null, now, sid, pid);
			// 放弃必须同时终结在途执行：否则它会被 activity guard 掐断模型流，
			// 之后结果上报与事件上传全被 409 拒绝，只能等 deadline 判 lost。
			cancelStepExecutions(db, pid, sid, now);
			const cascaded = cascadeAbandonBlockedSteps(
				db,
				pid,
				now,
				holdsDecideLease ? body.worker : null,
			);
			const abandoned = [sid, ...cascaded];
			const cancelled = db
				.prepare(
					"SELECT id FROM executions WHERE project_id=? AND status='cancelled' AND id IN (SELECT value FROM json_each(?)) ORDER BY id",
				)
				.all(pid, JSON.stringify(executing.map((e) => e.id))) as Array<{ id: string }>;
			return {
				...stepToModel(db, getStepOr404(db, pid, sid), pid),
				effects: {
					abandoned_step_ids: abandoned.slice(0, 20),
					abandoned_step_count: abandoned.length,
					cancelled_execution_ids: cancelled.slice(0, 20).map((e) => e.id),
					cancelled_execution_count: cancelled.length,
					truncated: abandoned.length > 20 || cancelled.length > 20,
				},
			};
		});
		return c.json(abandon.immediate());
	});

	app.patch("/projects/:id/steps/:sid/priority", async (c) => {
		const pid = c.req.param("id");
		const sid = c.req.param("sid");
		const body = await parseBody(c, updateStepPrioritySchema);
		const update = db.transaction(() => {
			requireGraphWriter(db, pid, body);
			const step = getStepOr404(db, pid, sid);
			if (step.status !== "open") throw new ApiError(409, "Only open steps can change priority");
			db.prepare("UPDATE steps SET priority = ? WHERE id = ? AND project_id = ?").run(
				body.priority,
				sid,
				pid,
			);
			return stepToModel(db, getStepOr404(db, pid, sid), pid);
		});
		return c.json(update.immediate());
	});

	return app;
}
