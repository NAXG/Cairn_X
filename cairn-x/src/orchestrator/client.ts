import type {
	WorkbenchOverview,
	WorkbenchRecord,
	ReadPage,
	RecordPreview,
} from "../contracts/workbench.js";
import type {
	SchedulingProject,
	SchedulingProjectState,
	SchedulingCandidates,
} from "../contracts/scheduling.js";
import type { WithEffects } from "../contracts/decide-tools.js";
/**
 * Cairn_X FGS 服务器的 HTTP 客户端。
 *
 * 写操作返回 ApiResult（{statusCode, ok, data, text}）而不是抛异常，因为调度器
 * 会根据状态码分支处理（认领 lease 时 403/409 属于正常控制流）。
 * 只读 GET 调用失败时抛出 ClientError。
 */

import { requestJson as httpRequest } from "../shared/http.js";
import type { TypedEvidenceRef } from "../contracts/evidence.js";
import type {
	ProjectMeta,
	FactModel,
	GoalModel,
	StepModel,
	FindingModel,
	HintModel,
	RouteModel,
	UsageEvent,
	RecordUsageBody,
	CreatedProject,
	Settings,
} from "../contracts/models.js";
import type { ExecutionView } from "../contracts/execution.js";
import type { PlanningGraphRequest, PlanningGraphResponse } from "../contracts/planning-graph.js";
export type { ExecutionView };

export interface ApiResult<T = unknown> {
	leaseTimeout?: number;
	/** 响应头 X-Heartbeat-Interval（秒）：与租约 TTL 解耦的心跳间隔。 */
	heartbeatInterval?: number;
	statusCode: number;
	ok: boolean;
	data: T | undefined;
	text: string;
}

export class ClientError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number = 0,
		public readonly responseText: string = "",
	) {
		super(message);
		this.name = "ClientError";
	}
}

export interface CreateProjectBody {
	title: string;
	origin: string;
	goal: string;
	finding_schema?: unknown;
	experiment_id?: string;
	harness_variant?: string;
	hints?: Array<{ content: string; creator: string; persistent?: boolean }> | null;
}

interface CreateExecutionBody {
	project_id: string;
	step_id: string;
	execution_id: string;
}

interface CreatedProjectWorkerToken {
	project_id: string;
	token: string;
	container_name: string | null;
}

export interface CreatedExecution {
	/** 服务端实际执行预算（秒），Worker 启动时据此校验运行与收尾预算。 */
	deadline_seconds: number;
	deadline_at: string;
	configuration?: import("../contracts/configuration.js").ActivitySnapshot;
	execution_id: string;
	attempt: number;
	lease_version: number;
	heartbeat_interval_s: number;
}

export interface PluginOperationEnvelope {
	id: string;
	role: import("../contracts/configuration.js").AgentRole;
	kind: "install" | "update" | "remove" | "enable" | "disable";
	source?: string;
	status: "queued" | "running" | "succeeded" | "failed";
	created_at: string;
	updated_at: string;
	worker?: string;
	message?: string;
	progress?: number;
	release?: import("../contracts/plugins.js").PluginRelease;
}

export interface CreateStepBody {
	request_id?: string;
	actor?: "human";
	decide_worker?: string;
	from: string[];
	goal_id?: string | null;
	route_id?: string | null;
	description: string;
	priority?: number;
	waiting_on?: string[];
	creator: string;
	worker?: string | null;
}

export interface CreateRouteBody {
	request_id?: string;
	actor?: "human";
	worker?: string;
	description: string;
	goal_id?: string | null;
}

export interface CreateGoalBody {
	request_id?: string;
	actor?: "human";
	worker?: string;
	description: string;
	parent_goal_id?: string | null;
}

export interface CreateFindingBody {
	step_id?: string;
	actor?: "human";
	worker?: string;
	title: string;
	description: string;
	data?: unknown;
	fact_ids?: string[] | null;
}

/**
 * 控制端 API 客户端。以下方法目前仅由测试调用，对应 HTTP 路由保留给
 * 外部调用方：createHint / createFinding / concludeStep / signalDecide /
 * updateSettings。
 */
type RecordModels = {
	[K in WorkbenchRecord["type"]]: Extract<WorkbenchRecord, { type: K }>["record"];
};

export class FgsClient {
	readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly token?: string;

	constructor(baseUrl: string, timeoutMs = 10_000, token?: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.timeoutMs = timeoutMs;
		this.token = token;
	}

	// ---- 只读调用（失败时抛出 ClientError）----

	async listSchedulingProjects(): Promise<SchedulingProject[]> {
		return this.getJson<SchedulingProject[]>("/internal/scheduling/projects");
	}
	async getSchedulingProjectState(projectId: string): Promise<SchedulingProjectState> {
		return this.getJson<SchedulingProjectState>(
			`/internal/scheduling/projects/${encodeURIComponent(projectId)}/state`,
		);
	}
	async getSchedulingCandidates(
		projectId: string,
		exclude: string[] = [],
		limit = 1,
	): Promise<SchedulingCandidates> {
		const query = new URLSearchParams({ limit: String(limit) });
		for (const id of exclude) query.append("exclude", id);
		return this.getJson<SchedulingCandidates>(
			`/internal/scheduling/projects/${encodeURIComponent(projectId)}/candidates?${query}`,
		);
	}

	async getProjectOverview(projectId: string): Promise<WorkbenchOverview> {
		return this.getJson<WorkbenchOverview>(`/projects/${encodeURIComponent(projectId)}/overview`);
	}
	async getRecord<T extends keyof RecordModels>(
		projectId: string,
		type: T,
		id: string,
	): Promise<RecordModels[T]> {
		const data = await this.getJson<WorkbenchRecord>(
			`/projects/${encodeURIComponent(projectId)}/records/${type}/${encodeURIComponent(id)}`,
		);
		return data.record as RecordModels[T];
	}
	async getGoalsPage(projectId: string, cursor?: string): Promise<ReadPage<RecordPreview>> {
		const query = new URLSearchParams({ limit: "100" });
		if (cursor) query.set("cursor", cursor);
		return this.getJson<ReadPage<RecordPreview>>(
			`/projects/${encodeURIComponent(projectId)}/goals/page?${query}`,
		);
	}
	async getProjectStats(projectId: string): Promise<Record<string, unknown>> {
		return this.getJson<Record<string, unknown>>(
			`/projects/${encodeURIComponent(projectId)}/stats`,
		);
	}

	/** Trace Digester 结构化诊断。 */
	async getProjectDigest(
		projectId: string,
		options: { step_id?: string } = {},
	): Promise<Record<string, unknown>> {
		const query = new URLSearchParams();
		if (options.step_id !== undefined) query.set("step_id", options.step_id);
		const suffix = query.size > 0 ? `?${query}` : "";
		return this.getJson<Record<string, unknown>>(
			`/projects/${encodeURIComponent(projectId)}/digest${suffix}`,
		);
	}

	async beginConfiguredDecide(project_id: string, worker: string) {
		return this.requestJson<{
			snapshot: import("../contracts/configuration.js").ActivitySnapshot;
			token: string;
		}>("POST", "/internal/activities/decide", { project_id, worker });
	}
	async getRuntimeSettings() {
		return this.getJson<import("../contracts/configuration.js").RuntimeSettings>(
			"/settings/runtime",
		);
	}
	async getSettings(): Promise<Settings> {
		return this.getJson<Settings>("/settings");
	}

	async claimPluginOperation(role: "decide" | "execute", worker: string) {
		return this.requestJson<PluginOperationEnvelope | null>(
			"POST",
			"/internal/plugins/operations/claim",
			{ role, worker },
		);
	}

	async finishPluginOperation(
		id: string,
		body: { ok: boolean; message?: string; release?: unknown },
	) {
		return this.requestJson<PluginOperationEnvelope>(
			"POST",
			`/internal/plugins/operations/${encodeURIComponent(id)}/result`,
			body,
		);
	}

	async listPlugins(role: "decide" | "execute") {
		return this.getJson<{
			current: import("../contracts/plugins.js").PluginRelease | null;
			operations: PluginOperationEnvelope[];
		}>(`/settings/agents/${role}/plugins`);
	}

	async enqueuePluginOperation(
		role: "decide" | "execute",
		kind: PluginOperationEnvelope["kind"],
		source?: string,
	) {
		return this.requestJson<PluginOperationEnvelope>(
			"POST",
			`/settings/agents/${role}/plugins/operations`,
			{ kind, ...(source ? { source } : {}) },
		);
	}

	async getPluginOperation(role: "decide" | "execute", id: string) {
		return this.getJson<PluginOperationEnvelope>(
			`/settings/agents/${role}/plugins/operations/${encodeURIComponent(id)}`,
		);
	}

	async readDecideEvidence(
		projectId: string,
		worker: string,
		input: import("../contracts/decide-tools.js").ReadEvidenceInput,
	): Promise<ApiResult> {
		return this.requestJson("POST", `/projects/${projectId}/decide/evidence`, { ...input, worker });
	}

	async readDecideGraph(
		projectId: string,
		request: PlanningGraphRequest,
	): Promise<PlanningGraphResponse> {
		const result = await this.requestJson<PlanningGraphResponse>(
			"POST",
			`/projects/${projectId}/decide/graph`,
			request,
		);
		if (!result.ok || result.data === undefined)
			throw new ClientError(
				`POST /projects/${projectId}/decide/graph failed: ${result.statusCode}`,
				result.statusCode,
				result.text,
			);
		return result.data;
	}

	// ---- 写操作调用（返回 ApiResult；HTTP 错误一律不抛异常）----

	createProject(body: CreateProjectBody): Promise<ApiResult<CreatedProject>> {
		return this.requestJson("POST", "/projects", body);
	}

	setProjectStatus(
		projectId: string,
		status: "active" | "stopped",
	): Promise<ApiResult<ProjectMeta>> {
		return this.requestJson("POST", `/projects/${projectId}/status`, { status });
	}

	completeProject(
		projectId: string,
		body: { from: TypedEvidenceRef[]; description: string; worker?: string; actor?: "human" },
	): Promise<ApiResult> {
		return this.requestJson("POST", `/projects/${projectId}/complete`, body);
	}

	createHint(
		projectId: string,
		body: { content: string; creator: string; persistent?: boolean },
	): Promise<ApiResult<HintModel>> {
		return this.requestJson("POST", `/projects/${projectId}/hints`, body);
	}

	createFact(
		projectId: string,
		body: {
			description: string;
			actor?: "human";
			confidence: "observed" | "inferred";
			step_id?: string | null;
			worker?: string | null;
			/** 幂等重传键：重试同一完成事实时不重复追加。 */
			client_event_id?: string;
		},
	): Promise<ApiResult<FactModel>> {
		return this.requestJson("POST", `/projects/${projectId}/facts`, body);
	}

	createStep(projectId: string, body: CreateStepBody): Promise<ApiResult<StepModel>> {
		return this.requestJson("POST", `/projects/${projectId}/steps`, body);
	}

	claimStep(projectId: string, stepId: string, worker: string): Promise<ApiResult<StepModel>> {
		return this.requestJson("POST", `/projects/${projectId}/steps/${stepId}/claim`, { worker });
	}

	releaseStep(projectId: string, stepId: string, worker: string): Promise<ApiResult<StepModel>> {
		return this.requestJson("POST", `/projects/${projectId}/steps/${stepId}/release`, { worker });
	}

	concludeStep(
		projectId: string,
		stepId: string,
		worker: string,
		description: string,
	): Promise<ApiResult<{ step: StepModel }>> {
		return this.requestJson("POST", `/projects/${projectId}/steps/${stepId}/conclude`, {
			worker,
			description,
		});
	}

	abandonStep(
		projectId: string,
		stepId: string,
		worker: string,
		reason?: string,
	): Promise<ApiResult<WithEffects<StepModel>>> {
		return this.requestJson("POST", `/projects/${projectId}/steps/${stepId}/abandon`, {
			worker,
			reason,
		});
	}

	setStepPriority(
		projectId: string,
		stepId: string,
		priority: number,
		writer: { worker?: string; actor?: "human" },
	): Promise<ApiResult<StepModel>> {
		return this.requestJson("PATCH", `/projects/${projectId}/steps/${stepId}/priority`, {
			priority,
			...writer,
		});
	}

	createGoal(projectId: string, body: CreateGoalBody): Promise<ApiResult<GoalModel>> {
		return this.requestJson("POST", `/projects/${projectId}/goals`, body);
	}

	createRoute(projectId: string, body: CreateRouteBody): Promise<ApiResult<RouteModel>> {
		return this.requestJson("POST", `/projects/${projectId}/routes`, body);
	}

	deleteGoal(
		projectId: string,
		goalId: string,
		writer: { worker?: string; actor?: "human"; effects?: boolean },
	): Promise<ApiResult> {
		const params = new URLSearchParams();
		if (writer.worker !== undefined) params.set("worker", writer.worker);
		if (writer.actor !== undefined) params.set("actor", writer.actor);
		if (writer.effects) params.set("effects", "true");
		return this.requestJson("DELETE", `/projects/${projectId}/goals/${goalId}?${params}`);
	}

	achieveGoal(
		projectId: string,
		goalId: string,
		body: { from: TypedEvidenceRef[]; description: string; worker?: string; actor?: "human" },
	): Promise<ApiResult<GoalModel>> {
		return this.requestJson("POST", `/projects/${projectId}/goals/${goalId}/achieve`, body);
	}

	createFinding(projectId: string, body: CreateFindingBody): Promise<ApiResult<FindingModel>> {
		return this.requestJson("POST", `/projects/${projectId}/findings`, body);
	}

	/**
	 * 认领 Decide 租约。触发由服务端从持久化 checkpoint 计算；
	 * min_interval_seconds 是节奏参数（两次认领间的最小间隔）。
	 * 无触发时返回 409。成功响应附带 trigger 与 planning_version。
	 */
	claimDecide(
		projectId: string,
		worker: string,
		minIntervalSeconds = 0,
	): Promise<ApiResult<ProjectMeta & { trigger: string; planning_version: number }>> {
		return this.requestJson("POST", `/projects/${projectId}/decide/claim`, {
			worker,
			min_interval_seconds: minIntervalSeconds,
		});
	}

	/** Decide 成功收尾：CAS 推进规划版本，只确认服务端记录的该租约已读水位。 */
	completeDecide(
		projectId: string,
		worker: string,
		planningVersion: number,
	): Promise<ApiResult<{ planning_version: number }>> {
		return this.requestJson("POST", `/projects/${projectId}/decide/complete`, {
			worker,
			planning_version: planningVersion,
		});
	}

	heartbeatDecide(projectId: string, worker: string): Promise<ApiResult<ProjectMeta>> {
		return this.requestJson("POST", `/projects/${projectId}/decide/heartbeat`, { worker });
	}

	/** 注入外部信号：下一次认领以 external_signal 触发一次。 */
	signalDecide(projectId: string, signal: string): Promise<ApiResult<null>> {
		return this.requestJson("POST", `/projects/${projectId}/decide/signal`, { signal });
	}

	releaseDecide(projectId: string, worker: string): Promise<ApiResult<ProjectMeta>> {
		return this.requestJson("POST", `/projects/${projectId}/decide/release`, { worker });
	}

	updateSettings(body: {
		lease_timeout?: number;
		decide_timeout?: number;
	}): Promise<ApiResult<Settings>> {
		return this.requestJson("PATCH", "/settings", body);
	}

	recordUsage(projectId: string, body: RecordUsageBody): Promise<ApiResult<UsageEvent>> {
		return this.requestJson("POST", `/projects/${projectId}/usage`, body);
	}

	// ---- Executor 执行协议（控制端身份）----

	/** 创建一次 queued 执行尝试（要求 step 已由 execution_id 认领）。 */
	createExecution(body: CreateExecutionBody): Promise<ApiResult<CreatedExecution>> {
		return this.requestJson("POST", "/internal/executions", body);
	}

	/** 控制端为项目常驻容器签发（或轮换）项目令牌。 */
	issueProjectWorkerToken(
		projectId: string,
		containerName?: string,
	): Promise<ApiResult<CreatedProjectWorkerToken>> {
		return this.requestJson("POST", `/internal/project-workers/${projectId}/token`, {
			...(containerName === undefined ? {} : { container_name: containerName }),
		});
	}

	/** 控制端停止项目级常驻 Worker：容器回收后把注册行标为 stopped、令牌失效。 */
	stopProjectWorker(projectId: string): Promise<ApiResult<{ project_id: string; status: string }>> {
		return this.requestJson("POST", `/internal/project-workers/${projectId}/stop`);
	}

	getExecution(executionId: string): Promise<ApiResult<ExecutionView>> {
		return this.requestJson("GET", `/internal/executions/${executionId}`);
	}

	/** 控制端状态迁移（失败/取消/失联）。 */
	setExecutionStatus(
		executionId: string,
		body: {
			status: "failed" | "cancelled" | "lost";
			error?: string | null;
			exit_code?: number | null;
		},
	): Promise<ApiResult<ExecutionView>> {
		return this.requestJson("POST", `/internal/executions/${executionId}/status`, body);
	}

	requestExecutionCancel(executionId: string): Promise<ApiResult<ExecutionView>> {
		return this.requestJson("POST", `/internal/executions/${executionId}/cancel`);
	}

	/** 控制端兑底回收：截止时间已过的非终态执行 → lost。 */
	reapExecutions(): Promise<ApiResult<{ reaped: number }>> {
		return this.requestJson("POST", "/internal/executions/reap");
	}

	// ---- TSecBench 评测控制面（机器 token；driver 使用）----

	/** 平台题目列表（由 serve 代理，driver 不需要平台 token）。 */
	listBenchmarkChallenges(): Promise<ApiResult<import("../tsecbench/types.js").Challenge[]>> {
		return this.requestJson("GET", "/internal/benchmark/challenges");
	}

	listBenchmarkTasks(): Promise<import("../tsecbench/store.js").BenchmarkBinding[]> {
		return this.getJson("/internal/benchmark/tasks");
	}

	bindBenchmark(body: {
		project_id: string;
		unique_code: string;
		title?: string;
		start?: boolean;
	}): Promise<ApiResult<import("../tsecbench/store.js").BenchmarkBinding>> {
		return this.requestJson("POST", "/internal/benchmark/bind", body);
	}

	refreshBenchmark(
		projectId: string,
	): Promise<ApiResult<import("../tsecbench/store.js").BenchmarkBinding>> {
		return this.requestJson("POST", `/internal/benchmark/${projectId}/refresh`);
	}

	/** 控制面兜底：容器被平台回收后重新拉起（不改变进度）。 */
	startBenchmark(
		projectId: string,
	): Promise<ApiResult<import("../tsecbench/store.js").BenchmarkBinding>> {
		return this.requestJson("POST", `/internal/benchmark/${projectId}/start`);
	}

	closeBenchmark(
		projectId: string,
	): Promise<ApiResult<import("../tsecbench/store.js").BenchmarkBinding>> {
		return this.requestJson("POST", `/internal/benchmark/${projectId}/close`);
	}

	resetBenchmark(projectId: string): Promise<ApiResult<{ deleted: boolean }>> {
		return this.requestJson("POST", `/internal/benchmark/${projectId}/reset`);
	}

	private authHeaders(): Record<string, string> {
		return this.token ? { Authorization: `Bearer ${this.token}` } : {};
	}

	private getJson<T>(path: string): Promise<T> {
		return this.readResponse(path, (response) => response.json() as Promise<T>);
	}

	private async readResponse<T>(
		path: string,
		read: (response: Response) => Promise<T>,
	): Promise<T> {
		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!response.ok)
				throw new ClientError(
					`GET ${path} failed: ${response.status}`,
					response.status,
					await response.text(),
				);
			return await read(response);
		} catch (err) {
			if (err instanceof ClientError) throw err;
			throw new ClientError(`GET ${path} request failed: ${errorMessage(err)}`);
		}
	}

	private async requestJson<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<ApiResult<T>> {
		const result = await httpRequest<T>({
			url: `${this.baseUrl}${path}`,
			method,
			headers: this.authHeaders(),
			body,
			timeoutMs: this.timeoutMs,
		});
		// 租约响应头是 FgsClient 独有的；网络错误时 headers 为空，两个值都是 0。
		const ttl = Number(result.headers.get("X-Lease-Timeout"));
		const heartbeat = Number(result.headers.get("X-Heartbeat-Interval"));
		return {
			statusCode: result.statusCode,
			ok: result.ok,
			data: result.data,
			text: result.text,
			...(ttl > 0 ? { leaseTimeout: ttl } : {}),
			...(heartbeat > 0 ? { heartbeatInterval: heartbeat } : {}),
		};
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
