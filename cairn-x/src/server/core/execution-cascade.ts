import type { Db } from "../db.js";
import { signalDecideExternal } from "./decide.js";
import { parseJsonStringArray } from "./model-mappers.js";
import { backfillExecutionUsage } from "./usage-backfill.js";

/**
 * 步骤被放弃时，把挂在它上面的非终态执行立即推到 cancelled。
 *
 * 不这样做的后果：废弃只递增租约代数，在途执行仍是
 * running —— activity guard 先掐断它的模型流，结果上报与事件上传又都被
 * requireExecutionAlive 以 409 拒绝，执行只能挂到 deadline 才被判 lost。
 * 代价是白占 28 分钟预算、丢掉轨迹尾部，还用 execution_lost 唤醒 Decide
 * 再转一圈，而步骤其实早就被放弃了。
 *
 * 已经是终态的执行不动：worker 抢先上报成功时结果必须保留。
 */
export function cancelStepExecutions(
	db: Db,
	projectId: string,
	stepId: string,
	now: string,
	reason = "Step abandoned; in-flight execution cancelled by controller",
): void {
	const cancelled = db
		.prepare(
			"SELECT id FROM executions WHERE project_id = ? AND step_id = ? AND status IN ('queued', 'running')",
		)
		.all(projectId, stepId) as Array<{ id: string }>;
	db.prepare(
		`UPDATE executions SET status = 'cancelled', finished_at = ?, cancel_requested = 1,
		 error = COALESCE(error, ?)
		 WHERE project_id = ? AND step_id = ? AND status IN ('queued', 'running')`,
	).run(now, reason, projectId, stepId);
	// 容器等不到收尾就没了：从轨迹回填 token，否则这次执行在成本视图里不存在。
	for (const row of cancelled) backfillExecutionUsage(db, row.id, now);
}

/**
 * 失联执行关闭原 Step，由 Decide 根据已知事实决定是否创建新的行动。
 *
 * 传入 projectId 时只处理该项目：请求路径上的回收不能顺手改写别的项目，
 * 否则 A 的读会变成 B 的写，也会退化成全库扫描。
 */
export function closeLostExecutionSteps(db: Db, now: string, projectId?: string): void {
	const filter = projectId === undefined ? "" : " AND steps.project_id = ?";
	const args = projectId === undefined ? [] : [projectId];
	const closed = db
		.prepare(
			`UPDATE steps SET status = 'abandoned', worker = NULL, lease_expires_at = NULL,
		lease_version = lease_version + 1, concluded_at = ?,
		summary = '执行失联，结果未知：副作用可能已经发生。请先核对现有证据，再决定是否创建新步骤。'
		WHERE status = 'claimed' AND EXISTS (
			SELECT 1 FROM executions e WHERE e.project_id = steps.project_id AND e.step_id = steps.id
			AND e.id = steps.worker AND e.lease_version = steps.lease_version AND e.status = 'lost'
		)${filter}
		RETURNING project_id`,
		)
		.all(now, ...args) as Array<{ project_id: string }>;
	// 其余放弃路径（abandon / 尝试耗尽）各自级联；这里只需为刚被关闭的步骤级联，
	// 不必在每次回收时扫描所有带依赖的开放步骤。
	for (const id of new Set(closed.map((row) => row.project_id))) {
		cascadeAbandonBlockedSteps(db, id, now);
	}
}

/**
 * 通关后立即停手：把项目里除调用方自身之外的在途执行全部推到 cancelled。
 *
 * 必须保留调用方那一次 —— 它的 submit_fact / conclude 还要落库，否则 Decide
 * 看不到「已拿到 flag」这条事实。此前只依赖 Decide 盖章时的统一收尾，兄弟步骤
 * 会继续空转到那一刻。
 */
export function stopProjectWorkExcept(
	db: Db,
	projectId: string,
	exceptExecutionId: string | null,
	now: string,
): number {
	const stopped = db
		.prepare(
			`SELECT id FROM executions
			 WHERE project_id = ? AND status IN ('queued', 'running') AND id <> ?`,
		)
		.all(projectId, exceptExecutionId ?? "") as Array<{ id: string }>;
	const info = db
		.prepare(
			`UPDATE executions SET status = 'cancelled', finished_at = ?, cancel_requested = 1,
			 error = COALESCE(error, 'Challenge already solved; in-flight execution stopped')
			 WHERE project_id = ? AND status IN ('queued', 'running') AND id <> ?`,
		)
		.run(now, projectId, exceptExecutionId ?? "");
	for (const row of stopped) backfillExecutionUsage(db, row.id, now);
	return info.changes;
}

/**
 * 依赖放弃的步骤永远无法再满足派发条件：把等待它的 open 步骤级联
 * 取消（沿依赖链传播），防止项目因永远阻塞的步骤而停滞。Decide 看到
 * 取消原因后可按需创建替代步骤。
 */
export function cascadeAbandonBlockedSteps(
	db: Db,
	projectId: string,
	now: string,
	actor?: string | null,
): string[] {
	const abandoned = new Set(
		(
			db
				.prepare("SELECT id FROM steps WHERE project_id = ? AND status = 'abandoned'")
				.all(projectId) as Array<{ id: string }>
		).map((r) => r.id),
	);
	const cancel = db.prepare(
		`UPDATE steps SET status = 'abandoned', worker = NULL, lease_expires_at = NULL,
		lease_version = lease_version + 1, concluded_at = ?, summary = ?
		WHERE id = ? AND project_id = ?`,
	);
	const cascaded: string[] = [];
	for (;;) {
		const waiting = db
			.prepare(
				"SELECT id, waiting_on FROM steps WHERE project_id = ? AND status = 'open' AND waiting_on IS NOT NULL",
			)
			.all(projectId) as Array<{ id: string; waiting_on: string }>;
		const blocked = waiting.filter((r) =>
			parseJsonStringArray(r.waiting_on).some((dep) => abandoned.has(dep)),
		);
		if (blocked.length === 0) break;
		for (const step of blocked) {
			const deps = parseJsonStringArray(step.waiting_on).filter((d) => abandoned.has(d));
			cancel.run(
				now,
				`依赖的步骤 ${deps.join(", ")} 已被放弃，无法再满足派发条件，自动取消。请据此评估是否需要替代步骤。`,
				step.id,
				projectId,
			);
			cancelStepExecutions(db, projectId, step.id, now);
			abandoned.add(step.id);
			cascaded.push(step.id);
		}
	}
	// 级联取消改变了开放步骤集合，但 computeDecideTrigger 只在 open 归零时才附带
	// waiting_timeout —— 其它情况下 Decide 不会被唤醒，被放弃的依赖链就白断了。
	// 这里显式发一个外部信号，保证 Decide 一定看到「依赖失败」并给出替代分支。
	if (cascaded.length > 0) {
		signalDecideExternal(db, projectId, `dependency_abandoned:${cascaded.join(",")}`, actor);
	}
	return cascaded;
}
