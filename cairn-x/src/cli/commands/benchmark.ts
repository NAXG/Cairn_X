import type { Command } from "commander";

import { FgsClient } from "../../orchestrator/client.js";
import { type DispatchConfig, loadBenchmarkConfig } from "../../scheduler/config.js";
import { consoleLogger } from "../../shared/logger.js";
import { TSecBenchClient } from "../../tsecbench/client.js";
import { BenchmarkDriver } from "../../tsecbench/driver.js";

export function registerBenchmarkCommand(program: Command): void {
	program
		.command("benchmark")
		.description("Drive TSecBench challenges (bind projects, track progress, release containers)")
		.option("--config <path>", "dispatch config file", "dispatch.yaml")
		.option(
			"--api-token <token>",
			"server API token (env CAIRN_API_TOKEN)",
			process.env.CAIRN_API_TOKEN,
		)
		.option("--interval <seconds>", "reconcile interval in seconds", "30")
		.option("--once", "run a single reconcile pass and exit", false)
		.option("--challenge <code...>", "only these challenge unique_code(s)")
		.option("--list", "list platform challenges and exit", false)
		.option("--doctor", "check platform and server connectivity, then exit", false)
		.option(
			"--rebind",
			"drop existing bindings for the selected challenges so they are re-created",
			false,
		)
		.action(
			async (options: {
				config: string;
				apiToken?: string;
				interval: string;
				once: boolean;
				challenge?: string[];
				list: boolean;
				doctor: boolean;
				rebind: boolean;
			}) => {
				const intervalSeconds = Number(options.interval);
				if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
					console.error(`Invalid interval: ${options.interval}`);
					process.exit(1);
				}
				// driver 不需要模型凭据：只加载 server 与 benchmark（见 loadBenchmarkConfig）。
				let config: ReturnType<typeof loadBenchmarkConfig>;
				try {
					config = loadBenchmarkConfig(options.config);
				} catch (err) {
					console.error(err instanceof Error ? err.message : String(err));
					process.exit(1);
				}
				const client = new FgsClient(config.server, 20_000, options.apiToken);
				const benchmark = config.benchmark;

				if (options.doctor) {
					await runBenchmarkDoctor(benchmark, client);
					return;
				}
				if (benchmark === undefined) {
					console.error(
						"benchmark integration is not configured: add a 'benchmark' section to the config " +
							"or set BENCHMARK_TOKEN (and optionally BENCHMARK_BASE_URL).",
					);
					process.exit(1);
				}
				if (options.rebind) {
					try {
						const tasks = await client.listBenchmarkTasks();
						const wanted = options.challenge ?? [];
						for (const task of tasks) {
							if (wanted.length > 0 && !wanted.includes(task.unique_code)) continue;
							const reset = await client.resetBenchmark(task.project_id);
							await client.setProjectStatus(task.project_id, "stopped");
							console.log(
								`[benchmark] reset ${task.unique_code} project=${task.project_id} ` +
									`deleted=${reset.data?.deleted ?? false}`,
							);
						}
					} catch (err) {
						console.error(`rebind failed: ${err instanceof Error ? err.message : String(err)}`);
						process.exit(1);
					}
				}
				if (options.list) {
					const listed = await client.listBenchmarkChallenges();
					if (!listed.ok || listed.data === undefined) {
						console.error(`list challenges failed: ${listed.statusCode} ${listed.text}`);
						process.exit(1);
					}
					for (const challenge of listed.data) {
						console.log(
							`${challenge.is_completed ? "[done]" : "[    ]"} ${challenge.unique_code} ` +
								`flags=${challenge.correct_flag_count}/${challenge.flag_count} ` +
								`score=${challenge.total_score} container=${challenge.container_status} ` +
								`addr=${challenge.container_addr.join(",") || "-"}`,
						);
					}
					return;
				}

				const driver = new BenchmarkDriver({
					client,
					config: benchmark,
					logger: consoleLogger,
					only: options.challenge,
					intervalSeconds,
					onPass: (summary) => {
						console.log(
							`[benchmark] pass challenges=${summary.challenges} bound=${summary.bound} ` +
								`completed=${summary.completed} closed=${summary.closed} skipped=${summary.skipped}` +
								(summary.errors.length > 0 ? ` errors=${summary.errors.length}` : ""),
						);
						for (const error of summary.errors) console.error(`[benchmark] error: ${error}`);
					},
				});
				if (options.once) {
					await driver.reconcileOnce();
					return;
				}
				const controller = new AbortController();
				const stop = () => controller.abort();
				process.on("SIGINT", stop);
				process.on("SIGTERM", stop);
				await driver.run(controller.signal);
			},
		);
}

/** benchmark --doctor：分别探测平台直连、serve 代理与 FGS 服务器可达性。 */
async function runBenchmarkDoctor(
	benchmark: DispatchConfig["benchmark"],
	client: FgsClient,
): Promise<void> {
	let failed = false;
	if (benchmark === undefined) {
		console.error("benchmark config: MISSING (add a 'benchmark' section or set BENCHMARK_TOKEN)");
		failed = true;
	} else {
		console.log(
			`benchmark config: base_url=${benchmark.base_url} max_active=${benchmark.max_active}`,
		);
		const platform = new TSecBenchClient({
			baseUrl: benchmark.base_url,
			token: benchmark.token,
		});
		const listed = await platform.listChallenges();
		if (listed.ok) {
			console.log(`platform direct: OK (${listed.data.length} challenge(s))`);
		} else {
			console.error(`platform direct: FAIL [${listed.error.code}] ${listed.error.message}`);
			failed = true;
		}
	}
	try {
		const proxied = await client.listBenchmarkChallenges();
		if (proxied.ok && proxied.data !== undefined) {
			console.log(`server proxy: OK (${proxied.data.length} challenge(s))`);
		} else {
			console.error(`server proxy: FAIL [${proxied.statusCode}] ${proxied.text.slice(0, 200)}`);
			failed = true;
		}
	} catch (err) {
		console.error(`server proxy: FAIL ${err instanceof Error ? err.message : String(err)}`);
		failed = true;
	}
	try {
		const projects = await client.listSchedulingProjects();
		console.log(`FGS server: OK (${projects.length} project(s))`);
	} catch (err) {
		console.error(`FGS server: FAIL ${err instanceof Error ? err.message : String(err)}`);
		failed = true;
	}
	if (failed) process.exit(1);
}
