import { onTestFinished, test, expect } from "vitest";

import type { BenchmarkConfig } from "../../src/scheduler/config.js";
import { createBenchmarkService } from "../../src/tsecbench/service.js";
import type { BenchmarkPlatformClient } from "../../src/tsecbench/client.js";
import type {
	BenchmarkResult,
	Challenge,
	CloseChallengeResult,
	HintResult,
	StartChallengeResult,
	SubmitFlagResult,
} from "../../src/tsecbench/types.js";
import {
	addStep,
	claimExecutionWithProjectWorker,
	createProject,
	startExecutorTestServer,
} from "../orchestrator/helpers.js";

const EID = "10000000-0000-4000-8000-000000000042";

const benchmarkConfig: BenchmarkConfig = {
	base_url: "https://tsecbench.example.com",
	token: "platform-token",
	max_active: 3,
	auto_start: true,
	auto_close: true,
	challenge_timeout: 7200,
};

/** 状态自演进的平台假实现：提交正确 flag 即通关。 */
function makePlatform(): BenchmarkPlatformClient & { challenge: Challenge } {
	const challenge: Challenge = {
		unique_code: "web_01",
		description: "SQL injection",
		difficulty: "easy",
		level: 1,
		total_score: 100,
		flag_count: 1,
		correct_flag_count: 0,
		is_completed: false,
		container_status: "stopped",
		container_addr: [],
	};
	return {
		challenge,
		async listChallenges(): Promise<BenchmarkResult<Challenge[]>> {
			return { ok: true, data: [{ ...challenge }] };
		},
		async startChallenge(code: string): Promise<BenchmarkResult<StartChallengeResult>> {
			challenge.container_status = "available";
			challenge.container_addr = ["10.0.0.9:80"];
			return { ok: true, data: { unique_code: code, container_addr: challenge.container_addr } };
		},
		async getHint(code: string): Promise<BenchmarkResult<HintResult>> {
			return { ok: true, data: { unique_code: code, hint: "try sqlmap on the id parameter" } };
		},
		async submitFlag(_code: string, flag: string): Promise<BenchmarkResult<SubmitFlagResult>> {
			const correct = flag === "flag{real}";
			if (correct) {
				challenge.correct_flag_count = 1;
				challenge.is_completed = true;
			}
			return {
				ok: true,
				data: {
					correct,
					awarded: correct ? 100 : 0,
					cumulative_score: correct ? 100 : 0,
					correct_flag_count: correct ? 1 : 0,
					total_flag_count: 1,
					matched_flag_index: correct ? 0 : null,
				},
			};
		},
		async closeChallenge(code: string): Promise<BenchmarkResult<CloseChallengeResult>> {
			challenge.container_status = "stopped";
			challenge.container_addr = [];
			return { ok: true, data: { unique_code: code, closed: true } };
		},
	};
}

async function setup() {
	const platform = makePlatform();
	const server = await startExecutorTestServer(
		{ api: "openai-completions", base_url: "http://unused", api_key: "k" },
		{
			benchmarkFactory: (db) =>
				createBenchmarkService({ client: platform, config: benchmarkConfig, db }),
		},
	);
	onTestFinished(() => void server.close());
	const machineFetch = (path: string, init?: RequestInit) =>
		fetch(`${server.url}${path}`, {
			...init,
			headers: { ...(init?.headers ?? {}), Authorization: "Bearer test-token" },
		});
	return { server, platform, machineFetch };
}

/**
 * 绑定靶场 web_01 + 建步骤 + 建执行 + 项目 Worker 认领：拿到一个带靶场
 * 上下文、已可提交结果的执行起点（含执行令牌 authFetch）。
 */
async function boundExecution(
	server: Awaited<ReturnType<typeof startExecutorTestServer>>,
	machineFetch: (path: string, init?: RequestInit) => Promise<Response>,
	executionId: string = EID,
) {
	const pid = await createProject(server.client);
	await machineFetch("/internal/benchmark/bind", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ project_id: pid, unique_code: "web_01" }),
	});
	const stepId = await addStep(server.client, pid);
	await server.client.claimStep(pid, stepId, executionId);
	const created = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: executionId,
	});
	expect(created.ok).toBe(true);
	const claimed = await claimExecutionWithProjectWorker(server, pid, executionId);
	const token = claimed.task.token;
	const authFetch = (path: string, init?: RequestInit) =>
		fetch(`${server.url}${path}`, {
			...init,
			headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
		});
	return { pid, stepId, claimed, token, authFetch };
}

test("control plane binds a project to a challenge and lists tasks", async () => {
	const { server, machineFetch } = await setup();
	const pid = await createProject(server.client);
	const bound = await machineFetch("/internal/benchmark/bind", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ project_id: pid, unique_code: "web_01" }),
	});
	expect(bound.status).toBe(200);
	const binding = (await bound.json()) as { container_status: string; container_addr: string[] };
	expect(binding.container_status).toBe("available");
	expect(binding.container_addr).toEqual(["10.0.0.9:80"]);

	const tasks = await machineFetch("/internal/benchmark/tasks");
	expect(tasks.status).toBe(200);
	const listed = (await tasks.json()) as Array<{ unique_code: string }>;
	expect(listed.map((t) => t.unique_code)).toEqual(["web_01"]);
});

test("benchmark control routes require the machine token", async () => {
	const { server } = await setup();
	const unauthenticated = await fetch(`${server.url}/internal/benchmark/tasks`);
	expect(unauthenticated.status).toBe(401);
});

test("worker task payload carries structured challenge context", async () => {
	const { server, machineFetch } = await setup();
	const { claimed } = await boundExecution(server, machineFetch);
	const task = claimed.task as {
		benchmark?: { unique_code: string; container_status: string; container_addr: string[] };
	};
	expect(task.benchmark?.unique_code).toBe("web_01");
	expect(task.benchmark?.container_status).toBe("available");
	expect(task.benchmark?.container_addr).toContain("10.0.0.9:80");
});

test("worker hint + submit proxy through the control plane and update progress", async () => {
	const { server, machineFetch } = await setup();
	const { authFetch } = await boundExecution(server, machineFetch);
	const hint = await authFetch(`/internal/executions/${EID}/benchmark/hint`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ reason: "stuck on the injection point" }),
	});
	expect(hint.status).toBe(200);
	expect((await hint.json()) as { hint: string }).toMatchObject({
		hint: "try sqlmap on the id parameter",
	});

	const wrong = await authFetch(`/internal/executions/${EID}/benchmark/submit`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ flag: "flag{wrong}" }),
	});
	expect(wrong.status).toBe(200);
	expect((await wrong.json()) as { correct: boolean }).toMatchObject({ correct: false });

	const right = await authFetch(`/internal/executions/${EID}/benchmark/submit`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ flag: "flag{real}" }),
	});
	expect(right.status).toBe(200);
	expect((await right.json()) as { correct: boolean }).toMatchObject({ correct: true });

	const tasks = await machineFetch("/internal/benchmark/tasks");
	const listed = (await tasks.json()) as Array<{
		correct_flag_count: number;
		is_completed: boolean;
		hint_used: boolean;
	}>;
	expect(listed[0]?.correct_flag_count).toBe(1);
	expect(listed[0]?.is_completed).toBe(true);
	expect(listed[0]?.hint_used).toBe(true);
});

test("container rebuild is refused while a sibling execution is running", async () => {
	const { server, machineFetch } = await setup();
	const EID_A = "10000000-0000-4000-8000-0000000000a1";
	const EID_B = "10000000-0000-4000-8000-0000000000b2";
	const { pid, token: tokenA } = await boundExecution(server, machineFetch, EID_A);
	const resetA = () =>
		fetch(`${server.url}/internal/executions/${EID_A}/benchmark/reset`, {
			method: "POST",
			headers: { Authorization: `Bearer ${tokenA}` },
		});
	// A 是唯一在途执行：重建放行。
	expect((await resetA()).status).toBe(200);

	// B 也在途后，A 的重建必须被串行保护拒绝，否则会毁掉 B 正在用的靶机现场。
	const stepB = await addStep(server.client, pid, { description: "step B" });
	await server.client.claimStep(pid, stepB, EID_B);
	await server.client.createExecution({
		project_id: pid,
		step_id: stepB,
		execution_id: EID_B,
	});
	expect((await resetA()).status).toBe(409);
});

test("benchmark worker routes reject requests without an execution token", async () => {
	const { server } = await setup();
	const response = await fetch(`${server.url}/internal/executions/${EID}/benchmark`);
	expect([401, 403, 404]).toContain(response.status);
});

test("solving the challenge immediately stops sibling in-flight executions", async () => {
	const { server, machineFetch } = await setup();
	const { pid, stepId, authFetch } = await boundExecution(server, machineFetch);
	// 兄弟执行仍在跑：通关时必须被立刻掐掉，而不是等 Decide 盖章收尾。
	const SIBLING = "10000000-0000-4000-8000-000000000043";
	const now = new Date().toISOString();
	server.db
		.prepare(
			`INSERT INTO executions (id, project_id, step_id, attempt, lease_version, status, cancel_requested, created_at, started_at, deadline_at)
			 VALUES (?, ?, ?, 1, 1, 'running', 0, ?, ?, ?)`,
		)
		.run(SIBLING, pid, stepId, now, now, new Date(Date.now() + 600_000).toISOString());

	const right = await authFetch(`/internal/executions/${EID}/benchmark/submit`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ flag: "flag{real}" }),
	});
	expect(right.status).toBe(200);

	const sibling = server.db
		.prepare("SELECT status, cancel_requested, error FROM executions WHERE id = ?")
		.get(SIBLING) as { status: string; cancel_requested: number; error: string };
	expect(sibling.status).toBe("cancelled");
	expect(sibling.cancel_requested).toBe(1);
	expect(sibling.error).toContain("Challenge already solved");
	// 提交方自己必须留活：它还要 submit_fact / conclude。
	const self = server.db.prepare("SELECT status FROM executions WHERE id = ?").get(EID) as {
		status: string;
	};
	expect(self.status).not.toBe("cancelled");
	const cp = server.db
		.prepare("SELECT external_signal FROM decide_checkpoints WHERE project_id = ?")
		.get(pid) as { external_signal: string | null };
	expect(cp.external_signal).toBe("flags_complete");
});
