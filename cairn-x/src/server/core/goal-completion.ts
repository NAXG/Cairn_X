import type { TypedEvidenceRef } from "../../contracts/evidence.js";
import type { GoalModel } from "../../contracts/models.js";
import type { Db } from "../db.js";
import { ApiError, utcnow } from "./base.js";
import { completeDecide, getCheckpoint } from "./decide.js";
import { withDecideChanges } from "./decide-changes.js";
import { listGoalEvidence, sameGoalEvidence, setGoalEvidence } from "./evidence.js";
import { cancelStepExecutions } from "./execution-cascade.js";
import { clearProjectDecide } from "./lease-expiry.js";
import { goalToModel } from "./model-mappers.js";
import {
	getGoalOr404,
	getProjectOr404,
	requireDecideLease,
	requireGraphWriter,
} from "./project-guards.js";

/** Both root-goal completion endpoints use this operation, in the caller's transaction. */
export function achieveProjectGoal(
	db: Db,
	projectId: string,
	goalId: string,
	body: { from: TypedEvidenceRef[]; description: string; worker?: string; actor?: "human" },
): GoalModel {
	const goal = getGoalOr404(db, projectId, goalId);
	if (goal.status !== "pending") {
		// 幂等确认：证据集合与完成理由完全一致的重传返回首次结果，绝不改写。
		// 身份仍需有效：人类操作者或当前持有 Decide 租约的 worker。
		if (
			goal.status === "achieved" &&
			sameGoalEvidence(
				listGoalEvidence(db, projectId, goalId),
				goal.achieved_description,
				body.from,
				body.description,
			)
		) {
			if (body.actor === "human") return goalToModel(db, goal);
			if (body.worker) {
				// Completing the root goal releases the decide lease. An identical retry is
				// read-only and must still succeed after the response was lost in transit.
				if (goalId !== "goal" || getProjectOr404(db, projectId).status !== "completed")
					requireDecideLease(db, projectId, body.worker);
				return goalToModel(db, goal);
			}
			throw new ApiError(400, "Provide worker or actor=human");
		}
		throw new ApiError(409, `Goal already ${goal.status}`);
	}
	requireGraphWriter(db, projectId, body);
	if (
		goalId === "goal" &&
		db
			.prepare("SELECT 1 FROM goals WHERE project_id = ? AND id != 'goal' AND status = 'pending'")
			.get(projectId)
	) {
		throw new ApiError(409, "Resolve pending sub goals before completing the project");
	}
	const now = utcnow();
	withDecideChanges(db, projectId, body.worker, () => {
		setGoalEvidence(db, projectId, goalId, body.from);
		db.prepare(
			"UPDATE goals SET status = 'achieved', achieved_description = ?, achieved_at = ? WHERE id = ? AND project_id = ?",
		).run(body.description, now, goalId, projectId);
	});
	if (goalId === "goal") {
		// 根目标由持有 Decide 租约的 worker 达成时，在同一事务里提交它的规划
		// checkpoint：项目变 completed 后 Dispatcher 会立即中止在途 decide 任务，
		// reap 路径对 cancelled 不再调用 completeDecide，checkpoint 将永远停留在
		// 旧版本。
		// CAS 失败（人类达成 / 版本过期）只跳过推进，不影响目标达成本身。
		if (body.worker !== undefined) {
			const project = getProjectOr404(db, projectId);
			if (project.decide_worker === body.worker) {
				try {
					completeDecide(
						db,
						projectId,
						body.worker,
						getCheckpoint(db, projectId)?.planning_version ?? 0,
						project.decide_trigger,
					);
				} catch {
					// best effort：checkpoint 不推进不阻塞项目完成
				}
			}
		}
		db.prepare("UPDATE projects SET status = 'completed' WHERE id = ?").run(projectId);
		clearProjectDecide(db, projectId);
		// 统一收尾：剩余 open/claimed 步骤随项目完成一并取消，避免
		// 目标达成后仍残留可派发步骤（调度器会将运行中的任务中止）。
		const cancelled = db
			.prepare("SELECT id FROM steps WHERE project_id = ? AND status IN ('open', 'claimed')")
			.all(projectId) as Array<{ id: string }>;
		db.prepare(
			`UPDATE steps SET status = 'abandoned', worker = NULL, lease_expires_at = NULL,
			lease_version = lease_version + 1, concluded_at = ?,
			summary = '根目标已达成，项目完成时自动取消'
			WHERE project_id = ? AND status IN ('open', 'claimed')`,
		).run(now, projectId);
		for (const step of cancelled) cancelStepExecutions(db, projectId, step.id, now);
	}
	return goalToModel(db, getGoalOr404(db, projectId, goalId));
}
