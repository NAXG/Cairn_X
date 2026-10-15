/**
 * Worker 过程检索协议（阶段三）：当前 execution token 可检索同项目
 * 历史执行；终态令牌失效；轨迹读取限同项目；命中 seq 可直接作为
 * 阶段二的事件证据引用。
 */

import { expect, test } from "vitest";

import {
	claimExecutionWithProjectWorker,
	createProject,
	addStep,
	startExecutorTestServer,
} from "./helpers.js";

const E1 = "10000000-0000-4000-8000-000000000101";
const E2 = "10000000-0000-4000-8000-000000000102";

async function makeExecution(server: any, pid: string, stepId: string, eid: string) {
	await server.client.claimStep(pid, stepId, eid);
	const created = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: eid,
	});
	if (!created.ok || !created.data)
		throw new Error(`createExecution failed: ${created.statusCode}`);
	const claimed = await claimExecutionWithProjectWorker(server, pid, eid);
	const token = claimed.task.token;
	const worker = (path: string, init?: RequestInit) =>
		fetch(`${server.url}${path}`, {
			...init,
			headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
		});
	return { eid, token, worker };
}

test("worker searches project history and turns hits into event evidence", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk-long-term",
	});
	try {
		const pid = await createProject(server.client);
		const s1 = await addStep(server.client, pid);
		// 第一次执行（旧尝试）：产出一条工具结果后失败终态。
		const first = await makeExecution(server, pid, s1, E1);
		await first.worker(`/internal/executions/${E1}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				events: [
					{
						seq: 5,
						line: JSON.stringify({
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "c1",
								content: [
									{ type: "text", text: "banner: OpenSSH 8.2p1 vulnerability CVE-2020-15778" },
								],
							},
						}),
					},
				],
			}),
		});
		await first.worker(`/internal/executions/${E1}/result`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ outcome: "failed", error: "network lost" }),
		});

		// 旧令牌在终态后失效。
		const denied = await first.worker(`/internal/executions/${E1}/search-events?q=OpenSSH`);
		expect(denied.status).toBe(403);

		// 第二个 step 的新执行：检索到旧执行的观察并引用为证据。
		const s2 = await addStep(server.client, pid, { description: "verify openssh version" });
		const second = await makeExecution(server, pid, s2, E2);
		const search = await second.worker(`/internal/executions/${E2}/search-events?q=CVE-2020-15778`);
		expect(search.status).toBe(200);
		const hits = ((await search.json()) as { hits: any[] }).hits;
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ execution_id: E1, step_id: s1, seq: 5 });

		const trace = await second.worker(`/internal/executions/${E2}/trace/${E1}`);
		expect(trace.status).toBe(200);
		const traceBody: any = await trace.json();
		expect(traceBody.entries[0].seq).toBe(5);
		expect(traceBody.entries[0].record.message.role).toBe("toolResult");

		const submit = await second.worker(`/internal/executions/${E2}/facts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				confidence: "observed",
				description: "target runs OpenSSH 8.2p1",
				evidence: [{ kind: "event", execution_id: E1, seq: 5 }],
			}),
		});
		expect(submit.status).toBe(201);

		// 其他项目的执行不可读。
		const pid2 = await createProject(server.client);
		server.db
			.prepare(
				"INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, created_at) VALUES ('foreign', ?, 'sX', 1, 0, 'succeeded', '2026-01-01')",
			)
			.run(pid2);
		const foreign = await second.worker(`/internal/executions/${E2}/trace/foreign`);
		expect(foreign.status).toBe(404);
	} finally {
		await server.close();
	}
});

test("worker search budgets reject unbounded queries", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk-long-term",
	});
	try {
		const pid = await createProject(server.client);
		const s1 = await addStep(server.client, pid);
		const { worker } = await makeExecution(server, pid, s1, E1);
		expect((await worker(`/internal/executions/${E1}/search-events`)).status).toBe(400);
		expect(
			(await worker(`/internal/executions/${E1}/search-events?q=${"a ".repeat(6)}1`)).status,
		).toBe(400);
		expect((await worker(`/internal/executions/${E1}/search-events?q=a&limit=51`)).status).toBe(
			400,
		);
		expect((await worker(`/internal/executions/${E1}/trace/${E1}?limit=201`)).status).toBe(400);
		expect((await worker(`/internal/executions/${E1}/trace/${E1}?after_seq=-1`)).status).toBe(400);
	} finally {
		await server.close();
	}
});

test("worker tools recover oversized traces and graph records through authenticated routes", async () => {
	const { WorkerClient } = await import("../../src/worker/client.js");
	const { createWorkerGraphTools } = await import("../../src/worker/graphtools.js");
	const { decideTools } = await import("../../src/orchestrator/tools/graph.js");
	const { parse } = await import("yaml");
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "test",
	});
	try {
		const pid = await createProject(server.client);
		const sid = await addStep(server.client, pid);
		const execution = await makeExecution(server, pid, sid, E1);
		const worker = new WorkerClient(server.url, E1, execution.token);
		const tools = createWorkerGraphTools({ client: worker });
		const trace = tools.find((t) => t.name === "get_execution_trace")!;
		const line = JSON.stringify({
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text: "proof".repeat(18000) }] },
		});
		await worker.sendEvents([{ seq: 7, line }]);
		let offset = 0,
			text = "";
		for (let i = 0; i < 20; i++) {
			const result = await trace.execute("call", { execution_id: E1, event_seq: 7, offset });
			const page = JSON.parse((result.content[0] as { text: string }).text) as {
				text: string;
				next_offset: number;
				has_more: boolean;
			};
			text += page.text;
			if (!page.has_more) break;
			offset = page.next_offset;
		}
		expect(text).toBe(line);
		const fact = await worker.submitFact({
			confidence: "observed",
			description: "test fact",
			client_event_id: "recovery",
		});
		// Decide keeps its own lease binding for graph fragment reads.
		await server.client.signalDecide(pid, "audit");
		expect((await server.client.claimDecide(pid, "reader", 0)).ok).toBe(true);
		const decide = decideTools(server.client, pid, { worker: "reader" });
		const dg = await decide
			.find((t) => t.name === "get_graph")!
			.execute("call", { view: "record", section: "facts", id: fact.data!.id });
		expect(parse((dg.content[0] as { text: string }).text).record.id).toBe(fact.data!.id);
		const other = await createProject(server.client);
		server.db
			.prepare(
				"INSERT INTO executions(id,project_id,step_id,attempt,lease_version,status,created_at) VALUES ('foreign-chunk',?,'s1',1,0,'succeeded','2026-01-01')",
			)
			.run(other);
		expect((await worker.getTrace("foreign-chunk", { event_seq: 7 })).statusCode).toBe(404);
	} finally {
		await server.close();
	}
});

test("worker trace degrades mid-size events to a readable excerpt and pages the full text on demand", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk-long-term",
	});
	try {
		const pid = await createProject(server.client);
		const sid = await addStep(server.client, pid);
		const { worker } = await makeExecution(server, pid, sid, E1);
		// 落在中间的“胖”事件：超过 Worker 内联预算（8 KiB），但仍在控制台上限（64 KiB）之下。
		const body = "nmap scan line\n".repeat(900);
		const line = JSON.stringify({
			type: "message",
			message: { role: "toolResult", toolCallId: "c9", content: [{ type: "text", text: body }] },
		});
		expect(Buffer.byteLength(line)).toBeGreaterThan(8 * 1024);
		expect(Buffer.byteLength(line)).toBeLessThan(64 * 1024);
		await worker(`/internal/executions/${E1}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ events: [{ seq: 1, line }] }),
		});

		const page = (await (await worker(`/internal/executions/${E1}/trace/${E1}`)).json()) as any;
		const entry = page.entries[0];
		expect(entry.record).toBeUndefined();
		expect(entry.omitted).toBe(true);
		expect(entry.bytes).toBe(Buffer.byteLength(line));
		// 摘录是可读正文，不是被截断的 JSON 信封。
		expect(entry.excerpt.startsWith("nmap scan line")).toBe(true);
		expect(entry.excerpt).not.toContain('"role"');
		expect(entry.excerpt.length).toBeLessThanOrEqual(801);

		// 真要全文时按 event_seq 分片补读，内容无损。
		let offset = 0;
		let text = "";
		for (let i = 0; i < 20; i++) {
			const chunk = (await (
				await worker(`/internal/executions/${E1}/trace/${E1}?event_seq=1&offset=${offset}`)
			).json()) as { text: string; next_offset: number; has_more: boolean };
			text += chunk.text;
			if (!chunk.has_more) break;
			offset = chunk.next_offset;
		}
		expect(text).toBe(line);
	} finally {
		await server.close();
	}
});

test("worker trace index view locates events without carrying their content", async () => {
	const server = await startExecutorTestServer({
		api: "openai-completions",
		base_url: "http://unused",
		api_key: "sk-long-term",
	});
	try {
		const pid = await createProject(server.client);
		const sid = await addStep(server.client, pid);
		const { worker } = await makeExecution(server, pid, sid, E1);
		const big = "nmap output line\n".repeat(900);
		await worker(`/internal/executions/${E1}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				events: [
					{
						seq: 1,
						line: JSON.stringify({
							type: "message",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "c1",
										name: "bash",
										arguments: { command: "nmap -sV target" },
									},
								],
							},
						}),
					},
					{
						seq: 2,
						line: JSON.stringify({
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "c1",
								content: [{ type: "text", text: big }],
							},
						}),
					},
				],
			}),
		});
		const index = (await (
			await worker(`/internal/executions/${E1}/trace/${E1}?view=index`)
		).json()) as {
			entries: Array<{
				seq: number;
				bytes: number;
				role?: string;
				tool?: string;
				preview?: string;
			}>;
			has_more: boolean;
		};
		expect(index.entries).toHaveLength(2);
		expect(index.entries[0]).toMatchObject({ seq: 1, role: "assistant", tool: "bash" });
		expect(index.entries[1]).toMatchObject({ seq: 2, role: "toolResult" });
		// 底层事件很大，但索引条目仍然只有一行预览。
		expect(index.entries[1].bytes).toBeGreaterThan(8 * 1024);
		expect(index.entries[1].preview?.startsWith("nmap output line")).toBe(true);
		expect(index.entries[1].preview?.length).toBeLessThanOrEqual(201);
		expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(1024);
		// 视图参数是封闭集合：其他值直接 400，不静默退回分页。
		expect((await worker(`/internal/executions/${E1}/trace/${E1}?view=bogus`)).status).toBe(400);
	} finally {
		await server.close();
	}
});
