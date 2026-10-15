import type { Db } from "../db.js";
import { signalDecideExternal } from "./decide.js";
import { utcnow } from "./base.js";
import { checkProjectActive, getStepOr404, requireStepLease } from "./project-guards.js";
import { stepToModel } from "./model-mappers.js";
import { backfillExecutionUsage } from "./usage-backfill.js";

/** 一个步骤攒到这么多事实却没有任何 finding 时，叫醒 Decide 来收敛。 */
const FINDING_GAP_FACT_THRESHOLD = 3;

export function concludeStep(
	db: Db,
	projectId: string,
	stepId: string,
	worker: string,
	description: string,
	/** Successful execution finalization owns its own terminal transition in the same transaction. */
	fromExecutionResult = false,
) {
	return db.transaction(() => {
		checkProjectActive(db, projectId);
		requireStepLease(db, projectId, stepId, worker);
		const now = utcnow();
		if (!fromExecutionResult) {
			// A direct conclude must close any queued/running attempt atomically with the Step.
			// Otherwise a queued attempt can still be claimed, or a running one can write
			// evidence and then fail to commit its result against this concluded Step.
			const cancelled = db
				.prepare(
					"SELECT id FROM executions WHERE project_id = ? AND step_id = ? AND status IN ('queued', 'running')",
				)
				.all(projectId, stepId) as Array<{ id: string }>;
			db.prepare(
				`UPDATE executions SET status = 'cancelled', finished_at = ?, cancel_requested = 1,
				 error = COALESCE(error, 'Step concluded; in-flight execution cancelled by controller')
				 WHERE project_id = ? AND step_id = ? AND status IN ('queued', 'running')`,
			).run(now, projectId, stepId);
			for (const row of cancelled) backfillExecutionUsage(db, row.id, now);
		}
		db.prepare(
			"UPDATE steps SET status = 'concluded', summary = ?, concluded_at = ?, last_heartbeat_at = ? WHERE id = ? AND project_id = ?",
		).run(description, now, now, stepId, projectId);
		// 每完成一个 Step 都给 Decide 一次新的规划机会。Fact/Finding 在执行中
		// 仍会实时入图，但不会仅凭中间产物唤醒规划；完成信号是批次边界。
		signalDecideExternal(db, projectId, `step_completed:${stepId}`, worker, stepId);
		// 通用完成信号先写；若还存在更具体的 finding_gap，让它成为 checkpoint
		// 上展示的最近原因。decide_changes 会同时保留二者，完成边界不会丢失。
		signalFindingGap(db, projectId, stepId);
		return stepToModel(db, getStepOr404(db, projectId, stepId), projectId);
	})();
}

/**
 * findings 收敛的触发器：一个步骤产出了一批事实却一条 finding 都没有，说明
 * "探索"没有沉淀成"结论"，图谱只会一直膨胀。
 *
 * 这里显式给 Decide 一个外部信号：Decide 自己**没有**创建 finding 的工具，
 * 收敛只能靠它按 decide 提示词里的收敛规则再派一条收敛步骤。
 */
function signalFindingGap(db: Db, projectId: string, stepId: string): void {
	const facts = (
		db
			.prepare("SELECT COUNT(*) AS n FROM facts WHERE project_id = ? AND step_id = ?")
			.get(projectId, stepId) as { n: number }
	).n;
	if (facts < FINDING_GAP_FACT_THRESHOLD) return;
	const findings = (
		db
			.prepare("SELECT COUNT(*) AS n FROM findings WHERE project_id = ? AND step_id = ?")
			.get(projectId, stepId) as { n: number }
	).n;
	if (findings > 0) return;
	signalDecideExternal(db, projectId, `finding_gap:${stepId}:${facts}`, null, stepId);
}
