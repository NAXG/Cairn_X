import { randomUUID } from "node:crypto";
/**
 * Cairn_X 编排器的主调度循环：两种活动类型 decide / execute，负责调度、认领、
 * 取消、checkpoint 记录与 endpoint 冷却；实际的 agent 工作封装在 ActivityRunners
 * 接口之后。
 *
 * 每个 interval 轮次：回收已结束任务 → 列出项目 → 取消非活跃项目的任务 →
 * 排队容器清理 → 分发。
 */

import { ClientError, FgsClient } from "../orchestrator/client.js";
import type { SchedulingProject } from "../contracts/scheduling.js";
import type { ProjectWorkerLauncher } from "./launcher.js";
import { sleep } from "../shared/async.js";
import type { DeploymentConfig } from "./config.js";
import type { RuntimeSettings } from "../contracts/configuration.js";

import type { ActivityType, ExecuteOutcome } from "../contracts/activity.js";
import type { ActivityRunners, DecideContext, ExecuteContext } from "./types.js";
import { consoleLogger, type Logger } from "../shared/logger.js";
import { EndpointHealth } from "./endpoint-health.js";
import { LogDeduplicator } from "./log-dedup.js";
import { ProjectContainerReconciler } from "./project-container-reconciler.js";
import { rotateProjects } from "./project-rotation.js";

export interface DispatcherLoopOptions {
	config: DeploymentConfig;
	client: FgsClient;
	runners: ActivityRunners;
	/** 项目常驻容器启动器：loop 负责项目容器生命周期（非 active 立即回收、
	 * active 空闲超时回收、孤儿对账）；执行 runner 通过它 ensure 容器。 */
	launcher: ProjectWorkerLauncher;
	logger?: Logger;
	now?: () => number;
	/**
	 * worker 名后缀（进程唯一）；同名 worker 在服务器语义下等同同一租约，
	 * 两个 dispatcher 并存时会导致同一 step 被双重执行。默认用 pid+随机数
	 * 保证同机多进程互不相同；测试可注入固定值。
	 */
	workerSuffix?: string;
	/** Process one queued PI plugin operation. */
	processPluginOperations?: () => Promise<void>;
}

interface RunningTask {
	projectId: string;
	activity: ActivityType;
	worker: string;
	stepId?: string;
	planningVersion?: number;
	controller: AbortController;
	promise: Promise<void>;
	settled: boolean;
	outcome?: ExecuteOutcome;
	error?: unknown;
}

/**
 * 关闭时等待在途插件操作的上限（毫秒）。
 *
 * 有界等待让 Ctrl-C 的退出时间可预期；超时后操作交回服务端重新排队。
 */
const PLUGIN_SHUTDOWN_WAIT_MS = 30_000;

/** 进程唯一的 worker 后缀：pid + 随机 4 位，避免同名进程互认为同一租约。 */
function defaultWorkerSuffix(): string {
	return `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class DispatcherLoop {
	readonly config: DeploymentConfig;
	private runtime!: RuntimeSettings;
	readonly client: FgsClient;
	readonly runners: ActivityRunners;
	readonly launcher: ProjectWorkerLauncher;

	private readonly log: Logger;
	private readonly now: () => number;
	private readonly workerSuffix: string;
	private readonly tasks = new Set<RunningTask>();
	private readonly runtimeProjectIds = new Set<string>();
	private readonly health: EndpointHealth;
	private readonly containers: ProjectContainerReconciler;
	private readonly dedup: LogDeduplicator;
	private readonly projectCursors = { running: 0, idle: 0 };
	/** 项目最近一次有本地任务的时刻；用于把长期无事可做的项目移出在跑集合。 */
	private readonly projectLastTaskAt = new Map<string, number>();
	private settingsValidated = false;
	private closed = false;
	/** 第一次 close() 的收尾过程；重复调用（信号 + run 的 finally）必须等同一个。 */
	private closing: Promise<void> | null = null;
	private readonly processPluginOperations?: () => Promise<void>;
	/** 在途的插件操作：后台执行，节拍只负责启动，不做等待。 */
	private pluginTask: Promise<void> | null = null;

	constructor(options: DispatcherLoopOptions) {
		this.config = options.config;
		this.client = options.client;
		this.runners = options.runners;
		this.launcher = options.launcher;
		this.log = options.logger ?? consoleLogger;
		this.now = options.now ?? Date.now;
		this.workerSuffix = options.workerSuffix ?? defaultWorkerSuffix();
		this.processPluginOperations = options.processPluginOperations;
		this.health = new EndpointHealth({
			cooldownSeconds: this.config.runtime.endpoint_cooldown,
			threshold: this.config.runtime.endpoint_unhealthy_threshold,
			now: this.now,
			logger: this.log,
		});
		this.containers = new ProjectContainerReconciler({
			launcher: this.launcher,
			client: this.client,
			logger: this.log,
			now: this.now,
			idleSeconds: this.config.container.project_idle_seconds,
			hasRunningTask: (projectId) => this.projectRunningTaskCount(projectId) > 0,
		});
		this.dedup = new LogDeduplicator(this.log);
	}

	async run(options: { once?: boolean } = {}): Promise<void> {
		try {
			await this.launcher.ping();
			// 控制端兜底回收：上一次进程中断留下的过期执行 → lost。
			await this.client.reapExecutions();
			const intervalMs = this.config.runtime.interval * 1000;
			for (;;) {
				if (this.closed) {
					break;
				}
				try {
					await this.tick();
				} catch (err) {
					if (options.once || !(err instanceof ClientError)) {
						throw err;
					}
					this.log.warn(
						`server request failed error=${err.message} retry_in=${this.config.runtime.interval}s`,
					);
					await sleep(intervalMs);
					continue;
				}
				if (options.once) {
					break;
				}
				await sleep(intervalMs);
			}
		} finally {
			await this.close();
		}
	}

	/** 一个调度轮次。导出以供测试；run() 在其外层包装了重试与休眠。 */
	async tick(): Promise<void> {
		if (this.closed) {
			return;
		}
		// 读取失败则本轮不派发，不能静默退回 YAML 中已经失效的并发配置。
		this.runtime = await this.client.getRuntimeSettings();
		this.startPluginOperations();
		if (!this.settingsValidated) {
			await this.validateServerSettings();
			this.settingsValidated = true;
		}
		await this.reap();
		const summaries = await this.client.listSchedulingProjects();
		// close() 可能发生在网络等待期间：此后不得再认领/派发新任务。
		if (this.closed) {
			return;
		}
		this.refreshRuntimeProjects(summaries);
		this.cancelInactiveTasks(summaries);
		await this.containers.sync(summaries);
		await this.dispatchAvailable(summaries);
	}

	async whenIdle(): Promise<void> {
		while (this.tasks.size > 0) {
			await Promise.allSettled([...this.tasks].map((t) => t.promise));
			await this.reap();
		}
	}

	close(): Promise<void> {
		this.closing ??= this.shutdown();
		return this.closing;
	}

	private async shutdown(): Promise<void> {
		this.closed = true;
		for (const task of this.tasks) {
			task.controller.abort("shutdown");
		}
		await this.whenIdle();
		// 它可能正在改写磁盘上的 release 目录，等它收尾再退出（等待上界与理由见
		// PLUGIN_SHUTDOWN_WAIT_MS）。
		if (this.pluginTask !== null) {
			this.log.info("waiting for the in-flight plugin operation before shutdown");
			const timedOut = await Promise.race([
				this.pluginTask.then(() => false),
				// unref：竞速输掉的那支定时器不该拖住进程退出。
				new Promise<true>((resolve) => {
					setTimeout(() => resolve(true), PLUGIN_SHUTDOWN_WAIT_MS).unref?.();
				}),
			]);
			if (timedOut) {
				this.log.warn(
					`plugin operation still running after ${PLUGIN_SHUTDOWN_WAIT_MS / 1000}s; shutting down without it (the server will requeue it)`,
				);
			}
		}
	}

	/**
	 * 插件操作在后台执行，不参与调度节拍。
	 *
	 * 一次安装/更新内含 docker run（超时 10 分钟），此前 tick 直接 await 它：这期间
	 * 不 reap、不取消非活跃项目的任务、也不派发任何 step。串行化本身由服务端的原子
	 * claim 保证（claimNext 只会让一个调用方拿到操作），这里再加一层是为了不堆积
	 * 无意义的重复轮询。
	 */
	private startPluginOperations(): void {
		const process = this.processPluginOperations;
		if (process === undefined || this.pluginTask !== null) {
			return;
		}
		this.pluginTask = process()
			.catch((err: unknown) => {
				// 失败已由实现方上报给控制面；这里只保证异常不变成 unhandled rejection
				// 把 dispatcher 整个打挂（那会让所有项目的调度一起停摆）。
				this.log.warn(
					`plugin operation processing failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			})
			.finally(() => {
				this.pluginTask = null;
			});
	}

	get runningTaskCount(): number {
		return this.tasks.size;
	}

	private async validateServerSettings(): Promise<void> {
		const settings = await this.client.getSettings();
		const interval = this.config.runtime.interval;
		for (const [name, value] of [
			["lease_timeout", settings.lease_timeout],
			["decide_timeout", settings.decide_timeout],
		] as const) {
			if (value <= interval) {
				throw new Error(
					`server ${name}=${value}s must be greater than dispatcher interval=${interval}s`,
				);
			}
			if (value < interval * 2) {
				this.log.warn(`server ${name} is tight ${name}=${value}s interval=${interval}s`);
			}
		}
	}

	private async reap(): Promise<void> {
		for (const task of [...this.tasks]) {
			if (!task.settled) {
				continue;
			}
			this.tasks.delete(task);
			if (this.runtimeProjectIds.has(task.projectId))
				this.projectLastTaskAt.set(task.projectId, this.now());
			const outcome = task.outcome ?? "failed";
			if (task.error !== undefined) {
				this.log.error(
					`task crashed project=${task.projectId} activity=${task.activity} error=${
						task.error instanceof Error ? task.error.message : String(task.error)
					}`,
				);
			} else if (outcome === "cancelled") {
				this.log.info(`task cancelled project=${task.projectId} activity=${task.activity}`);
			} else if (outcome !== "success") {
				this.log.warn(
					`task finished project=${task.projectId} activity=${task.activity} outcome=${outcome}`,
				);
			}
			this.dedup.clearProject(task.projectId);
			if (outcome === "unhealthy") {
				this.health.recordUnhealthy(task.activity, task.projectId);
			} else if (outcome === "success") {
				// 健康的运行证明 endpoint 已恢复；failed/cancelled 的运行
				// 不携带 endpoint 信号，绝不能改动冷却状态。
				this.health.recordSuccess(task.activity, task.projectId);
			}
			if (outcome === "uncertain" && task.activity === "execute") {
				// 走到这里说明「幂等重发 POST + 按 execution_id 对账」都没能确认创建，
				// 即控制端持续不可达。此时释放租约会让可能已运行的 Worker 失去写入权
				// 并造成重复执行；保留租约，交由服务端租约超时兜底。
				continue;
			}
			if (task.activity === "decide") {
				// 成功的 Decide 收尾：CAS 推进服务端规划 checkpoint。
				// 失败/取消不推进，下一次认领会从上次完成的 checkpoint 重新计算触发。
				if (outcome === "success" && task.planningVersion !== undefined) {
					await this.bestEffortCompleteDecide(task.projectId, task.worker, task.planningVersion);
				}
				await this.bestEffortReleaseDecide(task.projectId, task.worker);
			} else if (task.stepId !== undefined) {
				await this.bestEffortReleaseStep(task.projectId, task.stepId, task.worker);
			}
		}
	}

	/**
	 * 在跑集合只保留仍需要占位的项目：非 active 的立即移出；active 但连续
	 * project_idle_seconds 没有任何本地任务的也移出（例如 Decide 连续中断后停止
	 * 触发、或空转抑制后等人工处理），否则它们会永久占住 max_running_projects，
	 * 把其它 active 项目饿死。窗口与项目容器的空闲回收一致。
	 */
	private refreshRuntimeProjects(summaries: SchedulingProject[]): void {
		const statusById = new Map(summaries.map((s) => [s.id, s.status]));
		const idleMs = this.config.container.project_idle_seconds * 1000;
		const now = this.now();
		for (const projectId of [...this.runtimeProjectIds]) {
			const idle =
				this.projectRunningTaskCount(projectId) === 0 &&
				now - (this.projectLastTaskAt.get(projectId) ?? now) >= idleMs;
			if (statusById.get(projectId) !== "active" || idle) {
				this.runtimeProjectIds.delete(projectId);
				this.projectLastTaskAt.delete(projectId);
			}
		}
	}

	private cancelInactiveTasks(summaries: SchedulingProject[]): void {
		const statusById = new Map(summaries.map((s) => [s.id, s.status]));
		for (const task of this.tasks) {
			const status = statusById.get(task.projectId) ?? "deleted";
			if (status !== "active" && !task.controller.signal.aborted) {
				task.controller.abort(status);
				this.log.info(
					`cancelling task of inactive project project=${task.projectId} activity=${task.activity} status=${status}`,
				);
			}
		}
	}

	private async dispatchAvailable(summaries: SchedulingProject[]): Promise<void> {
		if (this.closed) {
			return;
		}
		const maxWorkers = this.runtime.max_workers;
		if (this.tasks.size >= maxWorkers) {
			this.dedup.changed(
				"dispatch/global",
				`skip dispatch: max_workers reached running_tasks=${this.tasks.size}`,
			);
			return;
		}
		const active = summaries.filter((s) => s.status === "active");
		if (active.length === 0) {
			this.dedup.changed("dispatch/global", "skip dispatch: no active projects");
			return;
		}
		const runningProjects = this.orderedProjects(
			"running",
			active.filter((s) => this.runtimeProjectIds.has(s.id)),
		);
		const idleProjects = this.orderedProjects(
			"idle",
			active.filter((s) => !this.runtimeProjectIds.has(s.id)),
		);

		let dispatched = true;
		while (dispatched && this.tasks.size < maxWorkers && !this.closed) {
			dispatched = false;
			for (const summary of runningProjects) {
				if (await this.tryDispatchProject(summary)) {
					dispatched = true;
					if (this.tasks.size >= maxWorkers) {
						return;
					}
				}
			}
			if (dispatched) {
				continue;
			}
			if (this.runningProjectCount(active) >= this.runtime.max_running_projects) {
				this.dedup.changed(
					"dispatch/idle-limit",
					`skip idle project dispatch: max_running_projects reached running_projects=${this.runningProjectCount(active)}`,
				);
				return;
			}
			for (const summary of idleProjects) {
				if (this.runningProjectCount(active) >= this.runtime.max_running_projects) {
					this.dedup.changed(
						"dispatch/idle-limit",
						`stop idle project dispatch: max_running_projects reached running_projects=${this.runningProjectCount(active)}`,
					);
					return;
				}
				if (await this.tryDispatchProject(summary)) {
					dispatched = true;
					break;
				}
			}
		}
	}

	/** 对项目 id 做轮转排序；两个列表各用一个游标，共用时偶数长度的列表永远不轮转。 */
	private orderedProjects<T extends { id: string }>(
		list: keyof DispatcherLoop["projectCursors"],
		summaries: T[],
	): T[] {
		const ordered = rotateProjects(summaries, this.projectCursors[list]);
		if (summaries.length > 0) {
			this.projectCursors[list] += 1;
		}
		return ordered;
	}

	private async tryDispatchProject(summary: SchedulingProject): Promise<boolean> {
		if (this.closed) {
			return false;
		}
		const projectId = summary.id;
		const scope = `project:${projectId}:skip`;
		if (this.projectRunningTaskCount(projectId) >= this.runtime.max_project_workers) {
			this.dedup.changed(
				`${scope}:max_project_workers`,
				`skip project=${projectId}: max_project_workers reached running_tasks=${this.projectRunningTaskCount(projectId)}`,
			);
			return false;
		}
		// Summary is advisory; claim and candidate endpoints recheck current authority.
		const decideRunningLocally = [...this.tasks].some(
			(task) => task.projectId === projectId && task.activity === "decide",
		);
		if (summary.decide_worker !== null || decideRunningLocally) {
			this.dedup.changed(`${scope}:decide_claimed`, `skip project=${projectId}: decide in flight`);
			return false;
		}
		if (await this.dispatchDecide(projectId)) return true;
		if (!summary.has_open_steps || this.closed) return false;
		const view = await this.client.getSchedulingCandidates(projectId, [
			...this.runningStepIds(projectId),
		]);
		if (this.closed) return false;
		if (view.blocked_reason) {
			this.dedup.changed(`${scope}:blocked`, `skip project=${projectId}: ${view.blocked_reason}`);
			return false;
		}
		const candidate = view.candidates[0];
		if (candidate) return this.dispatchExecute(projectId, candidate.id);
		return false;
	}

	/** Claim response contains all project metadata needed to start Decide. */
	private async dispatchDecide(projectId: string): Promise<boolean> {
		if (this.health.coolingDown("decide", projectId)) {
			this.dedup.changed(
				`project:${projectId}:endpoint:decide`,
				`skip decide project=${projectId}: cooling down`,
			);
			return false;
		}
		const worker = this.workerName("decide");
		// 服务端按持久化 checkpoint 计算触发并施加 min_interval 节奏；
		// 无触发返回 409（不创建租约），等价于本项目本轮跳过。
		const claim = await this.client.claimDecide(
			projectId,
			worker,
			this.runtime.decide_min_interval,
		);
		if (claim.statusCode === 403 || claim.statusCode === 409) {
			this.dedup.changed(
				`project:${projectId}:decide:no_trigger`,
				`skip decide project=${projectId}: no server-side trigger`,
			);
			return false;
		}
		if (!claim.ok || !claim.data) {
			this.log.warn(
				`decide claim failed project=${projectId} worker=${worker} status=${claim.statusCode}`,
			);
			return false;
		}
		const trigger = claim.data.trigger;
		const ctx: DecideContext = {
			client: this.client,
			projectId,
			projectTitle: claim.data.title,
			trigger,
			worker,
			planningVersion: claim.data.planning_version,
		};
		if (
			!this.startTask(
				{
					projectId,
					activity: "decide",
					worker,
					planningVersion: claim.data.planning_version,
				},
				(controller) => this.runners.decide(ctx, controller.signal),
			)
		) {
			// close() 与在途 tick 竞态：认领完成时循环已关闭，任务不得启动，
			// 但成功取得的租约必须立即释放。
			await this.bestEffortReleaseDecide(projectId, worker);
			return false;
		}
		this.log.info(`dispatched decide project=${projectId} worker=${worker} trigger=${trigger}`);
		return true;
	}

	private async dispatchExecute(projectId: string, stepId: string): Promise<boolean> {
		if (this.launcher.coolingDown?.(projectId)) {
			this.dedup.changed(
				`project:${projectId}:container`,
				`skip execute project=${projectId}: project container start is backing off`,
			);
			return false;
		}
		if (this.health.coolingDown("execute", projectId)) {
			this.dedup.changed(
				`project:${projectId}:endpoint:execute`,
				`skip execute project=${projectId}: cooling down`,
			);
			return false;
		}
		const worker = this.workerName("execute");
		const claim = await this.client.claimStep(projectId, stepId, worker);
		if (claim.statusCode === 403 || claim.statusCode === 409) {
			// 被规划屏障等挡住时每个节拍都会重复拒绝：只在变化时记一次。
			this.dedup.changed(
				`project:${projectId}:execute_claim`,
				`execute claim rejected project=${projectId} step=${stepId} status=${claim.statusCode}`,
			);
			return false;
		}
		if (!claim.ok) {
			this.log.warn(
				`execute claim failed project=${projectId} step=${stepId} worker=${worker} status=${claim.statusCode}`,
			);
			return false;
		}
		const ctx: ExecuteContext = {
			client: this.client,
			projectId,
			stepId,
			worker,
		};
		if (
			!this.startTask({ projectId, activity: "execute", worker, stepId: stepId }, (controller) =>
				this.runners.execute(ctx, controller.signal),
			)
		) {
			// close() 与在途 tick 竞态：认领完成时循环已关闭，任务不得启动，
			// 但成功取得的租约必须立即释放。
			await this.bestEffortReleaseStep(projectId, stepId, worker);
			return false;
		}
		this.log.info(`dispatched execute project=${projectId} step=${stepId} worker=${worker}`);
		return true;
	}

	/** 注册并启动任务；close() 之后返回 false（不得再新增永不 abort 的任务）。 */
	private startTask(
		init: Pick<RunningTask, "projectId" | "activity" | "worker" | "stepId" | "planningVersion">,
		run: (controller: AbortController) => Promise<ExecuteOutcome>,
	): boolean {
		if (this.closed) {
			return false;
		}
		const task: RunningTask = {
			...init,
			controller: new AbortController(),
			promise: Promise.resolve(),
			settled: false,
		};
		task.promise = Promise.resolve()
			.then(() => run(task.controller))
			.then((outcome) => {
				task.outcome = outcome;
			})
			.catch((err: unknown) => {
				task.outcome = "failed";
				task.error = err;
			})
			.finally(() => {
				task.settled = true;
			});
		this.tasks.add(task);
		this.runtimeProjectIds.add(task.projectId);
		this.projectLastTaskAt.set(task.projectId, this.now());
		this.containers.markBusy(task.projectId);
		this.dedup.clearProject(task.projectId);
		return true;
	}

	private workerName(activity: ActivityType): string {
		if (activity === "execute") {
			// Execute 的 worker 身份就是 execution_id：绑定单次尝试与租约版本。
			return randomUUID();
		}
		return `${activity}:${this.workerSuffix}:${randomUUID()}`;
	}

	private projectRunningTaskCount(projectId: string): number {
		let count = 0;
		for (const task of this.tasks) {
			if (task.projectId === projectId) {
				count += 1;
			}
		}
		return count;
	}

	private runningStepIds(projectId: string): Set<string> {
		const ids = new Set<string>();
		for (const task of this.tasks) {
			if (
				task.projectId === projectId &&
				task.activity === "execute" &&
				task.stepId !== undefined
			) {
				ids.add(task.stepId);
			}
		}
		return ids;
	}

	private runningProjectCount(active: SchedulingProject[]): number {
		let count = 0;
		for (const summary of active) {
			if (this.runtimeProjectIds.has(summary.id)) {
				count += 1;
			}
		}
		return count;
	}

	private async bestEffortReleaseStep(
		projectId: string,
		stepId: string,
		worker: string,
	): Promise<void> {
		const result = await this.client.releaseStep(projectId, stepId, worker);
		if (!result.ok && result.statusCode !== 403 && result.statusCode !== 409) {
			this.log.warn(
				`release failed project=${projectId} step=${stepId} worker=${worker} status=${result.statusCode}`,
			);
		}
	}

	private async bestEffortCompleteDecide(
		projectId: string,
		worker: string,
		planningVersion: number,
	): Promise<void> {
		const result = await this.client.completeDecide(projectId, worker, planningVersion);
		if (!result.ok) {
			// checkpoint 未推进只是让变更在下次认领时重新触发一次；记录告警即可。
			this.log.warn(
				`decide complete failed project=${projectId} worker=${worker} status=${result.statusCode}`,
			);
		}
	}

	private async bestEffortReleaseDecide(projectId: string, worker: string): Promise<void> {
		const result = await this.client.releaseDecide(projectId, worker);
		if (!result.ok && result.statusCode !== 403 && result.statusCode !== 409) {
			this.log.warn(
				`decide release failed project=${projectId} worker=${worker} status=${result.statusCode}`,
			);
		}
	}
}
