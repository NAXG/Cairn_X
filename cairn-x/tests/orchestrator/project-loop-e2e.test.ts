import { inspectClientProject } from "../support/project-state.js";
/**
 * 项目常驻循环的端到端验证：真实 Worker 主循环 + 真实执行控制面（HTTP），
 * LLM 通过 faux provider 脚本化。证明默认执行器（runWorkerExecution +
 * finalizeWorkerRun）在项目常驻容器模式下能完整走通：
 *   项目令牌 → next() → 现签执行令牌 → claim → submit_fact → conclude
 *   → result 落库（succeeded）。
 */

import { fauxAssistantMessage, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getExecutionRow } from "../../src/server/core/executions.js";
import { ProjectWorkerClient } from "../../src/worker/project-client.js";
import { runProjectWorkerLoop } from "../../src/worker/project-loop.js";
import {
	addStep,
	createProject,
	scriptConnectionWithFaux,
	silentLogger,
	startExecutorTestServer,
} from "./helpers.js";

const MACHINE_TOKEN = "test-token";

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition not met before timeout");
}

test(
	"project worker loop executes a real step via the default runner",
	{ timeout: 60_000 },
	async () => {
		const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("submit_fact", {
						confidence: "observed",
						description: "project-loop fact observed",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("submit_result", {
						schema_version: 1,
						task_status: "inconclusive",
						summary: "Explored: nothing more to report.",
						unresolved: [],
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const server = await startExecutorTestServer({
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "sk-long-term-upstream-key",
		});
		await scriptConnectionWithFaux(server.control, "imported-execute", faux);

		const pid = await createProject(server.client);
		const sid = await addStep(server.client, pid, { description: "find the flag" });
		const executionId = randomUUID();
		expect((await server.client.claimStep(pid, sid, executionId)).ok).toBe(true);
		const created = await server.client.createExecution({
			project_id: pid,
			step_id: sid,
			execution_id: executionId,
		});
		expect(created.ok).toBe(true);

		const tokenRes = await fetch(`${server.url}/internal/project-workers/${pid}/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${MACHINE_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({ container_name: "cairn-pw-e2e" }),
		});
		expect(tokenRes.status).toBe(201);
		const projectToken = ((await tokenRes.json()) as { token: string }).token;

		const workspace = mkdtempSync(path.join(tmpdir(), "cairn-pw-e2e-"));
		const stop = new AbortController();
		const loop = runProjectWorkerLoop({
			client: new ProjectWorkerClient(server.url, pid, projectToken),
			workspaceDir: workspace,
			maxConcurrency: 2,
			logger: silentLogger,
			signal: stop.signal,
			pollIntervalMs: 25,
			heartbeatIntervalMs: 10_000,
		});
		try {
			await waitUntil(() => getExecutionRow(server.db, executionId).status === "succeeded", 30_000);
		} finally {
			stop.abort();
			await loop;
			rmSync(workspace, { recursive: true, force: true });
		}

		const execution = getExecutionRow(server.db, executionId);
		expect(execution.status).toBe("succeeded");
		const project = await inspectClientProject(server.client, pid);
		expect(project.steps.find((s) => s.id === sid)!.status).toBe("concluded");
		expect(project.facts.some((f) => f.description.includes("project-loop fact observed"))).toBe(
			true,
		);
		expect(project.steps.find((s) => s.id === sid)!.result?.produced.fact_ids).toHaveLength(1);
		expect(project.usage.execute.input_tokens).toBeGreaterThan(0);
	},
);
