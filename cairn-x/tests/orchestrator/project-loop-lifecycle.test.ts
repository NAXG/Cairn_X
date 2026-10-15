/**
 * DispatcherLoop 的项目容器生命周期：
 * 非 active 立即回收、active 空闲超时回收、孤儿回收，以及 flag 关闭时完全 no-op。
 *
 * 回收容器时必须同时把 project_workers 注册行标为 stopped（否则会留下
 * status=running 的幽灵记录）—— 这里用真实执行控制面直接断言 DB。
 */
import { expect, test, vi } from "vitest";

import { DispatcherLoop } from "../../src/scheduler/loop.js";
import type {
	ProjectWorkerLaunchSpec,
	ProjectWorkerLauncher,
} from "../../src/scheduler/launcher.js";
import {
	addStep,
	createProject,
	recordingRunners,
	seedServerRuntime,
	silentLogger,
	startExecutorTestServer,
	testConfig,
} from "./helpers.js";

const model = { api: "openai-completions" as const, base_url: "http://unused", api_key: "test" };

class TrackingProjectLauncher implements ProjectWorkerLauncher {
	readonly removed: string[] = [];
	readonly ensured: string[] = [];
	private readonly states = new Map<string, string>();

	async ping(): Promise<void> {}
	containerName(projectId: string): string {
		return `cairn-pw-${projectId}`;
	}
	projectIdForContainer(handle: string): string | null {
		return handle.startsWith("cairn-pw-") ? handle.slice("cairn-pw-".length) || null : null;
	}
	async ensure(spec: ProjectWorkerLaunchSpec): Promise<string> {
		const name = this.containerName(spec.projectId);
		this.ensured.push(name);
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

type ExecutorServer = Awaited<ReturnType<typeof startExecutorTestServer>>;

function makeLoop(
	server: ExecutorServer,
	projectLauncher: TrackingProjectLauncher,
	clock: { value: number },
): DispatcherLoop {
	const base = testConfig(server.url);
	return new DispatcherLoop({
		config: {
			...base,
			container: { ...base.container, project_idle_seconds: 10 },
		},
		client: server.client,
		runners: recordingRunners().runners,
		launcher: projectLauncher,
		logger: silentLogger,
		now: () => clock.value,
		workerSuffix: "t0",
	});
}

function workerStatus(server: ExecutorServer, pid: string): string | undefined {
	const row = server.db
		.prepare("SELECT status FROM project_workers WHERE project_id = ?")
		.get(pid) as { status: string } | undefined;
	return row?.status;
}

async function fixture(pidToStop = false): Promise<{
	server: ExecutorServer;
	pid: string;
	launcher: TrackingProjectLauncher;
}> {
	const server = await startExecutorTestServer(model);
	seedServerRuntime(server.db, { decide_min_interval: 3600 });
	const pid = await createProject(server.client);
	const launcher = new TrackingProjectLauncher();
	// 真实签发项目令牌（写入 project_workers 行），再用假启动器模拟 running 容器。
	const issued = await server.client.issueProjectWorkerToken(pid, `cairn-pw-${pid}`);
	expect(issued.ok).toBe(true);
	await launcher.ensure({
		projectId: pid,
		issueToken: async () => issued.data!.token,
		concurrency: 4,
	});
	if (pidToStop) {
		await server.client.setProjectStatus(pid, "stopped");
	}
	return { server, pid, launcher };
}

test("non-active project container is reclaimed immediately and its worker row stopped", async () => {
	const { server, pid, launcher } = await fixture(true);
	const loop = makeLoop(server, launcher, { value: 1_000 });
	await loop.tick();
	expect(launcher.removed).toEqual([`cairn-pw-${pid}`]);
	expect(workerStatus(server, pid)).toBe("stopped");
});

test("a reclaim exception preserves the worker token and does not block other containers", async () => {
	const { server, pid, launcher } = await fixture(true);
	await launcher.ensure({ projectId: "ghost", issueToken: async () => "t", concurrency: 4 });
	const remove = vi.spyOn(launcher, "remove").mockRejectedValueOnce(new Error("docker timed out"));
	const loop = makeLoop(server, launcher, { value: 1_000 });

	await expect(loop.tick()).resolves.toBeUndefined();
	expect(workerStatus(server, pid)).toBe("pending");
	expect(launcher.removed).toEqual(["cairn-pw-ghost"]);
	await loop.tick();
	expect(remove).toHaveBeenCalledTimes(3);
	expect(workerStatus(server, pid)).toBe("stopped");
});

test.each(["reject", "false"])(
	"idle reclaim failure (%s) retries on the next tick",
	async (failure) => {
		const { server, pid, launcher } = await fixture();
		const clock = { value: 1_000 };
		const loop = makeLoop(server, launcher, clock);
		await loop.tick();
		const remove = vi.spyOn(launcher, "remove");
		if (failure === "reject") remove.mockRejectedValueOnce(new Error("inspect timed out"));
		else remove.mockResolvedValueOnce(false);
		clock.value += 10_000;
		await loop.tick();
		expect(workerStatus(server, pid)).toBe("pending");
		clock.value += 1;
		await loop.tick();
		expect(remove).toHaveBeenCalledTimes(2);
		expect(workerStatus(server, pid)).toBe("stopped");
	},
);

test("active project container survives until idle past the timeout, then row is stopped", async () => {
	const { server, pid, launcher } = await fixture();
	const clock = { value: 1_000 };
	const loop = makeLoop(server, launcher, clock);
	await loop.tick(); // 首次观察：记录忙碌时刻，不回收
	expect(launcher.removed).toHaveLength(0);

	clock.value = 1_000 + 9_000;
	await loop.tick(); // 9s < 10s：仍保留
	expect(launcher.removed).toHaveLength(0);
	expect(workerStatus(server, pid)).toBe("pending");

	clock.value = 1_000 + 10_000;
	await loop.tick(); // 达到空闲阈值：回收并标 stopped
	expect(launcher.removed).toEqual([`cairn-pw-${pid}`]);
	expect(workerStatus(server, pid)).toBe("stopped");
});

test("container for an unknown project is reclaimed without error", async () => {
	const server = await startExecutorTestServer(model);
	seedServerRuntime(server.db, { decide_min_interval: 3600 });
	const launcher = new TrackingProjectLauncher();
	await launcher.ensure({ projectId: "ghost", issueToken: async () => "t", concurrency: 4 });
	const loop = makeLoop(server, launcher, { value: 1_000 });
	await loop.tick();
	expect(launcher.removed).toEqual(["cairn-pw-ghost"]);
});

test("a restarted dispatcher preserves steps owned by another dispatcher past the idle timeout", async () => {
	const { server, pid, launcher } = await fixture();
	const sid = await addStep(server.client, pid);
	const worker = "a0000000-0000-4000-8000-000000000001";
	expect((await server.client.claimStep(pid, sid, worker)).ok).toBe(true);
	const clock = { value: 1000 };
	const loop = makeLoop(server, launcher, clock);
	await loop.tick();
	clock.value += 20_000;
	await loop.tick();
	expect(launcher.removed).toEqual([]);
	await server.client.setProjectStatus(pid, "stopped");
	await loop.tick();
	expect(launcher.removed).toEqual([`cairn-pw-${pid}`]);
});
