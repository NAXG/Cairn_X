import type { ActivityType } from "../contracts/activity.js";
import type { Logger } from "../shared/logger.js";

/**
 * 端点冷却：一次 unhealthy 只让其自身项目冷却一个窗口；同一 activity 连续
 * unhealthy（中间没有成功）超过阈值则整个 activity 冷却。
 */
export class EndpointHealth {
	private readonly activityHealth = new Map<ActivityType, { consecutive: number; until: number }>();
	private readonly projectCooldownUntil = new Map<string, number>();

	constructor(
		private readonly options: {
			cooldownSeconds: number;
			threshold: number;
			now: () => number;
			logger: Logger;
		},
	) {}

	coolingDown(activity: ActivityType, projectId: string): boolean {
		const now = this.options.now();
		if ((this.activityHealth.get(activity)?.until ?? 0) > now) {
			return true;
		}
		return (this.projectCooldownUntil.get(`${activity}:${projectId}`) ?? 0) > now;
	}

	/** 一次成功的运行证明 endpoint 已恢复；failed/cancelled 不带信号，绝不改状态。 */
	recordSuccess(activity: ActivityType, projectId: string): void {
		this.activityHealth.delete(activity);
		this.projectCooldownUntil.delete(`${activity}:${projectId}`);
	}

	recordUnhealthy(activity: ActivityType, projectId: string): void {
		const { cooldownSeconds, threshold, logger } = this.options;
		const cooldownMs = cooldownSeconds * 1000;
		this.projectCooldownUntil.set(`${activity}:${projectId}`, this.options.now() + cooldownMs);
		const health = this.activityHealth.get(activity) ?? { consecutive: 0, until: 0 };
		health.consecutive += 1;
		if (health.consecutive >= threshold) {
			health.consecutive = 0;
			health.until = this.options.now() + cooldownMs;
			logger.info(
				`endpoint cooling down activity=${activity} consecutive_unhealthy=${threshold} retry_after=${cooldownSeconds}s`,
			);
		} else {
			logger.info(
				`project cooling down project=${projectId} activity=${activity} consecutive_unhealthy=${health.consecutive} retry_after=${cooldownSeconds}s`,
			);
		}
		this.activityHealth.set(activity, health);
	}
}
