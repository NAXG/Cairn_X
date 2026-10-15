import type { FgsClient } from "../orchestrator/client.js";
import type { Outcome, ExecuteOutcome } from "../contracts/activity.js";

export interface DecideContext {
	client: FgsClient;
	projectId: string;
	projectTitle: string;
	trigger: string;
	worker: string;
	/** 本次认领的规划版本；成功收尾时用于 CAS 提交 checkpoint。 */
	planningVersion: number;
}

export interface ExecuteContext {
	client: FgsClient;
	projectId: string;
	stepId: string;
	/** 本次执行尝试的 execution_id（uuid；同时是 step 租约 worker 身份）。 */
	worker: string;
}

export interface ActivityRunners {
	decide(ctx: DecideContext, signal: AbortSignal): Promise<Outcome>;
	execute(ctx: ExecuteContext, signal: AbortSignal): Promise<ExecuteOutcome>;
}
