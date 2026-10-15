import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Hono } from "hono";
import { expect, onTestFinished, test, vi } from "vitest";

import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { createProject } from "./helpers.js";

test("a failed exporter load is not cached and the next export retries", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-export-retry-"));
	const db = openDatabase(path.join(dir, "test.db"));
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const app = createApp(db, undefined, undefined, dir);
	const pid = await createProject(app);
	const sessions = path.join(dir, pid, "sessions");
	mkdirSync(sessions, { recursive: true });
	writeFileSync(
		path.join(sessions, "decide-2026-01-01T00-00-00-000Z.jsonl"),
		JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-01-01", cwd: "/" }) +
			"\n",
	);

	// 注入一次导出模块加载失败：getPackageDir 抛错 → loadExporter 的 Promise 被拒绝。
	let fail = true;
	vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => {
		const actual = (await importOriginal()) as {
			getPackageDir: () => string;
		};
		return {
			...actual,
			getPackageDir: () => {
				if (fail) throw new Error("injected exporter load failure");
				return actual.getPackageDir();
			},
		};
	});
	vi.resetModules();
	onTestFinished(() => {
		vi.doUnmock("@earendil-works/pi-coding-agent");
	});
	const { sessionExportRoutes } = await import("../../src/server/modules/session-export.js");
	const isolated = new Hono();
	isolated.route("/", sessionExportRoutes(db, dir));
	const url = `/projects/${pid}/sessions/decide-2026-01-01T00-00-00-000Z.jsonl/export?inline=1`;

	expect((await isolated.request(url)).status).toBe(500);
	// 加载失败不得被永久缓存：修复后（这里让 getPackageDir 恢复正常）导出必须成功。
	fail = false;
	const retry = await isolated.request(url);
	expect(retry.status).toBe(200);
	expect(await retry.text()).toContain("<title>Session Export</title>");
});
