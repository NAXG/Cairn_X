import { afterEach, expect, test, vi } from "vitest";

import { DockerProjectWorkerLauncher } from "../../src/scheduler/launcher.js";

afterEach(() => {
	vi.useRealTimers();
});

function failingLauncher() {
	const launcher = new DockerProjectWorkerLauncher({ image: "unused" } as never);
	const inspectState = vi.fn(async () => {
		throw new Error("docker daemon down");
	});
	(launcher as unknown as { manager: unknown }).manager = { inspectState };
	return { launcher, inspectState };
}

const spec = { projectId: "p1", concurrency: 1, issueToken: async () => "token" };

test("a failed ensure backs the project off exponentially and a success clears it", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	const { launcher } = failingLauncher();
	expect(launcher.coolingDown("p1")).toBe(false);

	await expect(launcher.ensure(spec)).rejects.toThrow("docker daemon down");
	expect(launcher.coolingDown("p1")).toBe(true);
	expect(launcher.coolingDown("p2")).toBe(false);
	vi.setSystemTime(5_000);
	expect(launcher.coolingDown("p1")).toBe(false);

	// 第二次失败：退避翻倍到 10s。
	await expect(launcher.ensure(spec)).rejects.toThrow();
	vi.setSystemTime(5_000 + 9_000);
	expect(launcher.coolingDown("p1")).toBe(true);
	vi.setSystemTime(5_000 + 10_000);
	expect(launcher.coolingDown("p1")).toBe(false);

	(launcher as unknown as { manager: unknown }).manager = {
		inspectState: async () => "running",
	};
	await expect(launcher.ensure(spec)).resolves.toBeTypeOf("string");
	await expect(
		(async () => {
			(launcher as unknown as { manager: unknown }).manager = {
				inspectState: async () => {
					throw new Error("again");
				},
			};
			await launcher.ensure(spec);
		})(),
	).rejects.toThrow();
	// 成功后计数清零：下一次失败重新从 5s 起算。
	vi.setSystemTime(5_000 + 10_000 + 5_000);
	expect(launcher.coolingDown("p1")).toBe(false);
});

test("ensure refuses to issue a new token when the stale container cannot be removed", async () => {
	const launcher = new DockerProjectWorkerLauncher({ image: "unused" } as never);
	const issueToken = vi.fn(async () => "token");
	(launcher as unknown as { manager: unknown }).manager = {
		inspectState: async () => "exited",
		dispose: async () => false,
	};
	await expect(launcher.ensure({ ...spec, issueToken })).rejects.toThrow(/failed to remove/);
	expect(issueToken).not.toHaveBeenCalled();
});
