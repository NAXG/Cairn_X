/**
 * 启动时的模型健康检查：通过真实的 pi-ai 路径 ping 每个已配置的模型
 * endpoint。健康场景用 faux provider，失败场景用一个无法访问的 base_url。
 */

import { fauxAssistantMessage, fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import {
	formatHealthcheckSummary,
	runModelHealthchecks,
} from "../../src/orchestrator/healthcheck.js";
import { silentLogger, testConfig } from "./helpers.js";

test("healthy endpoints pass", async () => {
	const faux = fauxProvider({ provider: "cairn-x-faux", api: "openai-completions" });
	faux.setResponses([fauxAssistantMessage("pong"), fauxAssistantMessage("pong")]);

	const config = testConfig("http://unused", {
		models: {
			decide: {
				model_id: "faux-decide",
				base_url: "http://unused",
				api_key: "test",
				api: "openai-completions",
			},
			execute: {
				model_id: "faux-execute",
				base_url: "http://unused",
				api_key: "test",
				api: "openai-completions",
			},
		},
	});
	const stream: import("../../src/orchestrator/healthcheck.js").HealthcheckStream = (
		model,
		context,
		options,
		// 0.86 起 provider 只接受归一化后的 TranscriptContext。
	) => faux.provider.streamSimple(model, normalizeContext(context), options);
	const results = await runModelHealthchecks(config, 5, silentLogger, {
		decide: stream,
		execute: stream,
	});
	expect(results).toHaveLength(2);
	expect(results.every((r) => r.ok)).toBe(true);
	expect(formatHealthcheckSummary(results)).toBe("all model endpoints healthy");
});

test("unreachable endpoints fail with a summary", async () => {
	const config = testConfig("http://unused", {
		models: {
			decide: {
				model_id: "m",
				base_url: "http://127.0.0.1:1",
				api_key: "test",
				api: "openai-completions",
			},
			execute: {
				model_id: "m",
				base_url: "http://127.0.0.1:1",
				api_key: "test",
				api: "openai-completions",
			},
		},
	});
	const results = await runModelHealthchecks(config, 3, silentLogger);
	expect(results.every((r) => !r.ok)).toBe(true);
	expect(formatHealthcheckSummary(results)).toContain("decide (m):");
});
