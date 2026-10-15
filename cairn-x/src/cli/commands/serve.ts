import { mkdirSync } from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import type { Command } from "commander";

import { createConfigurationControl, isConfigurationInitialized } from "../../control/index.js";
import {
	ConfigError,
	hostReachable,
	loadDeploymentConfig,
	loadDispatchConfig,
	type DeploymentConfig,
	type DispatchConfig,
} from "../../scheduler/config.js";
import { createApp } from "../../server/app.js";
import { backfillDecideUsageOnStartup } from "../../server/core/usage-backfill.js";
import { openDatabase } from "../../server/db.js";
import type { UploadDeps } from "../../server/modules/uploads.js";
import { TSecBenchClient } from "../../tsecbench/client.js";
import { createBenchmarkService } from "../../tsecbench/service.js";

export function registerServeCommand(program: Command): void {
	program
		.command("serve")
		.description(
			"Run the FGS server + Executor control plane (restricted model proxy, execution protocol)",
		)
		.option("--host <host>", "bind host", "127.0.0.1")
		.option("--port <port>", "bind port", "8000")
		.option(
			"--db-path <path>",
			"SQLite database path",
			process.env.CAIRN_DB_PATH ?? "datas/cairn-x/cairn.db",
		)
		.option(
			"--data-root <path>",
			"data root for session transcripts and configuration",
			process.env.CAIRN_DATA_ROOT ?? "datas/cairn-x",
		)
		.option(
			"--web-user <user>",
			"web console username (env CAIRN_WEB_USER)",
			process.env.CAIRN_WEB_USER ?? "admin",
		)
		.option(
			"--web-password <password>",
			"web console password (env CAIRN_WEB_PASSWORD)",
			process.env.CAIRN_WEB_PASSWORD,
		)
		.option(
			"--api-token <token>",
			"independent machine API token; Bearer auth disabled if unset (env CAIRN_API_TOKEN)",
			process.env.CAIRN_API_TOKEN,
		)
		.option(
			"--config <path>",
			"dispatch config file (enables uploads, model proxy and Worker access)",
			"dispatch.yaml",
		)
		.option(
			"--import-config",
			"import YAML models and runtime settings into a fresh database",
			false,
		)
		.option(
			"--worker-control-url <url>",
			"URL Workers use to reach this control plane (auto-derived by default)",
		)
		.action(
			async (options: {
				host: string;
				port: string;
				dbPath: string;
				dataRoot: string;
				webUser: string;
				webPassword?: string;
				apiToken?: string;
				config: string;
				importConfig: boolean;
				workerControlUrl?: string;
			}) => {
				const port = Number(options.port);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					console.error(`Invalid port: ${options.port}`);
					process.exit(1);
				}
				if (!options.webPassword?.trim()) {
					console.error(
						"Web console password required: pass --web-password or set CAIRN_WEB_PASSWORD",
					);
					process.exit(1);
				}
				const dbPath = path.resolve(options.dbPath);
				mkdirSync(path.dirname(dbPath), { recursive: true });
				const db = openDatabase(dbPath);
				const dataRoot = path.resolve(options.dataRoot);
				// 启动兜底：分派器可能带着一轮没来得及上报的 Decide 用量一起挂掉，而项目
				// 一旦终态就再没有认领来触发补账。会话轨迹与 serve 同目录，扫一遍无活动
				// decide 租约的项目即可把这段丢账补回来。
				const recovered = backfillDecideUsageOnStartup(db, dataRoot, new Date().toISOString());
				if (recovered > 0) {
					console.log(`recovered ${recovered} decide usage event(s) from session transcripts`);
				}

				// Worker 访问控制端的地址：host 部署默认宿主地址；compose 部署
				// 用服务别名显式传入（--worker-control-url）。
				const workerControlUrl =
					options.workerControlUrl ??
					process.env.CAIRN_WORKER_CONTROL_URL ??
					`http://${hostReachable(options.host)}:${port}`;

				let config: DeploymentConfig | DispatchConfig;
				try {
					if (options.importConfig && isConfigurationInitialized(db)) {
						throw new ConfigError(
							"Configuration already initialized; use the web settings to update it. --import-config never overwrites saved settings.",
						);
					}
					config = options.importConfig
						? loadDispatchConfig(options.config)
						: loadDeploymentConfig(options.config);
				} catch (err) {
					db.close();
					console.error(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}

				const uploads: UploadDeps = { root: dataRoot };

				const auth = {
					user: options.webUser,
					password: options.webPassword,
					apiToken: options.apiToken,
				};
				const executor = buildExecutorDeps(config, db, auth, workerControlUrl, dataRoot);
				if (!auth.apiToken?.trim()) {
					console.warn(
						"WARNING: CAIRN_API_TOKEN is not set — the executor control plane (/internal/*) runs without machine authentication.",
					);
					console.warn(
						"Set --api-token / CAIRN_API_TOKEN unless this is a local, isolated deployment.",
					);
				}
				// 模型目录刷新在服务进程后台运行；绝不借由 HTTP 请求或调度循环触发。
				executor.configuration.models.startCatalogRefresh();
				const app = createApp(db, auth, uploads, dataRoot, executor);

				const server = serve({ fetch: app.fetch, hostname: options.host, port }, (info) => {
					console.log(
						`cairn-x server listening on http://${options.host}:${info.port} (db: ${dbPath})`,
					);
					console.log(`executor control plane: workers connect via ${workerControlUrl}`);
					if (typeof process.send === "function") {
						process.send({
							type: "ready",
							port: info.port,
							url: `http://${options.host}:${info.port}`,
						});
					}
				});
				let shuttingDown = false;
				const shutdown = () => {
					if (shuttingDown) return;
					shuttingDown = true;
					executor.configuration.models.stopCatalogRefresh();
					const forceClose = setTimeout(() => {
						if ("closeAllConnections" in server) server.closeAllConnections();
					}, 10_000);
					forceClose.unref?.();
					server.close(() => {
						clearTimeout(forceClose);
						db.close();
						process.exit(0);
					});
				};
				process.on("SIGINT", shutdown);
				process.on("SIGTERM", shutdown);
			},
		);
}

/** serve 的执行协议 + 受限模型代理依赖组装。 */
function buildExecutorDeps(
	config: DeploymentConfig | DispatchConfig,
	db: ReturnType<typeof openDatabase>,
	auth: { user: string; password: string; apiToken?: string },
	workerControlUrl: string,
	dataRoot: string,
) {
	const configuration = createConfigurationControl(db, dataRoot, config);
	// TSecBench 评测：平台 token 只由 serve 进程持有，Worker 经执行协议代理。
	const benchmark =
		config.benchmark === undefined
			? undefined
			: createBenchmarkService({
					client: new TSecBenchClient({
						baseUrl: config.benchmark.base_url,
						token: config.benchmark.token,
					}),
					config: config.benchmark,
					db,
				});
	const executions = {
		configuration,
		benchmark,
		db,
		auth,
		workerControlUrl,
		bash_timeout_seconds: config.tasks.execute.bash_timeout,
		dataRoot,
	};
	return { executions, configuration };
}
