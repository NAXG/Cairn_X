import type { TaskStatus } from "../contracts/execution.js";
import type { ExecutionSummary } from "../contracts/transcripts.js";

/** 通用状态表中步骤相关键的来源。 */
const stepStatusLabels: Record<string, string> = {
	open: "待执行",
	claimed: "执行中",
	concluded: "已结束",
	abandoned: "已放弃",
};
/** 通用状态文案：项目、执行、步骤与目标共用。 */
export const statusLabels: Record<string, string> = {
	...stepStatusLabels,
	active: "运行中",
	stopped: "已停止",
	completed: "已完成",
	queued: "排队中",
	running: "执行中",
	succeeded: "已交付",
	failed: "失败",
	cancelled: "已取消",
	lost: "执行丢失",
	pending: "待达成",
	achieved: "已达成",
};

export const taskStatusLabels: Record<TaskStatus, string> = {
	satisfied: "验收达标",
	inconclusive: "验收未确认",
	blocked: "执行受阻",
};

/** 执行成功只代表协议已交付，不能盖过结构化结果里的验收结论。 */
export function executionBadge(
	execution: Pick<ExecutionSummary, "status" | "task_status" | "auto_inconclusive">,
): {
	status: string;
	label: string;
} {
	if (execution.status === "succeeded" && execution.task_status !== null) {
		return {
			status: execution.task_status === "satisfied" ? "succeeded" : "inconclusive",
			label: `已交付 · ${taskStatusLabels[execution.task_status]}${execution.auto_inconclusive ? "（自动兜底）" : ""}`,
		};
	}
	return { status: execution.status, label: statusLabels[execution.status] ?? execution.status };
}
/** 运行环境状态文案：与通用状态表存在同名不同义的键，单独维护。 */
export const environmentLabels: Record<string, string> = {
	unavailable: "暂无运行环境记录",
	pending: "正在准备",
	running: "运行中",
	stopped: "已停止",
	unresponsive: "暂未收到心跳",
};
/** 活动角色文案：Decide 对外称 Dispatcher。 */
export function roleName(role: string): string {
	return role === "decide" ? "Dispatcher" : "Execute";
}
/** 主题文案：与 useTheme 的 preference 取值一一对应。 */
export const themeLabels: Record<string, string> = {
	light: "浅色",
	dark: "深色",
	auto: "跟随系统",
	mist: "雾青",
	rose: "蔷薇",
	pine: "松夜",
};
/** 图谱节点类型文案：节点血缘工具栏使用。 */
export const graphNodeTypeLabels: Record<string, string> = {
	fact: "事实",
	goal: "目标",
	step: "步骤",
	finding: "发现",
	hint: "提示",
	route: "路线",
	execution: "执行",
};
