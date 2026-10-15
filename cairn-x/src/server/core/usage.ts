import type { RecordUsageBody } from "../../contracts/models.js";
import type { Db, UsageEventRow } from "../db.js";
import { writeUsageEvent } from "./usage-store.js";
import { ApiError, utcnow } from "./base.js";
import { checkProjectUsageWritable, getStepOr404 } from "./project-guards.js";
import { usageEventToModel } from "./model-mappers.js";

export function recordUsage(db: Db, projectId: string, body: RecordUsageBody) {
	checkProjectUsageWritable(db, projectId, body.activity);
	if (body.step_id != null) getStepOr404(db, projectId, body.step_id);
	// 同一执行只记一笔：控制端可能在取消/失联时已从轨迹回填，Worker 的迟到
	// 上报必须幂等（顺带修掉网络重试造成的重复计数）。execution_id 可能是
	// 公开端点传入的，必须先确认它属于本项目，避免跨项目引用与越权读取。
	if (body.execution_id != null) {
		const execution = db
			.prepare("SELECT project_id FROM executions WHERE id = ?")
			.get(body.execution_id) as { project_id: string } | undefined;
		if (execution === undefined) throw new ApiError(404, "Execution not found");
		if (execution.project_id !== projectId)
			throw new ApiError(400, "Execution belongs to another project");
		const existing = db
			.prepare("SELECT * FROM usage_events WHERE execution_id = ?")
			.get(body.execution_id) as UsageEventRow | undefined;
		if (existing !== undefined) return usageEventToModel(existing);
	}
	return usageEventToModel(writeUsageEvent(db, projectId, body, utcnow()));
}
