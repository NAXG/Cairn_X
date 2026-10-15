import { inspectClientProject } from "../support/project-state.js";
/** Opt-in release acceptance: real Docker workers, isolated DB/network, no paid model calls. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	fauxAssistantMessage,
	fauxToolCall,
	fauxProvider,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { DockerProjectWorkerLauncher } from "../../src/scheduler/launcher.js";
import {
	addStep,
	createProject,
	scriptConnectionWithFaux,
	startExecutorTestServer,
} from "./helpers.js";

const enabled = process.env.CAIRN_TEST_DOCKER === "1";
const network = process.env.CAIRN_TEST_NETWORK;
const controlHost = process.env.CAIRN_TEST_CONTROL_HOST;
const image = process.env.CAIRN_TEST_WORKER_IMAGE ?? "cairn-x-worker:latest";
/**
 * 容器名前缀必须避开生产 dispatcher 的默认前缀（cairn-pw-）。否则生产 dispatcher
 * 会把验收容器当成本项目孤儿，在下一轮 reconcile 里直接回收，执行永远到不了终态。
 * 可用 CAIRN_TEST_CONTAINER_PREFIX 覆盖。
 */
const containerPrefix = process.env.CAIRN_TEST_CONTAINER_PREFIX ?? "cairn-reltest-";

async function waitFor(check: () => Promise<boolean>, timeout = 45000) {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Docker acceptance condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

for (const cancel of [false, true]) {
	test.skipIf(!enabled)(
		`real Docker Worker: ${cancel ? "cancel running bash and revoke token" : "bash, facts, findings and cleanup"}`,
		async () => {
			if (!network || !controlHost || network === "cairn-workers") {
				throw new Error("Set CAIRN_TEST_NETWORK (not production) and CAIRN_TEST_CONTROL_HOST");
			}
			if (containerPrefix.startsWith("cairn-pw-")) {
				throw new Error(
					"CAIRN_TEST_CONTAINER_PREFIX must not collide with the production worker prefix cairn-pw-",
				);
			}
			const server = await startExecutorTestServer(
				{ api: "openai-completions", base_url: "http://unused", api_key: "release-test-key" },
				{ listenHost: "0.0.0.0", controlHost },
			);
			const faux = fauxProvider({ provider: "release-faux", api: "openai-completions" });
			const call = (name: string, args: JsonObject) =>
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
			faux.setResponses(
				cancel
					? [call("bash", { command: "sleep 120" }), fauxAssistantMessage("Cancelled.")]
					: [
							call("bash", { command: "printf 'release-0.0.1-ok' > /workspace/release.txt" }),
							call("submit_fact", {
								description: "Docker release evidence saved",
								confidence: "observed",
							}),
							call("submit_finding", {
								title: "Release smoke",
								description: "Real worker completed",
							}),
							fauxAssistantMessage("Execution complete."),
							fauxAssistantMessage("Harvest complete."),
						],
			);
			await scriptConnectionWithFaux(server.control, "imported-execute", faux);
			// 每次验收使用独立数据库和附件目录。
			server.db
				.prepare("UPDATE counters SET value=? WHERE name='project'")
				.run(Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16));
			const projectId = await createProject(server.client);
			const stepId = await addStep(server.client, projectId);
			const executionId = randomUUID();
			expect((await server.client.claimStep(projectId, stepId, executionId)).ok).toBe(true);
			const created = await server.client.createExecution({
				project_id: projectId,
				step_id: stepId,
				execution_id: executionId,
			});
			expect(created.ok).toBe(true);
			const launcher = new DockerProjectWorkerLauncher({
				image,
				network,
				controlUrl: server.url,
				dataRoot: server.dataRoot,
				dataHostRoot: server.dataRoot,
				containerPrefix,
				autoRemove: true,
				resources: { cpus: 1, memoryMb: 768, pidsLimit: 128 },
				stopGraceSeconds: 5,
			});
			let handle: string | undefined;
			try {
				await launcher.ping();
				handle = await launcher.ensure({
					projectId,
					issueToken: async () => {
						const issued = await server.client.issueProjectWorkerToken(
							projectId,
							launcher.containerName(projectId),
						);
						if (!issued.ok || issued.data === undefined) {
							throw new Error(`project token issue failed: ${issued.statusCode}`);
						}
						return issued.data.token;
					},
					concurrency: 1,
				});
				const state = () =>
					server.db.prepare("SELECT status FROM executions WHERE id=?").get(executionId) as {
						status: string;
					};
				if (cancel) {
					await waitFor(async () => state().status === "running");
					// Wait for the actual child process, not just the worker claim.
					await waitFor(async () => {
						try {
							return execFileSync("docker", ["top", handle!, "-eo", "pid,args"], {
								encoding: "utf8",
							}).includes("sleep 120");
						} catch {
							return false;
						}
					});
					const response = await fetch(`${server.url}/internal/executions/${executionId}/cancel`, {
						method: "POST",
						headers: { Authorization: "Bearer test-token" },
					});
					expect(response.ok).toBe(true);
					await waitFor(async () => state().status === "cancelled");
				} else {
					await waitFor(async () => state().status === "succeeded");
					const project = await inspectClientProject(server.client, projectId);
					expect(project.facts.some((f) => f.description === "Docker release evidence saved")).toBe(
						true,
					);
					expect(
						server.db
							.prepare("SELECT count(*) AS n FROM findings WHERE project_id=?")
							.get(projectId),
					).toEqual({ n: 1 });
					expect(
						(
							server.db
								.prepare("SELECT count(*) AS n FROM execution_events WHERE execution_id=?")
								.get(executionId) as { n: number }
						).n,
					).toBeGreaterThan(0);
				}
				const denied = await fetch(`${server.url}/internal/executions/${executionId}/heartbeat`, {
					method: "POST",
					headers: {
						Authorization: "Bearer dead-execution-token",
						"Content-Type": "application/json",
					},
					body: "{}",
				});
				expect([401, 403, 409]).toContain(denied.status);
			} finally {
				if (handle) {
					await launcher.remove(handle);
					await waitFor(async () => !(await launcher.listManaged()).some((c) => c.name === handle));
				}
			}
		},
		90000,
	);
}
