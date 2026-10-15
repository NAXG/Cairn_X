import { describe, expect, it, vi } from "vitest";

import type { ApiResult } from "../../src/orchestrator/client.js";
import { HeartbeatLease, type HeartbeatFailure } from "../../src/shared/heartbeat.js";

function ok(): ApiResult {
	return { statusCode: 200, ok: true, data: {}, text: "" };
}

function fail(statusCode: number): ApiResult {
	return { statusCode, ok: false, data: undefined, text: `status ${statusCode}` };
}

function makeLease(
	heartbeat: () => Promise<ApiResult>,
	options: { intervalSeconds?: number; onFailure?: (f: HeartbeatFailure) => void } = {},
): HeartbeatLease {
	return new HeartbeatLease({
		heartbeat,
		scope: "test",
		worker: "w1",
		intervalSeconds: options.intervalSeconds ?? 0.05,
		onFailure: options.onFailure,
	});
}

describe("HeartbeatLease", () => {
	it("renews the lease on an interval until stopped", async () => {
		let beats = 0;
		const lease = makeLease(async () => {
			beats += 1;
			return ok();
		});
		lease.start();
		await vi.waitFor(() => expect(beats).toBeGreaterThanOrEqual(3), { timeout: 2000 });
		expect(lease.failure).toBeNull();
		lease.stop();
		const stoppedAt = beats;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(beats).toBe(stoppedAt);
	});

	it("fails immediately on 403 and invokes onFailure", async () => {
		let beats = 0;
		const failures: HeartbeatFailure[] = [];
		const lease = makeLease(
			async () => {
				beats += 1;
				return fail(403);
			},
			{ onFailure: (f) => failures.push(f) },
		);
		lease.start();
		await vi.waitFor(() => expect(lease.failure).not.toBeNull(), { timeout: 2000 });
		expect(lease.failure?.statusCode).toBe(403);
		expect(failures).toHaveLength(1);
		const beatsAtFailure = beats;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(beats).toBe(beatsAtFailure);
		lease.stop();
	});

	it("fails immediately on 409 (lease lost)", async () => {
		const lease = makeLease(async () => fail(409));
		lease.start();
		await vi.waitFor(() => expect(lease.failure?.statusCode).toBe(409), { timeout: 2000 });
		lease.stop();
	});

	it("tolerates transient failures within the grace window", async () => {
		let beats = 0;
		const lease = makeLease(async () => {
			beats += 1;
			// 一次瞬时失败，然后恢复
			return beats === 1 ? fail(500) : ok();
		});
		lease.start();
		await vi.waitFor(() => expect(beats).toBeGreaterThanOrEqual(4), { timeout: 2000 });
		expect(lease.failure).toBeNull();
		lease.stop();
	});

	it("fails after the grace window when errors persist", async () => {
		// interval 50ms、grace 100ms：失败标志必须在几次心跳之内出现。
		const lease = makeLease(async () => fail(500));
		lease.start();
		await vi.waitFor(() => expect(lease.failure).not.toBeNull(), { timeout: 2000 });
		expect(lease.failure?.statusCode).toBe(500);
		lease.stop();
	});

	it("treats heartbeat exceptions like transient network failures", async () => {
		let beats = 0;
		const lease = makeLease(async () => {
			beats += 1;
			if (beats === 1) {
				throw new Error("connection reset");
			}
			return ok();
		});
		lease.start();
		await vi.waitFor(() => expect(beats).toBeGreaterThanOrEqual(4), { timeout: 2000 });
		expect(lease.failure).toBeNull();
		lease.stop();
	});

	it("never beats when stopped before start", async () => {
		let beats = 0;
		const lease = makeLease(async () => {
			beats += 1;
			return ok();
		});
		lease.start();
		lease.stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(beats).toBe(0);
	});

	it("forDecide builds a lease against the client", async () => {
		const calls: string[] = [];
		const client = {
			heartbeatDecide: async (p: string, w: string): Promise<ApiResult> => {
				calls.push(`decide:${p}:${w}`);
				return ok();
			},
		};
		const decideLease = HeartbeatLease.forDecide(client, "proj_001", "w2", 0.03);
		decideLease.start();
		await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1), { timeout: 2000 });
		decideLease.stop();
		expect(calls).toContain("decide:proj_001:w2");
	});
});

it("a stalled renewal cannot outlive the granted lease", async () => {
	vi.useFakeTimers();
	try {
		const onFailure = vi.fn();
		const lease = new HeartbeatLease({
			heartbeat: () => new Promise(() => {}),
			scope: "test",
			worker: "w",
			intervalSeconds: 1,
			leaseTimeoutSeconds: 6,
			onFailure,
		});
		lease.start();
		await vi.advanceTimersByTimeAsync(4000);
		expect(onFailure).toHaveBeenCalledOnce();
		expect(lease.failure?.text).toBe("Lease renewal deadline exceeded");
		lease.stop();
	} finally {
		vi.useRealTimers();
	}
});
