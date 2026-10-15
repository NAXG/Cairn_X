import { afterEach, expect, test, vi } from "vitest";
import { FgsClient, ClientError } from "../../src/orchestrator/client.js";
import { runAgent } from "../../src/agents/runtime/runner.js";

afterEach(() => vi.unstubAllGlobals());

test("a pre-aborted run never prompts the model", async () => {
	const prompt = vi.fn(async () => {});
	const controller = new AbortController();
	controller.abort();
	const result = await runAgent({
		run: {
			agent: {
				prompt,
				abort() {},
				steer() {},
				subscribe() {
					return () => {};
				},
			},
			requestStop() {},
			usage: () => ({
				activity: "execute",
				model: "mock",
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
			}),
		},
		initialMessage: "go",
		signal: controller.signal,
		timeoutMs: 10,
		graceMs: 10,
	});
	expect(result.outcome).toBe("cancelled");
	expect(prompt).not.toHaveBeenCalled();
});

test("progress checkpoints steer the agent mid-run without aborting it", async () => {
	vi.useFakeTimers();
	const steers: string[] = [];
	const abort = vi.fn();
	const never = new Promise<void>(() => {});
	try {
		void runAgent({
			run: {
				agent: {
					prompt: () => never,
					abort,
					steer(message: unknown) {
						steers.push(String((message as { content?: unknown }).content));
					},
					subscribe() {
						return () => {};
					},
				},
				requestStop() {},
				usage: () => ({
					activity: "execute",
					model: "mock",
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
				}),
			},
			initialMessage: "go",
			signal: new AbortController().signal,
			timeoutMs: 60_000,
			graceMs: 1_000,
			checkpoints: [
				{ atMs: 20_000, text: "checkpoint one" },
				{ atMs: 40_000, text: "checkpoint two" },
			],
		});
		await vi.advanceTimersByTimeAsync(20_500);
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("checkpoint one");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(steers).toHaveLength(2);
		expect(steers[1]).toContain("checkpoint two");
		expect(abort).not.toHaveBeenCalled();
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});

test("soft timeout is reported as timedOut (distinct from external cancellation)", async () => {
	vi.useFakeTimers();
	let rejectPrompt: (error: Error) => void = () => {};
	const steer = vi.fn();
	const requestStop = vi.fn();
	try {
		const handle = runAgent({
			run: {
				agent: {
					prompt: () =>
						new Promise<void>((_resolve, reject) => {
							rejectPrompt = reject;
						}),
					abort() {
						rejectPrompt(new Error("run aborted"));
					},
					steer,
					subscribe() {
						return () => {};
					},
				},
				requestStop,
				usage: () => ({
					activity: "execute",
					model: "mock",
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
				}),
			},
			initialMessage: "go",
			signal: new AbortController().signal,
			timeoutMs: 4_000,
			graceMs: 1_000,
		});
		await vi.advanceTimersByTimeAsync(4_000);
		expect(requestStop).toHaveBeenCalledTimes(1);
		expect(steer).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		const result = await handle;
		// harvest 只有在 timedOut=true 时才会在软超时后继续跑；外部取消必须保持 undefined。
		expect(result.outcome).toBe("cancelled");
		expect(result.timedOut).toBe(true);
		expect(result.cancelledReason).toBe("time limit reached");
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});

test("response-body interruption obeys read/write client error contracts", async () => {
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					start(c) {
						c.error(new Error("body interrupted"));
					},
				}),
				{ status: 200 },
			),
	);
	const client = new FgsClient("http://unused");
	expect(await client.releaseDecide("p", "w")).toMatchObject({
		ok: false,
		statusCode: 0,
		text: "body interrupted",
	});
	await expect(client.listSchedulingProjects()).rejects.toBeInstanceOf(ClientError);
	await expect(client.getProjectOverview("p")).rejects.toBeInstanceOf(ClientError);
});
