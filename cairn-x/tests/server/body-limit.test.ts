import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";
import { onTestFinished } from "vitest";

import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";

const AUTH = { user: "admin", password: "s3cret" };

function createTestApp() {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-bodylimit-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const app = createApp(db, AUTH);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return app;
}

test("oversized JSON body is rejected with 413", async () => {
	const app = createTestApp();
	// 65MB 超过 64MB 上限；bodyLimit 按 content-length 即时拒绝，不会读入内存。
	const response = await app.request("/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "x".repeat(65 * 1024 * 1024),
	});
	expect(response.status).toBe(413);
});

test("normal-sized bodies still pass", async () => {
	const app = createTestApp();
	const response = await app.request("/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: "admin", password: "wrong" }),
	});
	expect(response.status).toBe(401);
});

test("upload path is exempt from the JSON body limit", async () => {
	const app = createTestApp();
	// 超限的附件请求不应被 413 拦下：uploads 走独立流式限额。
	// 该请求会因缺少鉴权（无 session cookie）得到 401，证明已越过 bodyLimit。
	const response = await app.request("/projects/p-1/uploads?filename=a.bin", {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: "x".repeat(65 * 1024 * 1024),
	});
	expect(response.status).not.toBe(413);
});
