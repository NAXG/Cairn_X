import { inspectClientProject } from "../support/project-state.js";
import { expect, test } from "vitest";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { FgsClient } from "../../src/orchestrator/client.js";
import { decideTools } from "../../src/orchestrator/tools/graph.js";
import { addStep, createProject, startTestServer } from "./helpers.js";

function tool(tools: AgentTool[], name: string): AgentTool {
	const found = tools.find((t) => t.name === name);
	if (found === undefined) {
		throw new Error(`tool ${name} not found in [${tools.map((t) => t.name).join(", ")}]`);
	}
	return found;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

test("every Decide tool exposes a top-level object parameter schema", () => {
	const client = new FgsClient("http://unused");
	const tools = decideTools(client, "proj_schema", { worker: "probe" });
	for (const entry of tools) {
		// OpenAI 兼容端点要求 function.parameters 顶层是 type:"object"。把
		// Type.Union 直接交给端点会序列化成 {anyOf:[...]}（type 为 null），
		// DeepSeek 会拒绝整个请求，症状是模型调用一律失败、Decide 每轮都被
		// 判成端点 unhealthy —— 与模型、额度、密钥都无关。
		expect(
			(entry.parameters as Record<string, unknown>).type,
			`${entry.name} 的参数 schema 缺少顶层 type:"object"`,
		).toBe("object");
	}
	// 顶层补 type 之后，get_graph 的联合约束仍然保留。
	const graph = tool(tools, "get_graph");
	const anyOf = (graph.parameters as { anyOf?: unknown[] }).anyOf;
	expect(Array.isArray(anyOf)).toBe(true);
	expect(anyOf).toHaveLength(3);
});

test("get_graph binds its watermark to the Decide lease, not ordinary client exports", async () => {
	const { client } = await startTestServer();
	const pid = await createProject(client);
	// 先跑完一条步骤：空图项目在 no-op 后会被保护性重试，而本用例要验证
	// 的是「规划已收尾、已读输入不再触发」，需要项目有过计划。
	const seedId = await addStep(client, pid, { description: "seed" });
	await client.claimStep(pid, seedId, "seed-exec");
	await client.concludeStep(pid, seedId, "seed-exec", "seed done");
	await client.claimDecide(pid, "reader");
	await client.createHint(pid, { content: "new input", creator: "human" });
	const tools = decideTools(client, pid, { worker: "reader" });
	const graph = resultText(await tool(tools, "get_graph").execute("read-1", { view: "planning" }));
	expect(graph).toContain("required_complete:");
	expect(graph).toContain("new input");
	const stale = decideTools(client, pid, { worker: "stale" });
	expect(
		resultText(await tool(stale, "get_graph").execute("read-2", { view: "planning" })),
	).toContain("ERROR 409");
	await client.completeDecide(pid, "reader", 0);
	await client.releaseDecide(pid, "reader");
	expect((await client.claimDecide(pid, "next")).statusCode).toBe(409);
});

test("decide tools shape the graph against the real server", async () => {
	const { client } = await startTestServer();
	const pid = await createProject(client);
	await client.claimDecide(pid, "decide:model");
	const tools = decideTools(client, pid, { worker: "decide:model" });
	await tool(tools, "get_graph").execute("prepare", { view: "planning" });
	expect(tools.map((entry) => entry.name)).toEqual([
		"get_graph",
		"read_evidence",
		"add_step",
		"abandon_step",
		"add_route",
		"set_step_priority",
		"goal",
	]);

	// 带 priority 的 add_step
	const addStepTool = tool(tools, "add_step");
	const added = resultText(
		await addStepTool.execute("call-1", {
			from: ["origin"],
			description: "check config",
			priority: 7,
		}),
	);
	expect(added).toContain("created");
	expect(added).toContain("priority 7");

	// set_step_priority
	const setPriority = tool(tools, "set_step_priority");
	const reprioritized = resultText(
		await setPriority.execute("call-2", { step_id: "s001", priority: 3 }),
	);
	expect(reprioritized).toContain("priority set to 3");

	// goal(action=add)
	const goal = tool(tools, "goal");
	const subgoal = resultText(
		await goal.execute("call-3", { action: "add", description: "reach the entry point" }),
	);
	expect(subgoal).toContain("sub goal g001 created");

	// 持有 decide lease 的 worker 可以 abandon 其他 worker 的 step
	await client.claimDecide(pid, "decide:model");
	const abandon = tool(tools, "abandon_step");
	const abandoned = resultText(
		await abandon.execute("call-4", { step_id: "s001", reason: "not valuable" }),
	);
	expect(abandoned).toContain("abandoned");

	// goal(action=remove)
	const removed = resultText(await goal.execute("call-5", { action: "remove", goal_id: "g001" }));
	expect(removed).toContain("removed");
});

test("goal tool validates action-specific fields at runtime", async () => {
	const { client } = await startTestServer();
	const pid = await createProject(client);
	await client.claimDecide(pid, "decide:model");
	const tools = decideTools(client, pid, { worker: "decide:model" });
	await tool(tools, "get_graph").execute("prepare", { view: "planning" });
	const goal = tool(tools, "goal");
	expect(resultText(await goal.execute("c1", { action: "add" }))).toContain(
		"description is required",
	);
	expect(resultText(await goal.execute("c2", { action: "remove" }))).toContain(
		"goal_id is required",
	);
	expect(resultText(await goal.execute("c3", { action: "achieve", goal_id: "goal" }))).toContain(
		"from and description are required",
	);
});

test("achieving the root goal completes the project and later writes are rejected", async () => {
	const { client } = await startTestServer();
	const pid = await createProject(client);
	await client.claimDecide(pid, "decide:model");
	const tools = decideTools(client, pid, { worker: "decide:model" });
	await tool(tools, "get_graph").execute("prepare", { view: "planning" });

	const goal = tool(tools, "goal");
	const done = resultText(
		await goal.execute("call-1", {
			action: "achieve",
			goal_id: "goal",
			from: [{ type: "fact", id: "origin" }],
			description: "root goal is satisfied",
		}),
	);
	expect(done).toContain("achieved");

	const project = await inspectClientProject(client, pid);
	expect(project.project.status).toBe("completed");
	expect(project.goals.find((g) => g.id === "goal")?.status).toBe("achieved");
	// 项目完结后图谱写入被拒（decide 工具同样走服务器校验）。
	const late = resultText(
		await tool(tools, "add_step").execute("call-2", {
			from: ["origin"],
			description: "too late",
		}),
	);
	expect(late).toContain("ERROR 403");
});

test("abandon_step without the decide lease surfaces the server 409 text", async () => {
	const { client } = await startTestServer();
	const pid = await createProject(client);
	const stepId = await addStep(client, pid);

	// 没有 decide lease 且 step 未被认领：服务器拒绝。
	const tools = decideTools(client, pid, { worker: "other-worker" });
	const abandon = tool(tools, "abandon_step");
	const result = resultText(await abandon.execute("call-1", { step_id: stepId }));
	expect(result).toContain("ERROR 409");
});

test("get_graph exposes the server's cursor recovery detail", async () => {
	const { ClientError } = await import("../../src/orchestrator/client.js");
	const fake = {
		readDecideGraph: async () => {
			throw new ClientError(
				"request failed",
				409,
				'{"detail":"Continue planning graph with cursor next-page"}',
			);
		},
	};
	const tools = decideTools(fake as any, "p1", { worker: "reader" });
	expect(
		resultText(await tool(tools, "get_graph").execute("read", { view: "planning" })),
	).toContain("next-page");
});

test("creation retries reuse uncertain keys, but later intentional creations get a new key", async () => {
	const requests: Array<{ request_id: string; description: string; goal_id: string }> = [];
	const fake = {
		createStep: async (
			_pid: string,
			body: { request_id: string; description: string; goal_id: string },
		) => {
			requests.push(body);
			return requests.length === 1
				? { ok: false, statusCode: 0, text: "response lost", data: undefined }
				: { ok: true, statusCode: 201, text: "", data: { id: "s001", priority: 0 } };
		},
	};
	const tools = decideTools(fake as any, "p1", { worker: "reader" });
	const add = tool(tools, "add_step");
	await add.execute("first", { from: ["origin"], description: " task " });
	await add.execute("retry", { from: ["origin"], description: "task" });
	await add.execute("later", { from: ["origin"], description: "task" });
	expect(requests[0].request_id).toBe(requests[1].request_id);
	expect(requests[2].request_id).not.toBe(requests[1].request_id);
	expect(requests[0].goal_id).toBe("goal");
	expect(requests[0].description).toBe("task");
	const invalid = await add.execute("bad", {
		from: ["origin"],
		description: "task",
		waiting_on: Array(9).fill("s001"),
	});
	expect(resultText(invalid)).toContain("ERROR 400");
	expect(requests).toHaveLength(3);
});

test("goal action schemas declare their required arguments and reject extra fields", async () => {
	const fake = {
		createGoal: async () => {
			throw new Error("invalid call reached server");
		},
	};
	const tools = decideTools(fake as any, "p1", { worker: "reader" });
	const goal = tool(tools, "goal");
	const schema = goal.parameters as {
		type: string;
		oneOf?: Array<{ required?: string[] }>;
		anyOf?: Array<{ required?: string[] }>;
	};
	expect((schema.oneOf ?? schema.anyOf)?.some((branch) => branch.required?.includes("from"))).toBe(
		true,
	);
	expect(
		resultText(
			await goal.execute("invalid", { action: "add", description: " ", goal_id: "unexpected" }),
		),
	).toContain("ERROR 400");
});
