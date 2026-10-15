import { inspectClientProject } from "../support/project-state.js";
/**
 * 项目常驻调度 runner：ensure 项目容器、监视执行终态、且永不回收共享容器。
 */
import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";

import type {
	ProjectWorkerLaunchSpec,
	ProjectWorkerLauncher,
} from "../../src/scheduler/launcher.js";
import { createProjectExecuteRunner } from "../../src/scheduler/execute.js";
import { getExecutionRow } from "../../src/server/core/executions.js";
import { ProjectWorkerClient } from "../../src/worker/project-client.js";
import { WorkerClient } from "../../src/worker/client.js";
import {
	addStep,
	createProject,
	silentLogger,
	startExecutorTestServer,
	testConfig,
} from "./helpers.js";

const model = { api: "openai-completions" as const, base_url: "http://unused", api_key: "test" };

class FakeProjectWorkerLauncher implements ProjectWorkerLauncher {
	readonly ensured: ProjectWorkerLaunchSpec[] = [];
	/** 每次真正新建容器时签发的项目令牌（复用运行中容器时绝不签发）。 */
	readonly issuedTokens: string[] = [];
	readonly stopped: string[] = [];
	readonly removed: string[] = [];
	readonly states = new Map<string, string>();

	async ping(): Promise<void> {}
	containerName(projectId: string): string {
		return `cairn-pw-${projectId}`;
	}
	projectIdForContainer(handle: string): string | null {
		return handle.startsWith("cairn-pw-") ? handle.slice("cairn-pw-".length) || null : null;
	}
	async ensure(spec: ProjectWorkerLaunchSpec): Promise<string> {
		this.ensured.push(spec);
		const name = this.containerName(spec.projectId);
		if (this.states.get(name) === "running") {
			// 与 DockerProjectWorkerLauncher 相同：运行中的容器复用既有令牌。
			return name;
		}
		this.issuedTokens.push(await spec.issueToken());
		this.states.set(name, "running");
		return name;
	}
	async state(handle: string): Promise<string | null> {
		return this.states.get(handle) ?? null;
	}
	async logs(): Promise<string | null> {
		return null;
	}
	async stop(handle: string): Promise<boolean> {
		this.stopped.push(handle);
		this.states.set(handle, "exited");
		return true;
	}
	async remove(handle: string): Promise<boolean> {
		this.removed.push(handle);
		this.states.delete(handle);
		return true;
	}
	async listManaged(): Promise<Array<{ name: string; state: string }>> {
		return [...this.states.entries()].map(([name, state]) => ({ name, state }));
	}
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition not met before timeout");
}

async function fixture() {
	const server = await startExecutorTestServer(model);
	const pid = await createProject(server.client);
	const sid = await addStep(server.client, pid);
	const executionId = randomUUID();
	expect((await server.client.claimStep(pid, sid, executionId)).ok).toBe(true);
	const launcher = new FakeProjectWorkerLauncher();
	const runner = createProjectExecuteRunner({
		config: testConfig(server.url),
		client: server.client,
		projectLauncher: launcher,
		logger: silentLogger,
	});
	return { server, pid, sid, executionId, launcher, runner };
}

function context(f: Awaited<ReturnType<typeof fixture>>) {
	return { client: f.server.client, projectId: f.pid, stepId: f.sid, worker: f.executionId };
}

test(
	"project execute runner ensures one container and succeeds when the worker reports",
	{ timeout: 15_000 },
	async () => {
		const f = await fixture();
		const controller = new AbortController();
		const running = f.runner(context(f), controller.signal);

		await waitUntil(() => f.launcher.issuedTokens.length === 1, 5_000);
		const spec = f.launcher.ensured[0]!;
		expect(spec.projectId).toBe(f.pid);
		expect(spec.concurrency).toBe(4);
		expect(f.launcher.stopped).toHaveLength(0);

		// 模拟项目容器内的 worker：用项目令牌 next() 领取，再用现签令牌上报结果。
		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, f.launcher.issuedTokens[0]!);
		const next = await projectClient.nextTask();
		expect(next.ok, next.text).toBe(true);
		expect(next.data?.execution_id).toBe(f.executionId);
		const worker = new WorkerClient(f.server.url, f.executionId, next.data!.token);
		expect(
			(
				await worker.reportResult({
					outcome: "succeeded",
					result: {
						schema_version: 1,
						task_status: "satisfied" as const,
						summary: "done",
						unresolved: [],
					},
				})
			).ok,
		).toBe(true);

		expect(await running).toBe("success");
		expect(getExecutionRow(f.server.db, f.executionId).status).toBe("succeeded");
		// 项目容器不被 runner 回收 —— 它归项目所有。
		expect(f.launcher.removed).toHaveLength(0);
		expect(await f.launcher.state(f.launcher.containerName(f.pid))).toBe("running");
	},
);

test(
	"retries the idempotent create POST when the first response is lost",
	{ timeout: 15_000 },
	async () => {
		const f = await fixture();
		const create = f.server.client.createExecution.bind(f.server.client);
		let calls = 0;
		const createSpy = vi
			.spyOn(f.server.client, "createExecution")
			.mockImplementation(async (body) => {
				calls += 1;
				const committed = await create(body);
				expect(committed.ok).toBe(true);
				if (calls === 1) {
					// 首次提交在服务端已落库，但响应丢失。
					return {
						...committed,
						ok: false,
						statusCode: 0,
						data: undefined,
						text: "response lost",
					};
				}
				// 重发命中服务端幂等回放。
				return committed;
			});
		const running = f.runner(context(f), new AbortController().signal);
		await waitUntil(() => f.launcher.issuedTokens.length === 1, 5_000);
		// 重发本身确认了创建；不需要退化成 GET 对账。
		expect(createSpy).toHaveBeenCalledTimes(2);
		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, f.launcher.issuedTokens[0]!);
		const next = await waitForNext(projectClient);
		const worker = new WorkerClient(f.server.url, f.executionId, next.token);
		expect(
			(
				await worker.reportResult({
					outcome: "succeeded",
					result: { schema_version: 1, task_status: "satisfied", summary: "done", unresolved: [] },
				})
			).ok,
		).toBe(true);
		expect(await running).toBe("success");
		expect(getExecutionRow(f.server.db, f.executionId)).toMatchObject({
			status: "succeeded",
			attempt: 1,
		});
	},
);

test(
	"falls back to GET reconciliation when every create POST response is lost",
	{ timeout: 15_000 },
	async () => {
		const f = await fixture();
		const create = f.server.client.createExecution.bind(f.server.client);
		vi.spyOn(f.server.client, "createExecution").mockImplementation(async (body) => {
			const committed = await create(body);
			expect(committed.ok).toBe(true);
			// 旧控制端（重复创建报错）或代理吞响应的场景：POST 永远拿不到可用回包。
			return { ...committed, ok: false, statusCode: 0, data: undefined, text: "response lost" };
		});
		const readSpy = vi.spyOn(f.server.client, "getExecution");
		const running = f.runner(context(f), new AbortController().signal);
		await waitUntil(() => f.launcher.issuedTokens.length === 1, 5_000);
		expect(readSpy).toHaveBeenCalledWith(f.executionId);
		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, f.launcher.issuedTokens[0]!);
		const next = await waitForNext(projectClient);
		const worker = new WorkerClient(f.server.url, f.executionId, next.token);
		expect(
			(
				await worker.reportResult({
					outcome: "succeeded",
					result: { schema_version: 1, task_status: "satisfied", summary: "done", unresolved: [] },
				})
			).ok,
		).toBe(true);
		expect(await running).toBe("success");
		expect(getExecutionRow(f.server.db, f.executionId)).toMatchObject({
			status: "succeeded",
			attempt: 1,
		});
	},
);

test(
	"reconciles a 409 create reply instead of assuming the execution was not created",
	{ timeout: 15_000 },
	async () => {
		const f = await fixture();
		const create = f.server.client.createExecution.bind(f.server.client);
		vi.spyOn(f.server.client, "createExecution").mockImplementation(async (body) => {
			const committed = await create(body);
			expect(committed.ok).toBe(true);
			// 409 也可能发生在提交成功之后（代理/重复投递）；不能据此释放租约。
			return { ...committed, ok: false, statusCode: 409, data: undefined, text: "duplicate" };
		});
		const readSpy = vi.spyOn(f.server.client, "getExecution");
		const running = f.runner(context(f), new AbortController().signal);
		await waitUntil(() => f.launcher.issuedTokens.length === 1, 5_000);
		expect(readSpy).toHaveBeenCalledWith(f.executionId);
		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, f.launcher.issuedTokens[0]!);
		const next = await waitForNext(projectClient);
		const worker = new WorkerClient(f.server.url, f.executionId, next.token);
		expect(
			(
				await worker.reportResult({
					outcome: "succeeded",
					result: { schema_version: 1, task_status: "satisfied", summary: "done", unresolved: [] },
				})
			).ok,
		).toBe(true);
		expect(await running).toBe("success");
	},
);

test("a definite 409 create rejection with no stored execution releases the Step", async () => {
	const f = await fixture();
	// 例如未配置 execute 模型：服务端 409 且事务回滚，执行行根本不存在。
	vi.spyOn(f.server.client, "createExecution").mockResolvedValue({
		statusCode: 409,
		ok: false,
		data: undefined,
		text: "请先配置 Agent 模型",
	});
	expect(await f.runner(context(f), new AbortController().signal)).toBe("failed");
	expect(f.launcher.ensured).toHaveLength(0);
});

test("does not treat an unresolved create response as definite failure", async () => {
	const f = await fixture();
	const create = f.server.client.createExecution.bind(f.server.client);
	vi.spyOn(f.server.client, "createExecution").mockImplementation(async (body) => {
		const committed = await create(body);
		return { ...committed, ok: false, statusCode: 0, data: undefined, text: "response lost" };
	});
	vi.spyOn(f.server.client, "getExecution").mockResolvedValue({
		statusCode: 0,
		ok: false,
		data: undefined,
		text: "unreachable",
	});
	expect(await f.runner(context(f), new AbortController().signal)).toBe("uncertain");
	expect(getExecutionRow(f.server.db, f.executionId).status).toBe("queued");
	expect(f.launcher.ensured).toHaveLength(0);
});

test(
	"project execute runner reuses a running container without reissuing a token",
	{ timeout: 15_000 },
	async () => {
		const f = await fixture();
		const name = f.launcher.containerName(f.pid);
		// 模拟「容器已在运行」：先真的签发一个项目令牌，再让假启动器报告 running。
		const issued = await f.server.client.issueProjectWorkerToken(f.pid, name);
		expect(issued.ok).toBe(true);
		const token = issued.data!.token;
		f.launcher.ensured.length = 0;
		await f.launcher.ensure({ projectId: f.pid, issueToken: async () => token, concurrency: 4 });
		expect(await f.launcher.state(name)).toBe("running");
		f.launcher.ensured.length = 0;

		const controller = new AbortController();
		const running = f.runner(context(f), controller.signal);

		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, token);
		const next = await waitForNext(projectClient);
		const worker = new WorkerClient(f.server.url, f.executionId, next.token);
		expect(
			(
				await worker.reportResult({
					outcome: "succeeded",
					result: {
						schema_version: 1,
						task_status: "satisfied" as const,
						summary: "done",
						unresolved: [],
					},
				})
			).ok,
		).toBe(true);
		expect(await running).toBe("success");

		// 运行中的容器被复用：ensure 仍被调用（状态判定在启动器内），但只签发过
		// 一次令牌（模拟并发拉起容器的那一次），运行中的旧令牌未被吊销。
		expect(f.launcher.ensured).toHaveLength(1);
		expect(f.launcher.issuedTokens).toHaveLength(1);
	},
);

test(
	"a concurrently created container is reused without revoking its running token",
	{ timeout: 15_000 },
	async () => {
		const f = await fixture();
		const name = f.launcher.containerName(f.pid);
		// 模拟竞态：容器已被并发 dispatcher 拉起并持有旧令牌。
		const issued = await f.server.client.issueProjectWorkerToken(f.pid, name);
		expect(issued.ok).toBe(true);
		const runningToken = issued.data!.token;
		f.launcher.states.set(name, "running");

		const controller = new AbortController();
		const runnerDone = f.runner(context(f), controller.signal);
		await waitUntil(() => f.launcher.ensured.length === 1, 5_000);
		// 关键断言：ensure 发现容器已在运行，绝不签发新令牌（签发即吊销旧令牌）。
		expect(f.launcher.issuedTokens).toHaveLength(0);

		// 旧令牌仍然有效：还能领取 queued execution。
		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, runningToken);
		const next = await waitForNext(projectClient);
		expect(next.execution_id).toBe(f.executionId);

		controller.abort("race test");
		expect(await runnerDone).toBe("cancelled");
		// 容器归项目所有：runner 不回收它。
		expect(f.launcher.removed).toHaveLength(0);
		expect(await f.launcher.state(name)).toBe("running");
	},
);

test("project execute runner cancels only the step and leaves the container running", async () => {
	const f = await fixture();
	const controller = new AbortController();
	const running = f.runner(context(f), controller.signal);

	await waitUntil(() => f.launcher.ensured.length === 1, 5_000);
	controller.abort("project stopped");

	expect(await running).toBe("cancelled");
	expect(getExecutionRow(f.server.db, f.executionId).status).toBe("cancelled");
	// 容器归项目所有：取消单个 step 绝不 stop/remove 它。
	expect(f.launcher.stopped).toHaveLength(0);
	expect(f.launcher.removed).toHaveLength(0);
	expect(await f.launcher.state(f.launcher.containerName(f.pid))).toBe("running");
});

test("deadline reconciliation trusts a worker terminal result after a conflicting forced transition", async () => {
	const f = await fixture();
	const create = f.server.client.createExecution.bind(f.server.client);
	vi.spyOn(f.server.client, "createExecution").mockImplementation(async (body) => {
		const created = await create(body);
		if (!created.ok || created.data === undefined) return created;
		return {
			...created,
			data: { ...created.data, deadline_at: new Date(0).toISOString() },
		};
	});
	const get = f.server.client.getExecution.bind(f.server.client);
	const forcedStatus = vi
		.spyOn(f.server.client, "setExecutionStatus")
		.mockResolvedValue({ statusCode: 409, ok: false, data: undefined, text: "already terminal" });
	vi.spyOn(f.server.client, "getExecution").mockImplementation(async (id) => {
		const observed = await get(id);
		if (!observed.ok || observed.data === undefined) return observed;
		return {
			...observed,
			data: { ...observed.data, status: "succeeded" },
		};
	});

	const result = await f.runner(context(f), new AbortController().signal);
	expect(result).toBe("success");
	expect(forcedStatus).toHaveBeenCalledWith(f.executionId, {
		status: "lost",
		error: "controller deadline exceeded; project worker step cancelled",
	});
});

/** 轮询 next()，直到 runner 已创建 execution（204 表示还没出现）。 */
async function waitForNext(
	client: ProjectWorkerClient,
): Promise<{ execution_id: string; token: string }> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const next = await client.nextTask();
		if (next.ok && next.data !== undefined) {
			return { execution_id: next.data.execution_id, token: next.data.token };
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("project worker next never returned a task");
}

test("preparation failures preserve audit attempts without exhausting business retries", async () => {
	const f = await fixture();
	// fixture already holds the first lease. Subsequent attempts use new UUIDs.
	const ids: string[] = [];
	const ensure = f.launcher.ensure.bind(f.launcher);
	f.launcher.ensure = async () => {
		throw new Error("daemon unavailable");
	};
	for (let i = 0; i < 5; i += 1) {
		const id = i === 0 ? f.executionId : randomUUID();
		if (i > 0) expect((await f.server.client.claimStep(f.pid, f.sid, id)).ok).toBe(true);
		ids.push(id);
		expect(await f.runner({ ...context(f), worker: id }, new AbortController().signal)).toBe(
			"failed",
		);
		expect(getExecutionRow(f.server.db, id)).toMatchObject({
			attempt: i + 1,
			status: "failed",
			started_at: null,
			result_outcome: null,
			error: "project container ensure failed: daemon unavailable",
		});
		expect(getExecutionRow(f.server.db, id).finished_at).not.toBeNull();
		expect((await f.server.client.releaseStep(f.pid, f.sid, id)).data?.status).toBe("open");
	}
	f.launcher.ensure = ensure;
	// Real worker failures must still exhaust the default cap of three, not on
	// the first failure merely because its audit ordinal is already six.
	for (let i = 0; i < 3; i += 1) {
		const id = randomUUID();
		ids.push(id);
		expect((await f.server.client.claimStep(f.pid, f.sid, id)).ok).toBe(true);
		const created = await f.server.client.createExecution({
			project_id: f.pid,
			step_id: f.sid,
			execution_id: id,
		});
		expect(created.data?.attempt).toBe(i + 6);
		const issued = await f.server.client.issueProjectWorkerToken(f.pid, `cairn-pw-test-${i}`);
		expect(issued.ok).toBe(true);
		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, issued.data!.token);
		const next = await projectClient.nextTask();
		expect(next.ok, next.text).toBe(true);
		expect(next.data?.execution_id).toBe(id);
		const worker = new WorkerClient(f.server.url, id, next.data!.token);
		expect((await worker.reportResult({ outcome: "failed", error: "executed failure" })).ok).toBe(
			true,
		);
		if (i < 2) {
			expect((await f.server.client.releaseStep(f.pid, f.sid, id)).data?.status).toBe("open");
			// Simulate older result-bearing history missing its start timestamp.
			// It must still count toward the cap on the final failure.
			f.server.db.prepare("UPDATE executions SET started_at = NULL WHERE id = ?").run(id);
			expect(getExecutionRow(f.server.db, id).result_outcome).toBe("failed");
		}
	}
	const step = (await inspectClientProject(f.server.client, f.pid)).steps.find(
		(s) => s.id === f.sid,
	)!;
	expect(step.status).toBe("abandoned");
	expect(step.attempts).toBe(8);
	const history = f.server.db
		.prepare(
			"SELECT id, attempt FROM executions WHERE project_id = ? AND step_id = ? ORDER BY attempt",
		)
		.all(f.pid, f.sid);
	expect(history).toEqual(ids.map((id, index) => ({ id, attempt: index + 1 })));
});

test("ensure failure after worker claim monitors the execution instead of releasing it", async () => {
	const f = await fixture();
	let worker: WorkerClient | undefined;
	let claimed = false;
	f.launcher.ensure = async (spec) => {
		const projectClient = new ProjectWorkerClient(f.server.url, f.pid, await spec.issueToken());
		const next = await projectClient.nextTask();
		expect(next.data?.execution_id).toBe(f.executionId);
		worker = new WorkerClient(f.server.url, f.executionId, next.data!.token);
		claimed = true;
		throw new Error("ensure response lost after startup");
	};
	let settled = false;
	const running = f.runner(context(f), new AbortController().signal).finally(() => {
		settled = true;
	});
	await waitUntil(() => claimed, 5_000);
	// The controller refuses running -> failed with 409; runner must not settle.
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(settled).toBe(false);
	expect(getExecutionRow(f.server.db, f.executionId)).toMatchObject({
		status: "running",
		attempt: 1,
	});
	expect(
		(
			await worker!.reportResult({
				outcome: "succeeded",
				result: {
					schema_version: 1,
					task_status: "satisfied" as const,
					summary: "done despite ensure error",
					unresolved: [],
				},
			})
		).ok,
	).toBe(true);
	expect(await running).toBe("success");
	expect(getExecutionRow(f.server.db, f.executionId)).toMatchObject({
		status: "succeeded",
		attempt: 1,
	});
	expect(f.launcher.removed).toHaveLength(0);
});
