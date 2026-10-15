import { inspectClientProject } from "../support/project-state.js";
/**
 * 模拟端到端测试：真实服务器 + 真实 loop + 真实 runner，LLM 通过
 * faux provider 脚本化。完整流程：
 *
 *   创建项目 → decide（trigger="initial"）创建首个具体 step →
 *   execute 提交一条 fact 并结束 step → fact 数量增加触发
 *   decide → decide 完成项目。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DockerProjectWorkerLauncher } from "../../src/scheduler/launcher.js";

import { fauxAssistantMessage, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";

import type { DispatchConfig } from "../../src/scheduler/config.js";
import { createDecideRunner } from "../../src/agents/decide/runner.js";
import { createProjectExecuteRunner } from "../../src/scheduler/execute.js";
import type { RunnerDeps } from "../../src/agents/decide/runner.js";
import { consoleLogger } from "../../src/shared/logger.js";
import { DispatcherLoop } from "../../src/scheduler/loop.js";
import {
	createProject,
	scriptConnectionWithFaux,
	silentLogger,
	startExecutorTestServer,
	testConfig,
} from "./helpers.js";
import { WorkerInProcessLauncher } from "./worker-launcher.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const dataRoots: string[] = [];

afterEach(() => {
	for (const dir of dataRoots.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const DOCKER_E2E_TIMEOUT = process.env.CAIRN_TEST_DOCKER === "1" ? 90_000 : 30_000;
/** 同样避开生产前缀 cairn-pw-，避免被生产 dispatcher 误回收；可用 env 覆盖。 */
const E2E_CONTAINER_PREFIX = process.env.CAIRN_TEST_E2E_CONTAINER_PREFIX ?? "cairn-rel001-";

class CapturingDockerLauncher extends DockerProjectWorkerLauncher {
	readonly diagnostics: string[] = [];
	override async remove(handle: string): Promise<boolean> {
		if (!this.diagnostics.some((entry) => entry.startsWith(`== ${handle} ==`))) {
			try {
				const inspect = execFileSync(
					"docker",
					["inspect", "--format", "status={{.State.Status}} exit={{.State.ExitCode}}", handle],
					{ encoding: "utf8" },
				);
				const logs = execFileSync("docker", ["logs", "--tail", "80", handle], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
				this.diagnostics.push(`== ${handle} ==\n${inspect}\n${logs}`);
			} catch (error) {
				this.diagnostics.push(`== ${handle} ==\n诊断采集失败: ${String(error)}`);
			}
		}
		return super.remove(handle);
	}
}

test(
	"full journey: initial decide creates step → execute submits fact → decide completes",
	async () => {
		// 配置化路径下 decide / execute 是控制面上两条独立连接，各自脚本化。
		const decideFaux = fauxProvider({ provider: "cairn-x-faux-decide", api: "openai-completions" });
		decideFaux.setResponses([
			fauxAssistantMessage([fauxToolCall("get_graph", { view: "planning" })], {
				stopReason: "toolUse",
			}),
			// Decide（initial），第 1 轮：创建首个具体 step。
			fauxAssistantMessage(
				[
					fauxToolCall("add_step", {
						from: ["origin"],
						description: "search the target for the flag file",
					}),
				],
				{ stopReason: "toolUse" },
			),
			// Decide（initial），第 2 轮：收尾文本。
			fauxAssistantMessage("Created the first exploration step."),
			// Decide（fact 触发），第 1 轮：现有 fact 已足以证明根 goal。
			fauxAssistantMessage([fauxToolCall("get_graph", { view: "planning" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("goal", {
						action: "achieve",
						goal_id: "goal",
						from: [
							{ type: "fact", id: "origin" },
							{ type: "fact", id: "f001" },
						],
						description: "facts prove the root goal",
					}),
				],
				{ stopReason: "toolUse" },
			),
			// Decide（fact 触发），第 2 轮：最终文本。
			fauxAssistantMessage("Goal satisfied by the submitted facts."),
		]);
		const executeFaux = fauxProvider({
			api: "openai-completions",
		});
		executeFaux.setResponses([
			// Execute，第 1 轮：在运行中提交已确认的 fact。
			fauxAssistantMessage(
				[
					fauxToolCall("submit_fact", {
						confidence: "observed",
						description: "flag found: ctfflag{hello}",
					}),
				],
				{
					stopReason: "toolUse",
				},
			),
			// Execute，第 2 轮：结构化提交并结束本步骤。
			fauxAssistantMessage(
				[
					fauxToolCall("submit_result", {
						schema_version: 1,
						task_status: "satisfied",
						summary: "The flag ctfflag{hello} was found in /root/flag.txt.",
						unresolved: [],
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const realDocker = process.env.CAIRN_TEST_DOCKER === "1";
		if (
			realDocker &&
			(!process.env.CAIRN_TEST_NETWORK ||
				process.env.CAIRN_TEST_NETWORK === "cairn-workers" ||
				!process.env.CAIRN_TEST_CONTROL_HOST)
		) {
			throw new Error(
				"Docker E2E requires an isolated CAIRN_TEST_NETWORK and CAIRN_TEST_CONTROL_HOST",
			);
		}
		const server = await startExecutorTestServer(
			{
				api: "openai-completions",
				base_url: "http://unused",
				api_key: "sk-long-term",
			},
			realDocker
				? {
						listenHost: process.env.CAIRN_TEST_CONTROL_HOST!,
						controlHost: process.env.CAIRN_TEST_CONTROL_HOST,
					}
				: {},
		);
		await scriptConnectionWithFaux(server.control, "imported-decide", decideFaux);
		await scriptConnectionWithFaux(server.control, "imported-execute", executeFaux);
		const config: DispatchConfig = testConfig(server.url, {
			runtime: { interval: 1, decide_min_interval: 0, max_workers: 4 },
			models: {
				decide: {
					model_id: "faux-decide",
					base_url: "http://unused",
					api: "openai-completions",
					api_key: "test",
				},
				execute: {
					model_id: "faux-execute",
					base_url: "http://unused",
					api: "openai-completions",
					api_key: "test",
				},
			},
			tasks: {
				execute: {
					step_timeout: 30,
					harvest_timeout: 180,
					bash_timeout: 120,
				},
			},
		});
		const dataRoot = mkdtempSync(path.join(tmpdir(), "cairn-x-e2e-"));
		dataRoots.push(dataRoot);

		const launcher = realDocker
			? new CapturingDockerLauncher({
					image: process.env.CAIRN_TEST_WORKER_IMAGE ?? "cairn-x-worker:latest",
					network: process.env.CAIRN_TEST_NETWORK!,
					controlUrl: server.url,
					dataRoot: server.dataRoot,
					dataHostRoot: server.dataRoot,
					containerPrefix: E2E_CONTAINER_PREFIX,
					autoRemove: false,
					resources: { cpus: 1, memoryMb: 768, pidsLimit: 128 },
					stopGraceSeconds: 5,
				})
			: new WorkerInProcessLauncher({
					controlUrl: server.url,
					logger: silentLogger,
				});
		if (realDocker) {
			await launcher.ping();
			for (const { name } of await launcher.listManaged()) await launcher.remove(name);
		}
		const projectId = await createProject(server.client);
		if (realDocker) {
			// Do not let the test dispatcher reconcile unrelated production workers.
			const list = launcher.listManaged.bind(launcher);
			launcher.listManaged = async () => {
				const rows = server.db
					.prepare("SELECT DISTINCT project_id FROM executions")
					.all() as Array<{ project_id: string }>;
				const own = new Set(rows.map(({ project_id }) => launcher.containerName(project_id)));
				return (await list()).filter(({ name }) => own.has(name));
			};
		}
		const deps: RunnerDeps = { client: server.client, logger: silentLogger, dataRoot };
		const loop = new DispatcherLoop({
			config,
			client: server.client,
			runners: {
				decide: createDecideRunner(deps),
				execute: createProjectExecuteRunner({
					config,
					client: server.client,
					projectLauncher: launcher,
					logger: realDocker ? consoleLogger : silentLogger,
				}),
			},
			launcher,
			logger: realDocker ? consoleLogger : silentLogger,
		});

		const run = loop.run();
		const deadline = Date.now() + (realDocker ? 20_000 : 30_000);
		try {
			while (true) {
				const project = await inspectClientProject(server.client, projectId);
				if (project.project.status === "completed") {
					break;
				}
				if (Date.now() > deadline) {
					const executions = server.db
						.prepare(
							"SELECT e.id,e.status,e.error,e.summary,e.exit_code,COUNT(ev.seq) AS events FROM executions e LEFT JOIN execution_events ev ON ev.execution_id=e.id GROUP BY e.id",
						)
						.all();
					const containers = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
						encoding: "utf8",
					})
						.split("\n")
						.filter((line) => line.startsWith(E2E_CONTAINER_PREFIX));
					const logs =
						launcher instanceof CapturingDockerLauncher ? launcher.diagnostics.join("\n") : "";
					throw new Error(
						`项目未完成\n${JSON.stringify({ status: project.project.status, steps: project.steps, executions, containers }, null, 2)}\n${logs}`,
					);
				}
				await sleep(100);
			}
			if (realDocker) {
				// 项目已终态：dispatcher 下一轮 reconcile 会回收常驻容器。等它真的回收，
				// 而不是 close()（close 不做容器回收）后立刻断言，避免把异步回收当成泄漏。
				const reclaimDeadline = Date.now() + 15_000;
				while ((await launcher.listManaged()).length > 0) {
					if (Date.now() > reclaimDeadline) {
						throw new Error("dispatcher did not reclaim the project container");
					}
					await sleep(100);
				}
			}
		} finally {
			await loop.close();
			await run;
		}

		const project = await inspectClientProject(server.client, projectId);
		expect(project.project.status).toBe("completed");
		expect(project.facts.some((f) => f.description.includes("flag found: ctfflag{hello}"))).toBe(
			true,
		);
		expect(project.steps.some((s) => s.status === "concluded")).toBe(true);
		expect(project.steps.every((s) => s.creator !== "orchestrator")).toBe(true);
		expect(project.goals.find((g) => g.id === "goal")!.status).toBe("achieved");
		// 两种 activity 都记录了用量。
		expect(project.usage.execute.input_tokens).toBeGreaterThan(0);
		expect(project.usage.decide.input_tokens).toBeGreaterThan(0);
		if (realDocker) {
			expect(
				execFileSync("docker", ["ps", "-aq", "--filter", `name=${E2E_CONTAINER_PREFIX}`], {
					encoding: "utf8",
				}).trim(),
			).toBe("");
		}
	},
	DOCKER_E2E_TIMEOUT,
);
