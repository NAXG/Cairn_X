import { expect, test } from "vitest";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionBenchmarkContext } from "../../src/contracts/execution.js";
import { createWorkerBenchmarkTools } from "../../src/worker/benchmarktools.js";
import type { WorkerClient } from "../../src/worker/client.js";

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

const challenge: ExecutionBenchmarkContext = {
	unique_code: "web_01",
	title: "[web_01] SQL injection",
	description: "SQL injection",
	difficulty: "easy",
	level: 1,
	total_score: 100,
	flag_count: 2,
	correct_flag_count: 1,
	hint_used: false,
	container_status: "available",
	container_addr: ["10.0.0.9:80"],
};

function fakeClient(overrides: Record<string, unknown> = {}): WorkerClient {
	return {
		benchmarkStatus: async () => ({ statusCode: 200, ok: true, data: challenge, text: "" }),
		benchmarkReset: async () => ({ statusCode: 200, ok: true, data: challenge, text: "" }),
		benchmarkHint: async (_reason: string) => ({
			statusCode: 200,
			ok: true,
			data: { hint: "use sqlmap" },
			text: "",
		}),
		benchmarkSubmit: async () => ({
			statusCode: 200,
			ok: true,
			data: {
				correct: true,
				awarded: 50,
				cumulative_score: 50,
				correct_flag_count: 2,
				total_flag_count: 2,
				matched_flag_index: 1,
			},
			text: "",
		}),
		...overrides,
	} as unknown as WorkerClient;
}

function tool(client: WorkerClient, name: string): AgentTool {
	const found = createWorkerBenchmarkTools({ client }).find((t) => t.name === name);
	if (found === undefined) throw new Error(`missing tool ${name}`);
	return found as AgentTool;
}

test("exposes only the step-scoped benchmark tool set", () => {
	const names = createWorkerBenchmarkTools({ client: fakeClient() }).map((t) => t.name);
	expect(names).toEqual([
		"benchmark_status",
		"benchmark_submit_flag",
		"benchmark_hint",
		"benchmark_reset",
	]);
});

test("benchmark_status renders progress and target address", async () => {
	const result = await tool(fakeClient(), "benchmark_status").execute("c1", {});
	const text = toolText(result);
	expect(text).toContain("web_01");
	expect(text).toContain("1/2");
	expect(text).toContain("10.0.0.9:80");
});

test("a correct submission reports progress and points at submit_fact", async () => {
	const result = await tool(fakeClient(), "benchmark_submit_flag").execute("c1", {
		flag: "flag{x}",
	});
	const text = toolText(result);
	expect(text).toContain("ACCEPTED");
	expect(text).toContain("progress 2/2");
	expect(text).toContain("submit_fact");
});

test("an incorrect submission is reported without an exception", async () => {
	const client = fakeClient({
		benchmarkSubmit: async () => ({
			statusCode: 200,
			ok: true,
			data: {
				correct: false,
				awarded: 0,
				cumulative_score: 0,
				correct_flag_count: 1,
				total_flag_count: 2,
				matched_flag_index: null,
			},
			text: "",
		}),
	});
	const text = toolText(
		await tool(client, "benchmark_submit_flag").execute("c1", { flag: "nope" }),
	);
	expect(text).toContain("REJECTED");
});

test("a duplicate submission is explained as an idempotent no-op", async () => {
	const client = fakeClient({
		benchmarkSubmit: async () => ({
			statusCode: 409,
			ok: false,
			data: undefined,
			text: JSON.stringify({ code: "duplicate", message: "already submitted" }),
		}),
	});
	const text = toolText(
		await tool(client, "benchmark_submit_flag").execute("c1", { flag: "flag{x}" }),
	);
	expect(text).toContain("duplicate");
	expect(text).not.toContain("ERROR");
});

test("benchmark_reset rebuilds the container and flags the state loss", async () => {
	const text = toolText(await tool(fakeClient(), "benchmark_reset").execute("c1", {}));
	expect(text).toContain("10.0.0.9:80");
	expect(text).toContain("rebuilt");
});

test("hint requires an explicit reason and warns about the score penalty", async () => {
	const reasons: string[] = [];
	const client = fakeClient({
		benchmarkHint: async (reason: string) => {
			reasons.push(reason);
			return { statusCode: 200, ok: true, data: { hint: "use sqlmap" }, text: "" };
		},
	});
	const text = toolText(
		await tool(client, "benchmark_hint").execute("c1", {
			reason: "blind timing is unreliable and the intended parameter is unknown",
		}),
	);
	expect(text).toContain("use sqlmap");
	expect(text).toContain("score is now reduced");
	expect(reasons).toEqual(["blind timing is unreliable and the intended parameter is unknown"]);
});
