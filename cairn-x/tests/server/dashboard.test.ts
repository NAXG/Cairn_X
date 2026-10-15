import { expect, test } from "vitest";
import { createTestServer, get } from "./helpers.js";
test("GET / serves built React console and cache-safe assets", async () => {
	const { app } = createTestServer();
	const res = await get(app, "/");
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("no-store");
	const html = await res.text();
	expect(html).toContain('id="root"');
	const asset = html.match(/src="([^"]+\.js)"/)?.[1];
	expect(asset).toMatch(/^\/static\/web\/assets\//);
	const js = await get(app, asset!);
	expect(js.status).toBe(200);
	expect(js.headers.get("cache-control")).toContain("immutable");
	const notice = await get(app, "/static/web/THIRD_PARTY_NOTICES.txt");
	expect(notice.status).toBe(200);
	expect(notice.headers.get("cache-control")).toBe("no-cache");
	expect(await notice.text()).toContain("Copyright (c) 2026 agegr");
});
test("static paths reject traversal and missing assets", async () => {
	const { app } = createTestServer();
	expect((await get(app, "/static/../cli.ts")).status).toBe(404);
	expect((await get(app, "/static/web/not-found.js")).status).toBe(404);
	expect((await get(app, "/static/favicon.svg")).status).toBe(200);
});
