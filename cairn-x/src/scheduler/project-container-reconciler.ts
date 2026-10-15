import type { SchedulingProject } from "../contracts/scheduling.js";
import type { FgsClient } from "../orchestrator/client.js";
import type { Logger } from "../shared/logger.js";
import type { ProjectWorkerLauncher } from "./launcher.js";

export interface ProjectContainerReconcilerOptions {
	launcher: ProjectWorkerLauncher;
	client: FgsClient;
	logger: Logger;
	now: () => number;
	/** 项目容器的空闲回收窗口（秒），与 refreshRuntimeProjects 一致。 */
	idleSeconds: number;
	/** 该项目本地是否有在途任务。 */
	hasRunningTask: (projectId: string) => boolean;
}

/**
 * 项目常驻容器的生命周期对账：
 * - 项目已非 active（含已删除）→ 立即回收；
 * - 容器非 running（崩溃/退出）→ 回收，下一次派发会重建；
 * - active 且 running 但无运行中的任务，空闲超过 idleSeconds → 回收。
 *
 * dispatcher 重启后内存里没有忙碌记录：首次看到某个 active 项目容器时记为
 * 「此刻刚活跃」，从观察到起算空闲，避免重启即误杀仍在跑 step 的容器。
 */
export class ProjectContainerReconciler {
	private readonly busyAt = new Map<string, number>();
	private warned = false;

	constructor(private readonly options: ProjectContainerReconcilerOptions) {}

	/** 任务启动时记为忙碌；绝不回收有在途 step 的容器。 */
	markBusy(projectId: string): void {
		this.busyAt.set(projectId, this.options.now());
	}

	async sync(summaries: SchedulingProject[]): Promise<void> {
		const { launcher, logger, now } = this.options;
		let containers: Array<{ name: string; state: string }>;
		try {
			containers = await launcher.listManaged();
			this.warned = false;
		} catch (err) {
			if (!this.warned) {
				this.warned = true;
				logger.warn(
					`project container reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		if (containers.length === 0) {
			this.busyAt.clear();
			return;
		}
		const statusById = new Map(summaries.map((s) => [s.id, s.status]));
		const busyProjects = new Set(summaries.filter((s) => s.has_claimed_steps).map((s) => s.id));
		const idleMs = this.options.idleSeconds * 1000;
		const nowMs = now();
		const seen = new Set<string>();
		for (const container of containers) {
			const projectId = launcher.projectIdForContainer(container.name);
			if (projectId !== null) {
				seen.add(projectId);
			}
			if (
				projectId !== null &&
				(this.options.hasRunningTask(projectId) ||
					(statusById.get(projectId) === "active" &&
						container.state === "running" &&
						busyProjects.has(projectId)))
			) {
				// 有在途 step：刷新忙碌时刻，绝不回收。
				this.busyAt.set(projectId, nowMs);
				continue;
			}
			const status = projectId === null ? undefined : statusById.get(projectId);
			if (projectId === null || status !== "active" || container.state !== "running") {
				await this.reclaim(
					container.name,
					projectId,
					`project=${projectId ?? "unknown"} status=${status ?? "deleted"} state=${container.state}`,
				);
				if (projectId !== null) {
					this.busyAt.delete(projectId);
				}
				continue;
			}
			const since = this.busyAt.get(projectId) ?? nowMs;
			this.busyAt.set(projectId, since);
			if (nowMs - since >= idleMs) {
				const removed = await this.reclaim(
					container.name,
					projectId,
					`project=${projectId} idle=${Math.round((nowMs - since) / 1000)}s`,
				);
				if (removed) this.busyAt.delete(projectId);
			}
		}
		// 容器已消失的项目不再记账，避免 map 随历史项目无限增长。
		for (const projectId of [...this.busyAt.keys()]) {
			if (!seen.has(projectId)) {
				this.busyAt.delete(projectId);
			}
		}
	}

	private async reclaim(name: string, projectId: string | null, detail: string): Promise<boolean> {
		const { launcher, logger } = this.options;
		let removed: boolean;
		try {
			removed = await launcher.remove(name);
		} catch (err) {
			logger.warn(
				`project worker container reclaim failed ${name} (${detail}): ${err instanceof Error ? err.message : String(err)}; will retry`,
			);
			return false;
		}
		if (!removed) {
			// 回收失败（daemon 拒绝等）时留痕，下一轮 tick 重试；此时不吊销令牌，
			// 否则会把一个可能仍在运行的容器变成不断 401 的幽灵。
			logger.warn(`project worker container reclaim failed ${name} (${detail}); will retry`);
			return false;
		}
		logger.info(`reclaimed project worker container ${name} (${detail})`);
		if (projectId !== null) {
			// 容器已回收 → 令牌已无意义：把注册行同步标 stopped，避免
			// /internal/project-workers 留下 status=running 的幽灵记录。
			await this.stopProjectWorker(projectId);
		}
		return true;
	}

	private async stopProjectWorker(projectId: string): Promise<void> {
		const { client, logger } = this.options;
		const result = await client.stopProjectWorker(projectId);
		if (!result.ok && result.statusCode !== 404 && result.statusCode !== 409) {
			logger.warn(`project worker stop failed project=${projectId} status=${result.statusCode}`);
		}
	}
}
