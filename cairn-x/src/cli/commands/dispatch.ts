import path from "node:path";

import type { Command } from "commander";

import { createDecideRunner, type RunnerDeps } from "../../agents/decide/runner.js";
import type { ExecutionContainerConfig } from "../../environments/execution-manager.js";
import { FgsClient } from "../../orchestrator/client.js";
import { formatHealthcheckSummary, runModelHealthchecks } from "../../orchestrator/healthcheck.js";
import { PluginManager } from "../../plugins/manager.js";
import { PluginStore } from "../../plugins/store.js";
import {
	ConfigError,
	loadDeploymentConfig,
	loadDispatchConfig,
	workerControlUrl,
	type DeploymentConfig,
} from "../../scheduler/config.js";
import { createProjectExecuteRunner } from "../../scheduler/execute.js";
import { DockerProjectWorkerLauncher } from "../../scheduler/launcher.js";
import { DispatcherLoop } from "../../scheduler/loop.js";
import type { ActivityRunners } from "../../scheduler/types.js";
import { openDatabase } from "../../server/db.js";
import { consoleLogger } from "../../shared/logger.js";

export function registerDispatchCommand(program: Command): void {
	program
		.command("dispatch")
		.description(
			"Run the dispatcher (leases steps, manages one Worker container per active project)",
		)
		.option("--config <path>", "dispatch config file", "dispatch.yaml")
		.option(
			"--data-root <path>",
			"data root shared with serve (sessions, decide resources)",
			process.env.CAIRN_DATA_ROOT ?? "datas/cairn-x",
		)
		.option("--once", "run a single scheduling round and exit", false)
		.option(
			"--startup-healthcheck-only",
			"test the YAML import endpoints (not saved DB settings) and exit",
			false,
		)
		.option(
			"--api-token <token>",
			"server API token (env CAIRN_API_TOKEN)",
			process.env.CAIRN_API_TOKEN,
		)
		.option("--server-url <url>", "override the FGS server URL")
		.option(
			"--data-host-root <path>",
			"Docker host path for the shared data root (env CAIRN_DATA_HOST_ROOT)",
			process.env.CAIRN_DATA_HOST_ROOT,
		)
		.option(
			"--worker-control-url <url>",
			"override the URL Worker containers use to reach the server",
		)
		.option("--container-prefix <prefix>", "Worker container name prefix")
		.action(
			async (options: {
				config: string;
				dataRoot: string;
				once: boolean;
				startupHealthcheckOnly: boolean;
				apiToken?: string;
				serverUrl?: string;
				dataHostRoot?: string;
				workerControlUrl?: string;
				containerPrefix?: string;
			}) => {
				let config: DeploymentConfig;
				try {
					config = loadDeploymentConfig(options.config);
				} catch (err) {
					if (err instanceof ConfigError) {
						console.error(err.message);
						process.exit(1);
					}
					throw err;
				}
				if (options.startupHealthcheckOnly) {
					const results = await runModelHealthchecks(
						loadDispatchConfig(options.config),
						config.healthcheck.timeout,
						consoleLogger,
					);
					if (results.every((result) => result.ok)) {
						process.exit(0);
					}
					console.error(`model health checks failed:\n${formatHealthcheckSummary(results)}`);
					process.exit(1);
				}
				const serverUrl = options.serverUrl ?? config.server;
				const dataRoot = path.resolve(options.dataRoot);
				const dataHostRoot = path.resolve(
					options.dataHostRoot ?? process.env.CAIRN_DATA_HOST_ROOT ?? dataRoot,
				);
				const client = new FgsClient(serverUrl, 10_000, options.apiToken);
				// Plugin packages are prepared by the dispatcher in its own runtime. The
				// Server only queues operations and records the published release.
				const pluginDb = openDatabase(path.join(dataRoot, "cairn.db"));
				try {
					const pluginStore = new PluginStore(pluginDb);
					const pluginManager = new PluginManager(
						dataRoot,
						pluginStore,
						config.container.image,
						dataHostRoot,
					);
					let pluginBusy = false;
					const processPluginOperations = async () => {
						if (pluginBusy) return;
						for (const role of ["decide", "execute"] as const) {
							const claimed = await client.claimPluginOperation(role, `dispatcher-${process.pid}`);
							if (!claimed.ok || !claimed.data || pluginBusy) continue;
							pluginBusy = true;
							const operation = claimed.data;
							const leaseRefresh = setInterval(() => {
								try {
									const current = pluginStore.getOperation(operation.id);
									if (
										current?.status === "running" &&
										current.worker === `dispatcher-${process.pid}`
									)
										pluginStore.updateOperation(current.id, {});
								} catch (error) {
									consoleLogger.warn(`plugin lease refresh failed: ${String(error)}`);
								}
							}, 60_000);
							leaseRefresh.unref?.();
							try {
								const result = await pluginManager.run(claimed.data);
								if (result === "deferred") {
									pluginStore.deferOperation(claimed.data.id, "等待正在使用此插件的活动结束");
									continue;
								}
								await client.finishPluginOperation(claimed.data.id, {
									ok: true,
									release: pluginStore.list(role),
								});
							} catch (error) {
								await client.finishPluginOperation(claimed.data.id, {
									ok: false,
									message: error instanceof Error ? error.message : String(error),
								});
							} finally {
								clearInterval(leaseRefresh);
								pluginBusy = false;
							}
						}
					};
					const containerConfig = containerConfigFrom(config, {
						dataRoot,
						dataHostRoot,
						workerControlUrl: options.workerControlUrl,
						containerPrefix: options.containerPrefix,
					});
					// 一个 active 项目一个常驻容器，容器内并发执行多个 step。
					const launcher = new DockerProjectWorkerLauncher(containerConfig);
					const deps: RunnerDeps = {
						client,
						logger: consoleLogger,
						dataRoot: path.resolve(options.dataRoot),
					};
					const runners: ActivityRunners = {
						decide: createDecideRunner(deps),
						execute: createProjectExecuteRunner({
							config,
							client,
							projectLauncher: launcher,
							logger: consoleLogger,
						}),
					};
					const loop = new DispatcherLoop({
						config,
						client,
						runners,
						launcher,
						logger: consoleLogger,
						processPluginOperations,
					});
					await launcher.validateRuntime();
					const shutdown = () => {
						void loop.close();
					};
					process.on("SIGINT", shutdown);
					process.on("SIGTERM", shutdown);
					try {
						await loop.run({ once: options.once });
					} finally {
						process.off("SIGINT", shutdown);
						process.off("SIGTERM", shutdown);
					}
				} finally {
					pluginDb.close();
				}
			},
		);
}

/** dispatch.yaml 的 container 段 → 执行环境管理器/启动器的通用配置。 */
function containerConfigFrom(
	config: DeploymentConfig,
	overrides: {
		dataRoot: string;
		dataHostRoot: string;
		workerControlUrl?: string;
		containerPrefix?: string;
	} = { dataRoot: path.resolve("datas/cairn-x"), dataHostRoot: path.resolve("datas/cairn-x") },
): ExecutionContainerConfig {
	return {
		image: config.container.image,
		network: config.container.network,
		dataRoot: overrides.dataRoot,
		dataHostRoot: overrides.dataHostRoot,
		containerPrefix: overrides.containerPrefix,
		// 默认从 server 的 host 推导（见 workerControlUrl）：compose 部署必须用
		// 服务别名，只有宿主 loopback 才换成 host.docker.internal。
		controlUrl: overrides.workerControlUrl ?? workerControlUrl(config),
		resources: {
			cpus: config.container.cpus,
			memoryMb: config.container.memory_mb,
			pidsLimit: config.container.pids_limit,
		},
		stopGraceSeconds: config.container.stop_grace_seconds,
		autoRemove: config.container.auto_remove,
	};
}
