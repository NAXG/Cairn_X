import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import { createCairnToolResultHook } from "../../src/shared/tool-result-hooks.js";
import { makeTool, toolResult } from "../../src/shared/toolkit.js";
import { createWorkerGraphTools } from "../../src/worker/graphtools.js";
import { createWorkerBenchmarkTools } from "../../src/worker/benchmarktools.js";
import type { WorkerClient } from "../../src/worker/client.js";
import { decideTools } from "../../src/orchestrator/tools/graph.js";
import { ClientError, type FgsClient } from "../../src/orchestrator/client.js";

async function run(
	tool: AgentTool,
	params: Parameters<typeof fauxToolCall>[1],
	previous?: Agent["afterToolCall"],
	retry = false,
) {
	const faux = fauxProvider();
	const runtime = createModels();
	runtime.setProvider(faux.provider);
	const call = () =>
		fauxAssistantMessage([fauxToolCall(tool.name, params)], { stopReason: "toolUse" });
	faux.setResponses([call(), ...(retry ? [call()] : []), fauxAssistantMessage("Recovered")]);
	const agent = new Agent({
		initialState: { model: faux.getModel(), tools: [tool] },
		streamFn: (model, context, options) => runtime.streamSimple(model, context, options),
		afterToolCall: createCairnToolResultHook([tool], previous),
	});
	await agent.prompt("Use the tool, inspect its result and recover if necessary.");
	return agent.state.messages.filter((message) => message.role === "toolResult");
}

test("returned HTTP errors are flagged and the agent can retry successfully", async () => {
	const submitFact = vi
		.fn()
		.mockResolvedValueOnce({ ok: false, statusCode: 400, text: "invalid evidence" })
		.mockResolvedValueOnce({ ok: true, statusCode: 201, data: { id: "f001" }, text: "" });
	const tool = createWorkerGraphTools({ client: { submitFact } as unknown as WorkerClient }).find(
		(entry) => entry.name === "submit_fact",
	)!;
	const results = await run(
		tool,
		{ description: "observed", confidence: "observed" },
		undefined,
		true,
	);
	expect(submitFact).toHaveBeenCalledTimes(2);
	expect(results.map((result) => result.isError)).toEqual([true, false]);
	expect(results[0].content).toEqual([{ type: "text", text: "ERROR 400: invalid evidence" }]);
	expect(results[0].details).toEqual({ error: true });
});

test("malformed fact arguments are rejected before calling the controller", async () => {
	const submitFact = vi.fn();
	const tool = createWorkerGraphTools({ client: { submitFact } as unknown as WorkerClient }).find(
		(entry) => entry.name === "submit_fact",
	)!;
	const results = await run(tool, { confidence: "observed" });
	expect(submitFact).not.toHaveBeenCalled();
	expect(results).toHaveLength(1);
	expect(results[0].isError).toBe(true);
	expect(JSON.stringify(results[0].content)).toContain("Validation failed");
});

test("get_graph's separately constructed tool participates in error normalization", async () => {
	const tool = decideTools(
		{
			readDecideGraph: async () => {
				throw new ClientError("stale lease", 409, "lease lost");
			},
		} as unknown as FgsClient,
		"project",
		{ worker: "planner" },
	).find((entry) => entry.name === "get_graph")!;
	const results = await run(tool, { view: "planning" });
	expect(results[0]).toMatchObject({ isError: true, details: { error: true, statusCode: 409 } });
});

test("extensions see normalized failures and keep their content/details overrides", async () => {
	const tool = makeTool("submit_fact", "Fact", "Record", Type.Object({}), async () =>
		toolResult("ERROR 409: sensitive error", { error: true }),
	);
	const previous = vi.fn<NonNullable<Agent["afterToolCall"]>>(async () => ({
		content: [{ type: "text", text: "Redacted failure" }],
		details: { redacted: true },
		isError: false,
	}));
	const results = await run(tool, {}, previous);
	expect(previous.mock.calls[0][0].isError).toBe(true);
	expect(results[0]).toMatchObject({
		isError: true,
		content: [{ type: "text", text: "Redacted failure" }],
		details: { redacted: true },
	});
});

test("PI/plugin tools retain their own result and hook semantics", async () => {
	const original = toolResult("Native output", { error: true });
	const tool: AgentTool = {
		name: "read",
		label: "Read",
		description: "Foreign tool",
		parameters: Type.Object({}),
		execute: async () => original,
	};
	const previous = vi.fn<NonNullable<Agent["afterToolCall"]>>(async () => undefined);
	const results = await run(tool, {}, previous);
	expect(previous.mock.calls[0][0].isError).toBe(false);
	expect(results[0]).toMatchObject({ isError: false, ...original });
});

test("literal ERROR text in successful data does not turn it into a failure", async () => {
	const tool = makeTool("submit_fact", "Fact", "Record", Type.Object({}), async () =>
		toolResult("Recorded text: ERROR 409 appeared in the log", { id: "f001" }),
	);
	expect((await run(tool, {}))[0].isError).toBe(false);
});

test("a wrong benchmark flag remains a valid business response", async () => {
	const tool = createWorkerBenchmarkTools({
		client: {
			benchmarkSubmit: async () => ({
				ok: true,
				statusCode: 200,
				text: "",
				data: {
					correct: false,
					awarded: 0,
					correct_flag_count: 0,
					total_flag_count: 1,
				},
			}),
		} as unknown as WorkerClient,
	}).find((entry) => entry.name === "benchmark_submit_flag")!;
	const results = await run(tool, { flag: "incorrect" });
	expect(results[0].isError).toBe(false);
	expect(results[0].content[0]).toMatchObject({ text: expect.stringContaining("REJECTED") });
});

test("a signal quota response does not become a tool execution failure", async () => {
	const tool = createWorkerGraphTools({
		client: {
			signalPlanner: async () => ({
				ok: true,
				statusCode: 200,
				text: "",
				data: {
					status: "limit_reached",
					accepted: false,
					count: 3,
					limit: 3,
				},
			}),
		} as unknown as WorkerClient,
	}).find((entry) => entry.name === "signal_planner")!;
	expect((await run(tool, { reason: "new prerequisite missing" }))[0].isError).toBe(false);
});
