import { expect, test } from "vitest";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";

import { executionResultSubmissionSchema } from "../../src/contracts/execution.js";
import { toolSchema } from "../../src/shared/toolkit.js";
import { FgsClient } from "../../src/orchestrator/client.js";
import { decideTools } from "../../src/orchestrator/tools/graph.js";
import { createWorkerGraphTools, ExecutionResultCollector } from "../../src/worker/graphtools.js";
import { createWorkerBenchmarkTools } from "../../src/worker/benchmarktools.js";
import type { WorkerClient } from "../../src/worker/client.js";

const samples: Record<string, JsonObject> = {
	get_graph: { view: "planning" },
	read_evidence: { type: "fact", id: "origin" },
	add_step: { from: ["origin"], description: "Inspect the target" },
	abandon_step: { step_id: "s001" },
	add_route: { description: "Test the authentication boundary" },
	set_step_priority: { step_id: "s001", priority: 3 },
	goal: {
		action: "achieve",
		goal_id: "goal",
		description: "Acceptance verified",
		from: [{ type: "fact", id: "origin" }],
	},
	submit_fact: {
		description: "Observed behavior",
		confidence: "observed",
		evidence: [{ kind: "event", execution_id: "past-execution", seq: 12 }],
	},
	submit_finding: { title: "Verified finding", description: "Reproduction evidence" },
	signal_planner: { reason: "The target differs from the plan" },
	search_execution_events: { query: "observed behavior" },
	get_execution_trace: { execution_id: "past-execution" },
	submit_result: {
		schema_version: 1,
		task_status: "satisfied",
		summary: "Verified",
		unresolved: [],
	},
	benchmark_status: {},
	benchmark_submit_flag: { flag: "flag{verified}" },
	benchmark_hint: { reason: "The required entry point could not be located" },
	benchmark_reset: {},
};

test("Cairn tool schemas accept valid inputs and reject undeclared arguments", () => {
	const client = {} as WorkerClient;
	const tools = [
		...decideTools(new FgsClient("http://unused"), "project", { worker: "planner" }),
		...createWorkerGraphTools({ client, resultCollector: new ExecutionResultCollector() }),
		...createWorkerBenchmarkTools({ client }),
	];
	expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(samples).sort());
	for (const tool of tools) {
		expect(tool.description.trim(), tool.name).not.toBe("");
		expect(tool.parameters, tool.name).toMatchObject({ type: "object" });
		if (tool.name === "submit_result") {
			expect(tool.parameters).toEqual(toolSchema(executionResultSubmissionSchema));
			const invalidResults: JsonObject[] = [
				{ summary: "   " },
				{ unresolved: ["\t"] },
				{ task_status: "wrong" },
			];
			for (const patch of invalidResults)
				expect(() =>
					validateToolArguments(tool, {
						type: "toolCall",
						id: "invalid-result",
						name: tool.name,
						arguments: { ...samples.submit_result, ...patch },
					}),
				).toThrow();
		}
		const call = { type: "toolCall" as const, id: "schema-probe", name: tool.name };
		const args = samples[tool.name];
		expect(validateToolArguments(tool, { ...call, arguments: args }), tool.name).toEqual(args);
		expect(
			() => validateToolArguments(tool, { ...call, arguments: { ...args, unexpected: true } }),
			tool.name,
		).toThrow();
	}
});
