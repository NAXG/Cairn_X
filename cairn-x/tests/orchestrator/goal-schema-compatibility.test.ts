import { expect, test } from "vitest";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";

import { FgsClient } from "../../src/orchestrator/client.js";
import { decideTools } from "../../src/orchestrator/tools/graph.js";

function goalTool() {
	return decideTools(new FgsClient("http://unused"), "schema-probe", { worker: "probe" }).find(
		(tool) => tool.name === "goal",
	)!;
}

test("goal exposes evidence types to parsers that only inspect top-level properties", () => {
	const goal = goalTool();
	const { properties } = goal.parameters as {
		properties: Record<string, { type?: string; items?: { type?: string }; enum?: string[] }>;
	};
	expect(properties?.from?.type).toBe("array");
	expect(properties.from.items?.type).toBe("object");
	expect(properties.action).toMatchObject({ type: "string", enum: ["add", "remove", "achieve"] });

	// vLLM's Qwen parser uses this top-level type to decode XML argument text.
	const rawEvidence = '[{"type":"fact","id":"f001"}]';
	const args = {
		action: "achieve",
		goal_id: "goal",
		description: "File content verified",
		from: properties.from.type === "array" ? JSON.parse(rawEvidence) : rawEvidence,
	};
	expect(
		validateToolArguments(goal, {
			type: "toolCall",
			id: "goal-achieve",
			name: "goal",
			arguments: args,
		}),
	).toEqual(args);
});

test.each<JsonObject>([
	{ action: "add", description: "New subgoal" },
	{ action: "remove", goal_id: "g001" },
	{
		action: "achieve",
		goal_id: "goal",
		description: "Verified",
		from: [{ type: "fact", id: "f001" }],
	},
])("top-level goal declarations preserve the $action branch", (args) => {
	const goal = goalTool();
	expect(
		validateToolArguments(goal, {
			type: "toolCall",
			id: "goal-valid",
			name: "goal",
			arguments: args,
		}),
	).toEqual(args);
});

test.each<JsonObject>([
	{ action: "add", description: "New subgoal", from: [{ type: "fact", id: "f001" }] },
	{ action: "remove", goal_id: "g001", description: "Not valid for removal" },
	{ action: "achieve", goal_id: "goal", description: "Missing evidence" },
	{ action: "achieve", goal_id: "goal", description: "Invalid evidence", from: [] },
])("goal still rejects cross-branch fields and incomplete evidence: %j", (args) => {
	expect(() =>
		validateToolArguments(goalTool(), {
			type: "toolCall",
			id: "goal-invalid",
			name: "goal",
			arguments: args,
		}),
	).toThrow();
});
