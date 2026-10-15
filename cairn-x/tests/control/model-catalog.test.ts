import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";

import { MODEL_CATALOG_REFRESH_INTERVAL_MS, ModelService } from "../../src/control/models.js";
import { ConfigurationStore } from "../../src/control/store.js";
import type { ProviderConnection } from "../../src/contracts/configuration.js";
import { openDatabase } from "../../src/server/db.js";

const REMOTE_MODEL = "cairn-catalog-test-model";
const deepseek: ProviderConnection = {
	id: "deepseek",
	revision: 1,
	name: "DeepSeek",
	kind: "builtin",
	sdk_id: "deepseek",
	base_url: "",
	api: "",
	headers: {},
	models: [],
	credential_id: "catalog-test-credential",
};

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(root: string, catalogBaseUrl: string) {
	mkdirSync(path.join(root, "configuration", "credentials"), { recursive: true });
	const db = openDatabase(path.join(root, "cairn.db"));
	const store = new ConfigurationStore(db);
	store.put("provider", deepseek.id, deepseek);
	const models = new ModelService(store, path.join(root, "configuration", "credentials"), {
		catalogBaseUrl,
		refreshTimeoutMs: 2_000,
	});
	models.setKey(deepseek, "catalog-test-key");
	return {
		db,
		models,
	};
}

test("builtin catalog refresh persists new models and preserves them after a failed refresh", async () => {
	let available = true;
	const app = new Hono();
	app.get("/api/models/providers/deepseek", (c) => {
		if (!available) return c.text("unavailable", 503);
		return c.json(
			[
				{
					id: REMOTE_MODEL,
					name: "Cairn catalog test model",
					contextWindow: 128000,
					maxTokens: 8192,
					reasoning: false,
				},
			],
			200,
			{ "Last-Modified": "Thu, 01 Jan 2099 00:00:00 GMT" },
		);
	});
	let server!: ReturnType<typeof serve>;
	const port = await new Promise<number>((resolve, reject) => {
		server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
			resolve(info.port),
		);
		server.on("error", reject);
	});
	const root = mkdtempSync(path.join(tmpdir(), "cairn-model-catalog-"));
	roots.push(root);
	try {
		const first = service(root, `http://127.0.0.1:${port}`);
		const refreshed = await first.models.refreshCatalogs({
			providers: ["deepseek"],
			force: true,
			retryOnFailure: false,
		});
		expect(refreshed?.errors.size).toBe(0);
		expect((await first.models.catalogFor(deepseek)).models.map((m) => m.id)).toContain(
			REMOTE_MODEL,
		);
		// 活动 runtime 同样可解析后台发现的模型，而非仅设置页可见。
		expect((await first.models.model(deepseek, REMOTE_MODEL)).model.id).toBe(REMOTE_MODEL);
		first.db.close();

		// 重启后不接触网络，仍从持久 ModelsStore 还原远程目录。
		const restarted = service(root, `http://127.0.0.1:${port}`);
		expect((await restarted.models.catalogFor(deepseek)).models.map((m) => m.id)).toContain(
			REMOTE_MODEL,
		);

		available = false;
		const failed = await restarted.models.refreshCatalogs({
			providers: ["deepseek"],
			force: true,
			retryOnFailure: false,
		});
		expect(failed?.errors.has("deepseek")).toBe(true);
		expect((await restarted.models.catalogFor(deepseek)).models.map((m) => m.id)).toContain(
			REMOTE_MODEL,
		);
		restarted.db.close();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("catalog scheduler runs after startup delay and is idempotent", async () => {
	vi.useFakeTimers();
	const root = mkdtempSync(path.join(tmpdir(), "cairn-model-schedule-"));
	roots.push(root);
	const { db, models } = service(root, "http://127.0.0.1:1");
	const refresh = vi.spyOn(models, "refreshCatalogs").mockResolvedValue(undefined);
	// 测试专用的短延迟/周期；生产值仍为 15 秒 / 1 小时。
	const scheduled = new ModelService(models.store, models.root, {
		startDelayMs: 15,
		refreshIntervalMs: 30,
	});
	const scheduledRefresh = vi.spyOn(scheduled, "refreshCatalogs").mockResolvedValue(undefined);
	scheduled.startCatalogRefresh();
	scheduled.startCatalogRefresh();
	await vi.advanceTimersByTimeAsync(15);
	expect(scheduledRefresh).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(30);
	expect(scheduledRefresh).toHaveBeenCalledTimes(2);
	scheduled.stopCatalogRefresh();
	await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_INTERVAL_MS);
	expect(scheduledRefresh).toHaveBeenCalledTimes(2);
	models.stopCatalogRefresh();
	expect(refresh).not.toHaveBeenCalled();
	db.close();
});
