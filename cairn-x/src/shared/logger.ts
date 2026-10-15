export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** 输出级别由 LOG_LEVEL 控制；未设置或非法值回落到 info。 */
function logLevel(): number {
	const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
	return raw !== undefined && raw in LEVELS ? LEVELS[raw as keyof typeof LEVELS] : LEVELS.info;
}

export const consoleLogger: Logger = {
	debug: (m) => {
		if (logLevel() <= LEVELS.debug) console.debug(m);
	},
	info: (m) => {
		if (logLevel() <= LEVELS.info) console.log(m);
	},
	warn: (m) => {
		if (logLevel() <= LEVELS.warn) console.warn(m);
	},
	error: (m) => {
		if (logLevel() <= LEVELS.error) console.error(m);
	},
};

let crashHandlersInstalled = false;

/**
 * 安装进程级兜底：未捕获异常与未处理的 Promise rejection 打印堆栈后以非零码退出。
 *
 * Node 默认会直接终止且不给出可诊断上下文；这里至少让日志里有原因，配合容器
 * `restart: unless-stopped` 由编排层拉起。仅由 Node 入口（CLI / Worker）调用。
 */
export function installCrashHandlers(logger: Logger): void {
	if (crashHandlersInstalled) {
		return;
	}
	crashHandlersInstalled = true;
	const handle = (kind: string) => (error: unknown) => {
		logger.error(
			`${kind} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
		process.exit(1);
	};
	process.on("uncaughtException", handle("uncaughtException"));
	process.on("unhandledRejection", handle("unhandledRejection"));
}
