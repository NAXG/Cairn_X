/**
 * 项目级常驻 Worker 的客户端（项目令牌鉴权）。
 *
 * 与 WorkerClient（绑定单个 execution 的短期令牌）分开：这里只做两件事 ——
 * 领取下一个 queued execution（next）与保活（heartbeat）。执行本身仍然
 * 使用 next 响应里现签的短期令牌走 WorkerClient / /internal/executions/:id/*。
 */

import { requestJson } from "../shared/http.js";
import type { ProjectWorkerTask } from "../contracts/execution.js";
import type { WorkerApiResult } from "./client.js";

interface ProjectHeartbeat {
	project_id: string;
	project_status: string;
	heartbeat_interval_s: number;
	/** 当前单项目并发上限；运行中修改设置后由心跳同步给常驻容器。 */
	max_concurrency?: number;
}

export class ProjectWorkerClient {
	constructor(
		readonly controlUrl: string,
		readonly projectId: string,
		readonly authToken: string,
		private readonly timeoutMs = 30_000,
	) {}

	private request<T>(method: string, path: string): Promise<WorkerApiResult<T>> {
		return requestJson<T>({
			url: `${this.controlUrl.replace(/\/+$/, "")}${path}`,
			method,
			headers: { Authorization: `Bearer ${this.authToken}` },
			timeoutMs: this.timeoutMs,
		});
	}

	nextTask(): Promise<WorkerApiResult<ProjectWorkerTask>> {
		return this.request<ProjectWorkerTask>(
			"POST",
			`/internal/project-workers/${encodeURIComponent(this.projectId)}/next`,
		);
	}

	heartbeat(): Promise<WorkerApiResult<ProjectHeartbeat>> {
		return this.request<ProjectHeartbeat>(
			"POST",
			`/internal/project-workers/${encodeURIComponent(this.projectId)}/heartbeat`,
		);
	}
}
