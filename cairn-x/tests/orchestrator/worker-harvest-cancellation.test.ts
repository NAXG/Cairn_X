import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";

import { finalizeWorkerRun, runWorkerExecution } from "../../src/worker/agent.js";
import {
	addStep,
	claimExecutionWithProjectWorker,
	createProject,
	scriptConnectionWithFaux,
	silentLogger,
	startExecutorTestServer,
} from "./helpers.js";

test.each(["external", "controller", "lease"] as const)(
	"%s interruption during harvest does not conclude the step as succeeded",
	async (interruption) => {
		const server = await startExecutorTestServer({
			api: "openai-completions",
			base_url: "http://unused",
			api_key: "test",
		});
		const stop = new AbortController();
		const executionId = randomUUID();
		let harvesting = false;
		const faux = fauxProvider({ provider: "cairn-harvest-cancel", api: "openai-completions" });
		faux.setResponses([
			fauxAssistantMessage("Exploration finished; delivery is still pending."),
			async (_context, options) => {
				harvesting = true;
				if (interruption === "external") stop.abort("SIGTERM");
				if (interruption === "controller") {
					expect((await server.client.requestExecutionCancel(executionId)).ok).toBe(true);
				}
				// Hold the harvest request until cancellation propagates through the real HTTP stream.
				const signal = options!.signal!;
				if (!signal.aborted) {
					await new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
				return fauxAssistantMessage("Interrupted harvest");
			},
		]);
		await scriptConnectionWithFaux(server.control, "imported-execute", faux);
		const projectId = await createProject(server.client);
		const stepId = await addStep(server.client, projectId);
		expect((await server.client.claimStep(projectId, stepId, executionId)).ok).toBe(true);
		expect(
			(
				await server.client.createExecution({
					project_id: projectId,
					step_id: stepId,
					execution_id: executionId,
				})
			).ok,
		).toBe(true);
		const { task, worker } = await claimExecutionWithProjectWorker(server, projectId, executionId);
		// Keep every renewal fast: an early heartbeat must not restore the production interval.
		const heartbeat = worker.heartbeat.bind(worker);
		vi.spyOn(worker, "heartbeat").mockImplementation(async () => {
			if (interruption === "lease" && harvesting)
				return { ok: false, statusCode: 403, text: "lease revoked", data: undefined };
			const response = await heartbeat();
			return {
				...response,
				data: response.data && { ...response.data, heartbeat_interval_s: 1 },
			};
		});
		const result = await runWorkerExecution({
			task: { ...task, heartbeat_interval_s: 0.01 },
			client: worker,
			workspaceDir: server.dataRoot,
			logger: silentLogger,
			signal: stop.signal,
		});
		await finalizeWorkerRun(worker, result, silentLogger);

		const expected = interruption === "lease" ? "failed" : "cancelled";
		expect(faux.state.callCount).toBe(2);
		expect(result.outcome).toBe(expected);
		expect(result.healthReason).toBeUndefined();
		expect(result.leaseFailure).toEqual(
			interruption === "lease" ? { statusCode: 403, text: "lease revoked" } : null,
		);
		expect((await server.client.getExecution(executionId)).data?.status).toBe(expected);
		expect(
			server.db
				.prepare("SELECT status FROM steps WHERE project_id = ? AND id = ?")
				.get(projectId, stepId),
		).not.toEqual({ status: "concluded" });
	},
);
