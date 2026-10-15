/**
 * Spike 1：pi-ai 可以通过自定义 Model（其 baseUrl 指向目标 endpoint）
 * 与任意兼容 OpenAI 的 chat-completions endpoint 通信
 * （DeepSeek / Qwen / vLLM 风格）。
 *
 * 我们用 node:http 起一个本地 mock server，实现
 * POST /v1/chat/completions（SSE 流式，pi-ai 总是用它），并断言
 * complete() 和 stream() 都能返回 mock 模型的回复。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";

import { tmpdir } from "node:os";
import path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ModelConfig } from "../../src/scheduler/config.js";

const RESPONSE_TEXT = "mock-endpoint-reply: pong from cairn-x";

interface CapturedRequest {
	path: string;
	authorization: string | undefined;
	body: {
		model?: string;
		stream?: boolean;
		messages?: Array<{ role: string; content: unknown }>;
	};
}

const captured: CapturedRequest[] = [];
let server: Server;
let baseUrl: string;

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

beforeAll(async () => {
	server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			captured.push({
				path: req.url ?? "",
				authorization: req.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			const base = {
				id: "chatcmpl-mock-1",
				object: "chat.completion.chunk",
				created: 1_700_000_000,
				model: "deepseek-chat",
			};
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				sseChunk({
					...base,
					choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
				}),
			);
			res.write(
				sseChunk({
					...base,
					choices: [
						{ index: 0, delta: { content: RESPONSE_TEXT.slice(0, 12) }, finish_reason: null },
					],
				}),
			);
			res.write(
				sseChunk({
					...base,
					choices: [{ index: 0, delta: { content: RESPONSE_TEXT.slice(12) }, finish_reason: null }],
				}),
			);
			res.write(
				sseChunk({
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
				}),
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

/** 故意使用 pi-ai 不认识的 provider：证明任意厂商都能接入。 */
function makeConfig(): ModelConfig {
	return {
		model_id: "deepseek-chat",
		base_url: baseUrl,
		api_key: "test-key",
		api: "openai-completions",
	};
}

async function makeRuntime() {
	const config = makeConfig();
	const runtime = await ModelRuntime.create({
		authPath: path.join(tmpdir(), "cairn-x-spike-auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	runtime.registerProvider("mock-vendor", {
		api: config.api,
		baseUrl: config.base_url,
		apiKey: config.api_key,
		models: [
			{
				id: config.model_id,
				name: config.model_id,
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 32_768,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	return { model: runtime.getModel("mock-vendor", config.model_id)!, runtime };
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a ping-pong bot.",
		messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
	};
}

test("complete() returns the reply from a custom OpenAI-compatible endpoint", async () => {
	const { model, runtime } = await makeRuntime();
	const message = await runtime.complete(model, makeContext());

	expect(message.stopReason).toBe("stop");
	const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	expect(text).toBe(RESPONSE_TEXT);
	expect(message.usage.totalTokens).toBe(19);

	// endpoint 收到的请求符合预期：路径、auth 头、模型 id、
	// 流式标志，以及我们的 user 消息都正确。
	expect(captured.length).toBe(1);
	expect(captured[0].path).toBe("/v1/chat/completions");
	expect(captured[0].authorization).toBe("Bearer test-key");
	expect(captured[0].body.model).toBe("deepseek-chat");
	expect(captured[0].body.stream).toBe(true);
	expect(captured[0].body.messages?.at(-1)).toMatchObject({ role: "user", content: "ping" });
});

test("stream() emits incremental events from the custom endpoint", async () => {
	const { model, runtime } = await makeRuntime();
	const events: AssistantMessageEvent[] = [];
	const eventStream = runtime.stream(model, makeContext());
	for await (const event of eventStream) {
		events.push(event);
	}
	const message = await eventStream.result();

	expect(events[0].type).toBe("start");
	expect(events.some((event) => event.type === "text_delta")).toBe(true);
	const done = events.at(-1);
	expect(done?.type).toBe("done");
	const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	expect(text).toBe(RESPONSE_TEXT);
});
