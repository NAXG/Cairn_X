import type { AgentRole } from "./configuration.js";

export type ActivityType = AgentRole;

export type Outcome = "success" | "failed" | "cancelled" | "unhealthy";
/** 仅 Execute 创建请求的提交状态无法确认时返回；不得释放 Step 租约。 */
export type ExecuteOutcome = Outcome | "uncertain";
