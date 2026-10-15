/**
 * Worker ↔ 控制端 HTTP 客户端（短期执行令牌鉴权）。
 *
 * 所有请求都绑定当前 execution：令牌在执行创建时发放、终态即失效。
 * 心跳失败的分类与调度端 HeartbeatLease 一致：401/403/404/409 是
 * 租约确定丢失（立即停止）；网络错误容忍一个宽限窗口。
 */

import { requestJson } from "../shared/http.js";
import type { EvidenceRef } from "../contracts/evidence.js";
import type { FactContent } from "../contracts/facts.js";
import type {
	ExecutionBenchmarkContext,
	ExecutionEventsBody,
	ExecutionEventsResult,
	ExecutionResultAck,
	ExecutionResultBody,
	EscalationAck,
} from "../contracts/execution.js";
import type { SubmitFlagResult } from "../tsecbench/types.js";

export interface WorkerApiResult<T = unknown> {
	statusCode: number;
	ok: boolean;
	data: T | undefined;
	text: string;
}

export class WorkerClient {
	constructor(
		private readonly controlUrl: string,
		private readonly executionId: string,
		/** 短期执行令牌；同时用作活动通道（/internal/activities/*）的令牌。 */
		readonly authToken: string,
		private readonly timeoutMs = 30_000,
	) {}

	private request<T>(method: string, path: string, body?: unknown): Promise<WorkerApiResult<T>> {
		return requestJson<T>({
			url: `${this.controlUrl.replace(/\/+$/, "")}${path}`,
			method,
			headers: { Authorization: `Bearer ${this.authToken}` },
			body,
			timeoutMs: this.timeoutMs,
		});
	}

	async heartbeat(): Promise<
		WorkerApiResult<{
			lease_timeout_s: number;
			heartbeat_interval_s: number;
			cancel: boolean;
			deadline_at: string;
		}>
	> {
		return this.request("POST", `/internal/executions/${this.executionId}/heartbeat`);
	}

	/** 事件批量上传（幂等：服务端只追加 seq 超过已持久化游标的行）。 */
	async sendEvents(
		events: Array<{ seq: number; line: string }>,
	): Promise<WorkerApiResult<ExecutionEventsResult>> {
		const body: ExecutionEventsBody = { events };
		return this.request<ExecutionEventsResult>(
			"POST",
			`/internal/executions/${this.executionId}/events`,
			body,
		);
	}

	async submitFact(
		body: FactContent & {
			client_event_id: string;
			evidence?: EvidenceRef[];
		},
	): Promise<WorkerApiResult<{ id: string; duplicate: boolean }>> {
		return this.request("POST", `/internal/executions/${this.executionId}/facts`, body);
	}

	async submitFinding(body: {
		title: string;
		description: string;
		data?: unknown;
		fact_ids?: string[] | null;
		client_event_id: string;
		evidence?: EvidenceRef[];
	}): Promise<WorkerApiResult<{ id: string; duplicate: boolean }>> {
		return this.request("POST", `/internal/executions/${this.executionId}/findings`, body);
	}

	/**
	 * 升级上报：把「当前计划的前提已经不成立」立刻交回规划层。
	 *
	 * status distinguishes a recorded signal, a duplicate, and an unrecorded signal at the limit.
	 */
	async signalPlanner(reason: string): Promise<WorkerApiResult<EscalationAck>> {
		return this.request("POST", `/internal/executions/${this.executionId}/signal`, { reason });
	}

	async searchEvents(params: {
		q: string;
		execution_id?: string;
		step_id?: string;
		cursor?: string;
		limit?: number;
	}): Promise<WorkerApiResult<unknown>> {
		const query = new URLSearchParams({ q: params.q });
		for (const key of ["execution_id", "step_id", "cursor", "limit"] as const) {
			const value = params[key];
			if (value !== undefined) query.set(key, String(value));
		}
		return this.request("GET", `/internal/executions/${this.executionId}/search-events?${query}`);
	}

	/** 读取同项目某次执行的轨迹片段。 */
	async getTrace(
		targetId: string,
		options: {
			after_seq?: number;
			limit?: number;
			event_seq?: number;
			offset?: number;
			view?: "index";
		} = {},
	): Promise<WorkerApiResult<unknown>> {
		const query = new URLSearchParams();
		if (options.after_seq !== undefined) query.set("after_seq", String(options.after_seq));
		if (options.event_seq !== undefined) query.set("event_seq", String(options.event_seq));
		if (options.offset !== undefined) query.set("offset", String(options.offset));
		if (options.limit !== undefined) query.set("limit", String(options.limit));
		if (options.view !== undefined) query.set("view", options.view);
		const suffix = query.size ? `?${query}` : "";
		return this.request(
			"GET",
			`/internal/executions/${this.executionId}/trace/${encodeURIComponent(targetId)}${suffix}`,
		);
	}

	// ---- TSecBench 评测代理（控制端持有平台 token，Worker 只传 flag）----

	async benchmarkStatus(): Promise<WorkerApiResult<ExecutionBenchmarkContext>> {
		return this.request("GET", `/internal/executions/${this.executionId}/benchmark`);
	}

	/** 重建靶场容器（close→start），拿到干净实例。控制端会在有兄弟执行在途时拒绝。 */
	async benchmarkReset(): Promise<WorkerApiResult<ExecutionBenchmarkContext>> {
		return this.request("POST", `/internal/executions/${this.executionId}/benchmark/reset`);
	}

	async benchmarkSubmit(flag: string): Promise<WorkerApiResult<SubmitFlagResult>> {
		return this.request("POST", `/internal/executions/${this.executionId}/benchmark/submit`, {
			flag,
		});
	}

	async benchmarkHint(reason: string): Promise<WorkerApiResult<{ hint: string | null }>> {
		return this.request("POST", `/internal/executions/${this.executionId}/benchmark/hint`, {
			reason,
		});
	}

	/** 最终结果上报（要求持久化确认；网络失败由调用方有限重试）。 */
	async reportResult(body: ExecutionResultBody): Promise<WorkerApiResult<ExecutionResultAck>> {
		return this.request<ExecutionResultAck>(
			"POST",
			`/internal/executions/${this.executionId}/result`,
			body,
		);
	}
}
