/**
 * 启动时的模型 endpoint 健康检查：对每个配置好的模型 endpoint 发起一次
 * 最小化的 "ping" 补全请求（进程内直连上游，使用 dispatch.yaml 中的长期凭据）。
 */

import { tmpdir } from "node:os";
import path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type HealthcheckStream = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

import type { DispatchConfig } from "../scheduler/config.js";
import { MODEL_DEFAULTS } from "../contracts/configuration.js";
import { consoleLogger, type Logger } from "../shared/logger.js";
import { type ActivityType } from "../contracts/activity.js";

export interface ModelHealthcheckResult {
	activity: ActivityType;
	model: string;
	ok: boolean;
	detail: string;
}

export async function runModelHealthchecks(
	config: DispatchConfig,
	timeoutSeconds: number,
	logger: Logger = consoleLogger,
	/** 测试钩子：按 activity 注入脚本化的 streamSimple，替代真实 endpoint。 */
	streamOverrides?: Partial<Record<ActivityType, HealthcheckStream>>,
): Promise<ModelHealthcheckResult[]> {
	const results: ModelHealthcheckResult[] = [];
	for (const activity of ["decide", "execute"] as const) {
		const modelConfig = config.models[activity];
		let ok = false;
		let detail = "ok";
		try {
			const runtime = await ModelRuntime.create({
				// 凭据以内联 apiKey 注入，auth 文件永不读写。
				authPath: path.join(tmpdir(), "cairn-x-healthcheck-auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
			});
			// 解析一次供下面两处共用：同一份能力在这里写两遍，就又会分头漂移。
			const contextWindow = modelConfig.context_window ?? MODEL_DEFAULTS.context_window;
			runtime.registerProvider(`healthcheck-${activity}`, {
				name: `${activity} endpoint`,
				api: modelConfig.api,
				baseUrl: modelConfig.base_url,
				apiKey: modelConfig.api_key,
				streamSimple: streamOverrides?.[activity],
				models: [
					{
						id: modelConfig.model_id,
						name: modelConfig.model_id,
						reasoning: false,
						input: ["text"],
						contextWindow,
						// 上界取该模型自己的窗口而非固定常量：窗口更大的模型允许更大的输出上限。
						maxTokens: Math.min(
							modelConfig.max_output_tokens ?? MODEL_DEFAULTS.max_output_tokens,
							contextWindow,
						),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			});
			const model = runtime.getModel(`healthcheck-${activity}`, modelConfig.model_id);
			if (model === undefined) {
				throw new Error("registered model not resolvable");
			}
			const stream = runtime.streamSimple(
				model,
				{
					systemPrompt: "ping",
					messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
				},
				{ maxTokens: 10, timeoutMs: timeoutSeconds * 1000 },
			);
			const message = await stream.result();
			if (message.stopReason === "error") {
				// Provider error text may echo request headers or credentials.
				detail = "model request failed";
			} else {
				ok = true;
			}
		} catch {
			detail = "model healthcheck failed";
		}
		logger.info(
			`[${ok ? "+" : "-"}] ${activity} model=${modelConfig.model_id} ${ok ? "ok" : `FAILED: ${detail}`}`,
		);
		results.push({ activity, model: modelConfig.model_id, ok, detail });
	}
	return results;
}

export function formatHealthcheckSummary(results: ModelHealthcheckResult[]): string {
	const failed = results.filter((result) => !result.ok);
	if (failed.length === 0) {
		return "all model endpoints healthy";
	}
	return failed
		.map((result) => `${result.activity} (${result.model}): ${result.detail}`)
		.join("\n");
}
