/**
 * Worker 容器入口（项目常驻模式）：进程常驻，循环用项目令牌领取 queued
 * execution，并在单容器内并发执行多个 step。
 *
 *   CAIRN_PROJECT_ID       项目 id
 *   CAIRN_PROJECT_TOKEN    项目令牌（只存哈希；容器停止即失效）
 *   CAIRN_PROJECT_CONCURRENCY 并发执行上限（默认 4）
 *   CAIRN_CONTROL_URL      活动模型通道与执行协议同源的控制端地址
 *
 * 安全属性：容器内没有 docker CLI / socket / 长期模型 key / 数据库凭据；
 * 所有控制端接口校验执行身份与租约状态；执行令牌由容器向控制端换取
 * （领取任务时现签，终态即失效），项目令牌只用于领取任务与保活。
 */

import { consoleLogger, installCrashHandlers } from "../shared/logger.js";
import { workerWorkspaceDir } from "./agent.js";
import { ProjectWorkerClient } from "./project-client.js";
import { runProjectWorkerLoop } from "./project-loop.js";

const PROJECT_ID = process.env.CAIRN_PROJECT_ID ?? "";
const PROJECT_TOKEN = process.env.CAIRN_PROJECT_TOKEN ?? "";
const CONTROL_URL = process.env.CAIRN_CONTROL_URL ?? "";

/**
 * 项目常驻 Worker：循环领取任务并并发执行 step，SIGTERM 时中止在途 step。
 * 退出码：2 = 环境变量缺失，3 = 项目令牌被拒（控制端已归档），0 = 正常停止。
 */
async function main(): Promise<number> {
	installCrashHandlers(consoleLogger);
	if (PROJECT_ID === "" || PROJECT_TOKEN === "" || CONTROL_URL === "") {
		consoleLogger.error(
			"project worker requires CAIRN_CONTROL_URL, CAIRN_PROJECT_ID and CAIRN_PROJECT_TOKEN",
		);
		return 2;
	}
	const parsed = Number.parseInt(process.env.CAIRN_PROJECT_CONCURRENCY ?? "4", 10);
	const maxConcurrency = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 4;
	const logger = consoleLogger;
	const client = new ProjectWorkerClient(CONTROL_URL, PROJECT_ID, PROJECT_TOKEN);
	const stop = new AbortController();
	const sigterm = (): void => {
		logger.warn("project worker received SIGTERM: aborting in-flight steps");
		stop.abort("SIGTERM");
	};
	process.on("SIGTERM", sigterm);
	process.on("SIGINT", sigterm);
	try {
		const result = await runProjectWorkerLoop({
			client,
			workspaceDir: workerWorkspaceDir(),
			maxConcurrency,
			logger,
			signal: stop.signal,
		});
		logger.info(
			`project worker loop finished reason=${result.reason} completed=${result.completed}`,
		);
		return result.reason === "unauthorized" ? 3 : 0;
	} finally {
		process.off("SIGTERM", sigterm);
		process.off("SIGINT", sigterm);
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		consoleLogger.error(
			`worker fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
		);
		process.exit(1);
	});
