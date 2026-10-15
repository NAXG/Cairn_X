import type { ExecutionStatus, TaskStatus } from "./execution.js";

/**
 * 会话 JSONL 文件名模式：decide-<ts>.jsonl（规划）或
 * execute-<stepId>-a<attempt>-<ts>.jsonl（执行终态刷写）。sessions 列表、
 * 导出、消息读取三个模块共用；活动 id 会规约到 [0-9A-Za-z-]
 * （见 control/activity-routes）。
 */
export const SESSION_FILE_PATTERN = /^(decide|execute)-[0-9A-Za-z-]+\.jsonl$/;
/**
 * 活动会话轨迹的文件名。
 *
 * 会话文件由创建者按 `<snapshot.id>.jsonl` 落盘（见 control/session），
 * 控制端的轨迹回填按同一个名字认领用量，因此两边必须共用这一处约定。
 */
export function sessionFileName(snapshotId: string): string {
	return `${snapshotId}.jsonl`;
}
export interface ExecutionSummary {
	id: string;
	step_id: string;
	attempt: number;
	status: ExecutionStatus;
	/** 执行已交付时的步骤验收结论；运行中及旧记录可为 null。 */
	task_status: TaskStatus | null;
	/** 模型未交 submit_result，由系统生成 inconclusive 结果。 */
	auto_inconclusive: boolean;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	summary: string | null;
	error: string | null;
}
/** 磁盘会话索引；条目数为原始行数（不包含 session 头）。 */
export interface SessionSummary {
	file: string;
	activity: "decide" | "execute";
	bytes: number;
	modified_at: string;
	entries: number;
	/** 规划提示中的中断恢复触发；历史会话同样可从首条用户消息识别。 */
	retry?: boolean;
	/** 控制端确认这轮规划未完成 checkpoint。 */
	interrupted?: boolean;
}

/** 已由服务端关联的活动记录：执行可尚无会话，历史会话也可没有 execution。 */
export interface ActivityRecord {
	key: string;
	kind: "decide" | "execute";
	at: string;
	execution?: ExecutionSummary;
	session?: SessionSummary;
}

export interface TranscriptEntry {
	seq: number;
	record?: Record<string, unknown>;
	content_url?: string;
	bytes: number;
}
export interface TranscriptPage {
	entries: TranscriptEntry[];
	next_cursor: string;
	has_more: boolean;
}
