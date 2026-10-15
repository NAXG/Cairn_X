import { describe, expect, it } from "vitest";

import { TSecBenchClient, normalizeError } from "../../src/tsecbench/client.js";

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

/** 记录请求并返回脚本化响应。 */
function fakeFetch(
	respond: (call: Call) => { status: number; body: string; contentType?: string },
): { fetchImpl: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const call: Call = {
			url,
			method: init?.method ?? "GET",
			// 实现经 requestJson 用 new Headers(...) 规范化过，必须按 Headers 读。
			headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()),
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		calls.push(call);
		const result = respond(call);
		return new Response(result.body, {
			status: result.status,
			headers: { "Content-Type": result.contentType ?? "application/json" },
		});
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch): TSecBenchClient {
	return new TSecBenchClient({
		baseUrl: "https://tsecbench.example.com/",
		token: "test-token",
		fetchImpl,
	});
}

describe("TSecBenchClient", () => {
	it("lists challenges with the BENCHMARK_TOKEN header", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({
			status: 200,
			body: JSON.stringify([
				{
					unique_code: "web_sql_injection_01",
					description: "SQLi",
					difficulty: "easy",
					level: 1,
					total_score: 100,
					flag_count: 2,
					correct_flag_count: 1,
					is_completed: false,
					container_status: "available",
					container_addr: ["10.0.1.5:8080"],
				},
			]),
		}));
		const result = await client(fetchImpl).listChallenges();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0]?.unique_code).toBe("web_sql_injection_01");
		expect(calls[0]?.url).toBe("https://tsecbench.example.com/openapi/v1/challenges");
		// Headers 会把名字规范化成小写，这正是发到线上的样子。
		expect(calls[0]?.headers.benchmark_token).toBe("test-token");
	});

	it("encodes unique_code in start/hint/close query strings", async () => {
		const { fetchImpl, calls } = fakeFetch((call) => {
			if (call.url.includes("/start")) {
				return { status: 200, body: JSON.stringify({ unique_code: "a b", container_addr: [] }) };
			}
			if (call.url.includes("/hint")) {
				return { status: 200, body: JSON.stringify({ unique_code: "a b", hint: "try harder" }) };
			}
			return { status: 200, body: JSON.stringify({ unique_code: "a b", closed: true }) };
		});
		const c = client(fetchImpl);
		await c.startChallenge("a b");
		await c.getHint("a b");
		await c.closeChallenge("a b");
		expect(calls[0]?.url).toContain("/openapi/v1/challenges/start?unique_code=a+b");
		expect(calls[1]?.url).toContain("/openapi/v1/challenges/hint?unique_code=a+b");
		expect(calls[2]?.url).toContain("/openapi/v1/challenges/close?unique_code=a+b");
	});

	it("posts a flag submission as JSON", async () => {
		const { fetchImpl, calls } = fakeFetch(() => ({
			status: 200,
			body: JSON.stringify({
				correct: true,
				awarded: 50,
				cumulative_score: 80,
				correct_flag_count: 2,
				total_flag_count: 3,
				matched_flag_index: 1,
			}),
		}));
		const result = await client(fetchImpl).submitFlag("web_01", "flag{example}");
		expect(result.ok).toBe(true);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe("https://tsecbench.example.com/openapi/v1/challenges/submit");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			unique_code: "web_01",
			flag: "flag{example}",
		});
	});

	it.each([
		[404, "task_not_found"],
		[404, "challenge_not_found"],
		[409, "invalid_state"],
		[409, "duplicate"],
		[503, "resource_unavailable"],
		[500, "internal_error"],
	])("maps %i %s business errors without throwing", async (status, code) => {
		const { fetchImpl } = fakeFetch(() => ({
			status,
			body: JSON.stringify({ code, message: `boom ${code}`, detail: {} }),
		}));
		const result = await client(fetchImpl).submitFlag("c", "flag{x}");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe(code);
		expect(result.error.message).toBe(`boom ${code}`);
		expect(result.error.status).toBe(status);
	});

	it("maps the FastAPI 422 body to validation_error", async () => {
		const { fetchImpl } = fakeFetch(() => ({
			status: 422,
			body: JSON.stringify({ detail: [{ loc: ["body", "flag"], msg: "too short" }] }),
		}));
		const result = await client(fetchImpl).submitFlag("c", "");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("validation_error");
		expect(result.error.detail).toEqual([{ loc: ["body", "flag"], msg: "too short" }]);
	});

	it("maps transport failures to network_error with status 0", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		const result = await client(fetchImpl).listChallenges();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("network_error");
		expect(result.error.status).toBe(0);
	});

	it("maps unparseable errors to unexpected_error", () => {
		expect(normalizeError(502, undefined, "<html>bad gateway</html>")).toMatchObject({
			code: "unexpected_error",
			status: 502,
		});
		expect(normalizeError(500, { error: "nope" }, "")).toMatchObject({
			code: "unexpected_error",
		});
	});
});
