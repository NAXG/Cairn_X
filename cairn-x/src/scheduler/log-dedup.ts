import type { Logger } from "../shared/logger.js";

/**
 * 变更才记录的日志去重：同一 scope 反复输出同一条消息只落一次，直到消息变化或
 * 被 clearProject 清掉。调度器每个节拍都会重复「跳过」类原因，用它避免刷屏。
 */
export class LogDeduplicator {
	private readonly state = new Map<string, string>();
	constructor(private readonly logger: Logger) {}

	changed(scope: string, message: string): void {
		if (this.state.get(scope) === message) {
			return;
		}
		this.state.set(scope, message);
		this.logger.info(message);
	}

	clearProject(projectId: string): void {
		const prefix = `project:${projectId}:`;
		for (const scope of [...this.state.keys()]) {
			if (scope.startsWith(prefix)) {
				this.state.delete(scope);
			}
		}
	}
}
