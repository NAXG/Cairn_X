import { expect, test } from "vitest";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	executionResultSubmissionSchema,
	type EscalationAck,
} from "../../src/contracts/execution.js";
import { createWorkerGraphTools, ExecutionResultCollector } from "../../src/worker/graphtools.js";
import type { WorkerClient } from "../../src/worker/client.js";
import { initialMessage } from "../../src/worker/agent.js";

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}
test("submit_result records one structured result and rejects a conflicting rewrite", async () => {
	let stopped = 0;
	const collector = new ExecutionResultCollector(() => {
		stopped += 1;
	});
	const tools = createWorkerGraphTools({
		client: {} as WorkerClient,
		resultCollector: collector,
	});
	const submit = tools.find((entry) => entry.name === "submit_result") as AgentTool;
	expect(submit.parameters).toMatchObject({ required: expect.arrayContaining(["task_status"]) });
	const body = {
		schema_version: 1,
		task_status: "satisfied",
		summary: "done",
		unresolved: [],
	};
	const accepted = await submit.execute("call-1", body);
	expect(toolText(accepted)).toContain("accepted locally");
	expect(toolText(accepted)).toContain("server persistence");
	expect(accepted.details).toMatchObject({ accepted: true, persisted: false });
	expect(collector.result).toEqual(body);
	expect(stopped).toBe(1);
	expect(toolText(await submit.execute("call-2", body))).toContain("already accepted");
	expect(stopped).toBe(1);
	expect(
		toolText(
			await submit.execute("call-3", {
				...body,
				summary: "changed",
			}),
		),
	).toContain("ERROR 409");
	expect(collector.result?.summary).toBe("done");
	expect(toolText(await submit.execute("call-4", { ...body, task_status: "blocked" }))).toContain(
		"ERROR 409",
	);
	expect(collector.result?.task_status).toBe("satisfied");
});

/**
 * 交付契约必须在工具侧就拦下服务端会拒绝的载荷。
 *
 * 曾经的失效链：工具回 "accepted" 并触发 requestStop()，服务端却以 400 拒绝同一份
 * 载荷，整轮探索的交付就此丢失。判定必须与 /result 用同一份 schema。
 */
test("submit_result refuses payloads the delivery contract would reject", async () => {
	const collector = new ExecutionResultCollector();
	const submit = createWorkerGraphTools({
		client: {} as WorkerClient,
		resultCollector: collector,
	}).find((entry) => entry.name === "submit_result") as AgentTool;
	const body = { schema_version: 1, task_status: "satisfied", summary: "done", unresolved: [] };

	// 模型可见的 parameters 必须声明不接受额外键，让它在第一次就写对。
	expect(submit.parameters).toMatchObject({ additionalProperties: false });

	// 服务端 .strict() 拒绝额外键；TypeBox 只描述形状，得由契约判定兜住。
	expect(toolText(await submit.execute("call-1", { ...body, confidence: "high" }))).toContain(
		"ERROR 400",
	);
	// 服务端先 trim 再判长度：全空白的摘要与未决项同样会被拒。
	expect(toolText(await submit.execute("call-2", { ...body, summary: "   " }))).toContain(
		"ERROR 400",
	);
	expect(toolText(await submit.execute("call-3", { ...body, unresolved: ["  "] }))).toContain(
		"ERROR 400",
	);

	// 关键：被拒的载荷绝不能置位 collector —— 置位即 requestStop()，交付随之丢失。
	expect(collector.result).toBeNull();

	// 合法载荷照常接受，并在提交前归一化：服务端看到的就是归一化后的值。
	expect(
		toolText(await submit.execute("call-4", { ...body, summary: "  ok  ", unresolved: [" q "] })),
	).toContain("accepted");
	expect(collector.result).toEqual({ ...body, summary: "ok", unresolved: ["q"] });

	// 不变量：工具接受的结果，服务端契约必然接受（判定与最终校验同源）。
	expect(executionResultSubmissionSchema.safeParse(collector.result).success).toBe(true);
});

/**
 * 升级上报让执行者在发现「前提已经不成立」时立刻唤醒规划器。工具必须把服务端
 * 的去重/上限结果原样告诉模型，否则模型会反复重发同一条理由。
 */
test("signal_planner reports whether the escalation was recorded", async () => {
	const reasons: string[] = [];
	let response: EscalationAck = { status: "accepted", accepted: true, count: 1, limit: 3 };
	const tools = createWorkerGraphTools({
		client: {
			signalPlanner: async (reason: string) => {
				reasons.push(reason);
				return { statusCode: 201, ok: true, data: response, text: "" };
			},
		} as unknown as WorkerClient,
		resultCollector: new ExecutionResultCollector(),
	});
	const signal = tools.find((entry) => entry.name === "signal_planner") as AgentTool;
	expect(signal).toBeDefined();

	const accepted = await signal.execute("call-1", {
		reason: "the target runs a version the task description does not mention",
	});
	expect(toolText(accepted)).toContain("planner signalled");
	expect(toolText(accepted)).toContain("next available planning run");
	expect(signal.description).not.toContain("within seconds");
	expect(reasons).toEqual(["the target runs a version the task description does not mention"]);

	response = { status: "duplicate", accepted: false, count: 1, limit: 3 };
	const duplicate = toolText(await signal.execute("call-2", { reason: reasons[0] }));
	expect(duplicate).toContain("already recorded");
	expect(duplicate).not.toContain("limit");
	response = { status: "limit_reached", accepted: false, count: 3, limit: 3 };
	const rejected = toolText(await signal.execute("call-2", { reason: "another reason" }));
	expect(rejected).toContain("signal not recorded");
	expect(rejected).toContain("3-signal limit");
	expect(rejected).toContain("NOT sent to the planner");
	expect(rejected).toContain("submit_result");
	expect(rejected).not.toContain("already recorded");
});

test("submit_fact requires explicit confidence before sending a request", async () => {
	const submissions: unknown[] = [];
	const submit = createWorkerGraphTools({
		client: {
			submitFact: async (body: unknown) => {
				submissions.push(body);
				return { ok: true, statusCode: 201, text: "", data: { id: "f001" } };
			},
		} as unknown as WorkerClient,
	}).find((entry) => entry.name === "submit_fact")!;
	expect(submit.parameters).toMatchObject({ required: expect.arrayContaining(["confidence"]) });
	for (const confidence of [undefined, null, "certain"])
		expect(
			toolText(await submit.execute("invalid", { description: "claim", confidence })),
		).toContain("ERROR 400");
	expect(submissions).toHaveLength(0);
	for (const confidence of ["observed", "inferred"])
		await submit.execute(confidence, { description: "  claim  ", confidence });
	expect(submissions).toEqual([
		expect.objectContaining({ description: "claim", confidence: "observed" }),
		expect.objectContaining({ description: "claim", confidence: "inferred" }),
	]);
});

test.each([
	{ json: '{"verified":true}', data: { verified: true } },
	{ json: '["first",2,false,null]', data: ["first", 2, false, null] },
	{ json: '"{\\"verified\\":true}"', data: '{"verified":true}' },
	{ json: "42", data: 42 },
	{ json: "false", data: false },
	{ json: "null", data: null },
])("submit_finding decodes JSON text without changing its type: $json", async ({ json, data }) => {
	const submissions: unknown[] = [];
	const tool = createWorkerGraphTools({
		client: {
			submitFinding: async (body: unknown) => {
				submissions.push(body);
				return { ok: true, statusCode: 201, text: "", data: { id: "r001" } };
			},
		} as unknown as WorkerClient,
	}).find((entry) => entry.name === "submit_finding")!;
	// Qwen-style XML parsers preserve parameters declared as strings. JSON decoding
	// belongs to this explicit transport boundary, not to heuristic type coercion.
	expect(tool.parameters).toMatchObject({ properties: { data_json: { type: "string" } } });
	expect(tool.parameters).not.toHaveProperty("properties.data");
	expect(
		toolText(
			await tool.execute("finding", {
				title: "verified",
				description: "evidence",
				data_json: json,
			}),
		),
	).toContain("recorded");
	expect(submissions).toEqual([expect.objectContaining({ data })]);
});

test("submit_finding rejects invalid JSON and the old field before recording anything", async () => {
	const submissions: unknown[] = [];
	const tool = createWorkerGraphTools({
		client: {
			submitFinding: async (body: unknown) => {
				submissions.push(body);
				return { ok: true, statusCode: 201, text: "", data: { id: "r001" } };
			},
		} as unknown as WorkerClient,
	}).find((entry) => entry.name === "submit_finding")!;
	const body = { title: "verified", description: "evidence" };
	for (const data_json of ["", " ", "undefined", "{", { verified: true }])
		expect(toolText(await tool.execute("invalid", { ...body, data_json }))).toContain("ERROR 400");
	for (const data of [{ verified: true }, '{"verified":true}', null])
		expect(toolText(await tool.execute("old", { ...body, data }))).toContain("use data_json");
	expect(submissions).toHaveLength(0);
	await tool.execute("unstructured", body);
	expect(submissions).toEqual([expect.objectContaining({ data: undefined })]);
});

test("a declared finding contract rejects missing data_json without changing tool schemas", async () => {
	const submissions: unknown[] = [];
	const client = {
		submitFinding: async (body: unknown) => {
			submissions.push(body);
			return { ok: true, statusCode: 201, text: "", data: { id: "r001" } };
		},
	} as unknown as WorkerClient;
	const find = (findingSchema?: unknown) =>
		createWorkerGraphTools({ client, findingSchema }).find(
			(tool) => tool.name === "submit_finding",
		)!;
	const structured = find({ type: "object" });
	const unstructured = find();
	expect(structured.parameters).toEqual(unstructured.parameters);
	const body = { title: "verified", description: "evidence" };
	expect(toolText(await structured.execute("missing", body))).toContain("requires data_json");
	expect(submissions).toHaveLength(0);
	await structured.execute("corrected", { ...body, data_json: '{"verified":true}' });
	expect(submissions).toEqual([expect.objectContaining({ data: { verified: true } })]);
});

/** 首条用户消息尾部的执行标识行；逐执行变化，必须吊在消息最后。 */
function executionLine(executionId: string): string {
	return `本次执行 execution_id=${executionId}。`;
}

test("execution messages share contract/facts before varying step descriptions", () => {
	const common = {
		finding_schema: { type: "object", required: ["verified"] },
		source_facts: [{ id: "origin", description: "Shared scope", confidence: "observed" as const }],
	};
	const first = initialMessage({
		...common,
		step_id: "s001",
		step_description: "Inspect A",
		execution_id: "exec-a",
	});
	const second = initialMessage({
		...common,
		step_id: "s002",
		step_description: "Inspect B",
		execution_id: "exec-b",
	});
	const prefix = first.slice(0, first.indexOf("执行步骤 s001"));
	expect(first.startsWith("Finding 交付契约")).toBe(true);
	expect(prefix).toContain(JSON.stringify(common.finding_schema));
	expect(prefix).toContain("origin [observed]：Shared scope");
	// 跨步公共前缀只到「执行步骤」为止：执行标识逐执行不同，必须吊在消息最后，
	// 否则同项目后续 step 的首条用户消息从头就开始分叉。
	expect(second.startsWith(prefix)).toBe(true);
	expect(second).toContain("执行步骤 s002：Inspect B");
	expect(second.endsWith(executionLine("exec-b"))).toBe(true);
	expect(
		initialMessage({ step_id: "s001", step_description: "Inspect", execution_id: "exec-c" }),
	).toBe("执行步骤 s001：Inspect\n\n" + executionLine("exec-c"));
});

test.each([
	{ name: "submit_fact", params: { description: "same observation", confidence: "observed" } },
	{ name: "submit_finding", params: { title: "same finding", description: "same evidence" } },
])("$name reuses its idempotency key after an uncertain response", async ({ name, params }) => {
	const ids: string[] = [];
	const send = async (body: { client_event_id: string }) => {
		ids.push(body.client_event_id);
		return ids.length === 1
			? { statusCode: 0, ok: false, data: undefined, text: "timeout" }
			: { statusCode: 201, ok: true, data: { id: "f001", duplicate: ids.length === 2 }, text: "" };
	};
	const tools = createWorkerGraphTools({
		client: { submitFact: send, submitFinding: send } as unknown as WorkerClient,
	});
	const submit = tools.find((entry) => entry.name === name)!;
	expect(toolText(await submit.execute("call-1", params))).toContain("ERROR 0");
	expect(toolText(await submit.execute("call-2", params))).toContain("duplicate suppressed");
	await submit.execute("call-3", params);
	expect(ids[1]).toBe(ids[0]);
	expect(ids[2]).not.toBe(ids[1]);
});
