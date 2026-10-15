import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getExecutionRow } from "../../src/server/core/executions.js";
import { ProjectWorkerClient } from "../../src/worker/project-client.js";
import {
	persistWorkspaceDir,
	runProjectWorkerLoop,
	stepWorkspaceDir,
} from "../../src/worker/project-loop.js";
import { addStep, createProject, silentLogger, startExecutorTestServer } from "./helpers.js";

const model = { api: "openai-completions" as const, base_url: "http://unused", api_key: "test" };
const MACHINE_TOKEN = "test-token";

async function issueProjectToken(url: string, pid: string): Promise<string> {
	const res = await fetch(`${url}/internal/project-workers/${pid}/token`, {
		method: "POST",
		headers: { Authorization: `Bearer ${MACHINE_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ container_name: "cairn-pw-test" }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { token: string }).token;
}

async function queueExecution(
	server: Awaited<ReturnType<typeof startExecutorTestServer>>,
	pid: string,
	stepId: string,
): Promise<string> {
	const executionId = randomUUID();
	expect((await server.client.claimStep(pid, stepId, executionId)).ok).toBe(true);
	const created = await server.client.createExecution({
		project_id: pid,
		step_id: stepId,
		execution_id: executionId,
	});
	expect(created.ok).toBe(true);
	return executionId;
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met before timeout");
}

test("project worker loop runs multiple steps concurrently in isolated workspaces", async () => {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const sidA = await addStep(server.client, pid, { description: "step A" });
	const sidB = await addStep(server.client, pid, { description: "step B" });
	const eidA = await queueExecution(server, pid, sidA);
	const eidB = await queueExecution(server, pid, sidB);
	const projectToken = await issueProjectToken(server.url, pid);

	const workspace = mkdtempSync(path.join(tmpdir(), "cairn-pw-ws-"));
	const started: string[] = [];
	const dirs = new Map<string, string>();
	const gates = new Map<string, () => void>();
	let active = 0;
	let peak = 0;

	const stop = new AbortController();
	const loop = runProjectWorkerLoop({
		client: new ProjectWorkerClient(server.url, pid, projectToken),
		workspaceDir: workspace,
		maxConcurrency: 2,
		logger: silentLogger,
		signal: stop.signal,
		pollIntervalMs: 20,
		heartbeatIntervalMs: 5_000,
		runExecution: async (task, dir) => {
			started.push(task.execution_id);
			dirs.set(task.execution_id, dir);
			active += 1;
			peak = Math.max(peak, active);
			// 阻塞直到测试放行：强制两个 step 真正重叠。
			await new Promise<void>((resolve) => gates.set(task.execution_id, resolve));
			active -= 1;
			return 0;
		},
	});

	try {
		await waitUntil(() => started.length === 2, 5_000);

		// 单容器内两个 step 并发（峰值 2），且各自工作目录隔离。
		expect(peak).toBe(2);
		expect(new Set(started)).toEqual(new Set([eidA, eidB]));
		expect(dirs.get(eidA)).toBe(stepWorkspaceDir(workspace, eidA));
		expect(dirs.get(eidB)).toBe(stepWorkspaceDir(workspace, eidB));
		expect(dirs.get(eidA)).not.toBe(dirs.get(eidB));
		expect(existsSync(persistWorkspaceDir(workspace))).toBe(true);
		// 两个 execution 都被服务端置为 running。
		expect(getExecutionRow(server.db, eidA).status).toBe("running");
		expect(getExecutionRow(server.db, eidB).status).toBe("running");
	} finally {
		for (const release of gates.values()) release();
		stop.abort();
		await loop;
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("project worker cancels a task claimed while shutting down without starting it", async () => {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const sid = await addStep(server.client, pid, { description: "late task" });
	const eid = await queueExecution(server, pid, sid);
	const projectToken = await issueProjectToken(server.url, pid);
	const client = new ProjectWorkerClient(server.url, pid, projectToken);
	const nextTask = client.nextTask.bind(client);
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => (releaseResponse = resolve));
	let taskClaimed!: () => void;
	const claimed = new Promise<void>((resolve) => (taskClaimed = resolve));
	vi.spyOn(client, "nextTask").mockImplementationOnce(async () => {
		const result = await nextTask();
		taskClaimed();
		await responseGate;
		return result;
	});
	const workspace = mkdtempSync(path.join(tmpdir(), "cairn-pw-ws-"));
	const stop = new AbortController();
	const runExecution = vi.fn(async () => 0);
	const loop = runProjectWorkerLoop({
		client,
		workspaceDir: workspace,
		maxConcurrency: 1,
		logger: silentLogger,
		signal: stop.signal,
		heartbeatIntervalMs: 10_000,
		runExecution,
	});
	try {
		await claimed;
		expect(getExecutionRow(server.db, eid).status).toBe("running");
		stop.abort();
		releaseResponse();
		expect((await loop).reason).toBe("signal");
		expect(runExecution).not.toHaveBeenCalled();
		expect(getExecutionRow(server.db, eid).status).toBe("cancelled");
	} finally {
		stop.abort();
		releaseResponse();
		await loop;
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("project worker loop stops on rejected credentials", async () => {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const workspace = mkdtempSync(path.join(tmpdir(), "cairn-pw-ws-"));
	const stop = new AbortController();
	try {
		const result = await runProjectWorkerLoop({
			client: new ProjectWorkerClient(server.url, pid, "not-a-real-token"),
			workspaceDir: workspace,
			maxConcurrency: 2,
			logger: silentLogger,
			signal: stop.signal,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 10_000,
			runExecution: async () => 0,
		});
		expect(result.reason).toBe("unauthorized");
		expect(result.completed).toBe(0);
	} finally {
		stop.abort();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("project worker loop idles on 204 and exits on signal", async () => {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const projectToken = await issueProjectToken(server.url, pid);
	const workspace = mkdtempSync(path.join(tmpdir(), "cairn-pw-ws-"));
	const stop = new AbortController();
	try {
		const loop = runProjectWorkerLoop({
			client: new ProjectWorkerClient(server.url, pid, projectToken),
			workspaceDir: workspace,
			maxConcurrency: 2,
			logger: silentLogger,
			signal: stop.signal,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 10_000,
			runExecution: async () => 0,
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		stop.abort();
		const result = await loop;
		expect(result.reason).toBe("signal");
		expect(result.completed).toBe(0);
	} finally {
		stop.abort();
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("project worker raises its concurrency when the heartbeat reports a higher limit", async () => {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const sidA = await addStep(server.client, pid, { description: "step A" });
	const sidB = await addStep(server.client, pid, { description: "step B" });
	await queueExecution(server, pid, sidA);
	await queueExecution(server, pid, sidB);
	const projectToken = await issueProjectToken(server.url, pid);
	const workspace = mkdtempSync(path.join(tmpdir(), "cairn-pw-ws-"));
	const gates: Array<() => void> = [];
	let active = 0;
	let peak = 0;
	const stop = new AbortController();
	// 容器按旧设置以并发 1 启动；服务端当前的 max_project_workers 是 4。
	const loop = runProjectWorkerLoop({
		client: new ProjectWorkerClient(server.url, pid, projectToken),
		workspaceDir: workspace,
		maxConcurrency: 1,
		logger: silentLogger,
		signal: stop.signal,
		pollIntervalMs: 20,
		heartbeatIntervalMs: 20,
		runExecution: async () => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => gates.push(resolve));
			active -= 1;
			return 0;
		},
	});
	try {
		// 第一个 step 一直不结束：只有心跳调高上限，第二个 step 才能开始。
		await waitUntil(() => peak === 2, 5_000);
	} finally {
		for (const release of gates) release();
		stop.abort();
		await loop;
		rmSync(workspace, { recursive: true, force: true });
	}
});
