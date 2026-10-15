import { afterEach, expect, test, vi } from "vitest";
import { cachedJSON, clearReadCache } from "../../src/web/read-cache.js";
const api = (path: string, options: RequestInit = {}) =>
	cachedJSON(path, options, async (res) => {
		if (!res.ok) throw new Error(String(res.status));
	});
afterEach(() => {
	clearReadCache();
	vi.unstubAllGlobals();
});

test("304 reuses the cached object and mutations invalidate conditional headers", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ value: 1 }), { headers: { ETag: 'W/"v1"' } }),
		)
		.mockResolvedValueOnce(new Response(null, { status: 304 }))
		.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ value: 2 }), { headers: { ETag: 'W/"v2"' } }),
		);
	vi.stubGlobal("fetch", fetch);
	const first = await api("/test");
	expect(await api("/test")).toBe(first);
	expect(new Headers(fetch.mock.calls[1][1].headers).get("If-None-Match")).toBe('W/"v1"');
	await api("/mutation", { method: "POST" });
	expect(await api("/test")).toEqual({ value: 2 });
	expect(new Headers(fetch.mock.calls[3][1].headers).has("If-None-Match")).toBe(false);
});

test("a 304 without a cached body is retried as an unconditional GET", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(new Response(null, { status: 304 }))
		.mockResolvedValueOnce(new Response('{"value":3}', { headers: { ETag: 'W/"v3"' } }));
	vi.stubGlobal("fetch", fetch);
	expect(await api("/empty")).toEqual({ value: 3 });
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(new Headers(fetch.mock.calls[1][1].headers).has("If-None-Match")).toBe(false);
});
