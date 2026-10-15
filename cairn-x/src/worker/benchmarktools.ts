/**
 * Worker TSecBench 评测工具：benchmark_status / submit_flag / hint / reset。
 *
 * 只暴露「步骤级、可归因到本次执行」的评测动作。start/close 属于控制面的容器
 * 生命周期（绑定即启动、项目结束统一释放），不在这里暴露；reset 是共享靶机的
 * 破坏性动作，控制端会在仍有兄弟执行在途时拒绝（409）。
 *
 * 平台 token 不在 Worker 里 —— 所有调用经控制端执行协议代理
 * （/internal/executions/:id/benchmark/*），身份由短期执行令牌绑定。
 *
 * 与 graphtools 一致：服务端失败以错误文本返回而不是抛异常，让模型
 * 看到原因并自行调整（flag 重复提交、容器未就绪都是正常控制流）。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { ExecutionBenchmarkContext } from "../contracts/execution.js";
import type { WorkerClient } from "./client.js";
import { errorResult, makeTool, toolResult } from "../shared/toolkit.js";

interface WorkerBenchmarkToolOptions {
	client: WorkerClient;
}

/** 把进度/容器状态渲染成模型可读的紧凑文本。 */
function formatBenchmarkStatus(challenge: ExecutionBenchmarkContext): string {
	const addrs =
		challenge.container_addr.length > 0 ? challenge.container_addr.join(", ") : "(not available)";
	return [
		`challenge: ${challenge.unique_code} — ${challenge.title}`,
		`description: ${challenge.description ?? "(none)"}`,
		`difficulty: ${challenge.difficulty}  level: ${challenge.level}  total_score: ${challenge.total_score}`,
		`flags: ${challenge.correct_flag_count}/${challenge.flag_count}  completed: ${challenge.flag_count > 0 && challenge.correct_flag_count >= challenge.flag_count}`,
		`container_status: ${challenge.container_status}  addr: ${addrs}`,
		`hint_used: ${challenge.hint_used}`,
	].join("\n");
}

function duplicateHint(text: string): boolean {
	return text.includes("duplicate");
}

export function createWorkerBenchmarkTools(options: WorkerBenchmarkToolOptions): AgentTool[] {
	const client = options.client;

	async function readError(result: {
		statusCode: number;
		text: string;
	}): Promise<ReturnType<typeof toolResult>> {
		if (result.statusCode === 409 && duplicateHint(result.text)) {
			return toolResult(
				"this flag was already submitted for this challenge (duplicate ignored; no score change). " +
					"Run benchmark_status to see the current progress.",
				{ duplicate: true },
			);
		}
		return errorResult(result);
	}

	return [
		makeTool(
			"benchmark_status",
			"Benchmark Status",
			"Show this project's TSecBench challenge progress and target container status " +
				"(unique_code, flags captured, container address/state).",
			Type.Object({}, { additionalProperties: false }),
			async () => {
				const result = await client.benchmarkStatus();
				if (!result.ok || result.data === undefined) return errorResult(result);
				return toolResult(formatBenchmarkStatus(result.data), result.data);
			},
		),
		makeTool(
			"benchmark_submit_flag",
			"Submit Flag",
			"Submit a captured flag to the TSecBench platform. Call this as soon as you recover a flag. " +
				"A wrong flag returns correct=false (no penalty); a repeated correct flag is reported as duplicate.",
			Type.Object(
				{
					flag: Type.String({
						minLength: 1,
						maxLength: 4096,
						description: "The exact flag string captured from the target",
					}),
				},
				{ additionalProperties: false },
			),
			async (params) => {
				const result = await client.benchmarkSubmit(params.flag);
				if (!result.ok || result.data === undefined) {
					return readError(result);
				}
				const data = result.data;
				const text = data.correct
					? `ACCEPTED: awarded ${data.awarded}, cumulative ${data.cumulative_score}, ` +
						`progress ${data.correct_flag_count}/${data.total_flag_count}, matched_flag_index ${data.matched_flag_index}. ` +
						`Now call submit_fact to record the captured flag, then continue with the remaining flags.`
					: `REJECTED: this flag is not correct (awarded 0). progress stays ` +
						`${data.correct_flag_count}/${data.total_flag_count}. Verify the exact flag value/format and retry.`;
				return toolResult(text, data);
			},
		),
		makeTool(
			"benchmark_hint",
			"Benchmark Hint",
			"Fetch the platform hint for this challenge. WARNING: this permanently reduces the challenge's " +
				"score and is a one-shot project-level resource. Only call it when you are genuinely stuck; " +
				"never to confirm something you can verify from the target. You must state a concrete reason.",
			Type.Object(
				{
					reason: Type.String({
						minLength: 8,
						maxLength: 500,
						description:
							"What you already tried and why the target cannot be progressed without the hint. " +
							"Recorded for audit.",
					}),
				},
				{ additionalProperties: false },
			),
			async (params) => {
				const result = await client.benchmarkHint(params.reason);
				if (!result.ok || result.data === undefined) return errorResult(result);
				if (result.data.hint === null || result.data.hint === "") {
					return toolResult("no hint is configured for this challenge", { hint: null });
				}
				return toolResult(`hint (score is now reduced): ${result.data.hint}`, result.data);
			},
		),
		makeTool(
			"benchmark_reset",
			"Rebuild Target Container",
			"Rebuild this challenge's target container (close → start) and return its new address. " +
				"Use this ONLY when the target has been polluted or deadlocked and you need a clean instance. " +
				"All steps share one container, so the controller refuses a rebuild while another step is " +
				"still running (409); retry after it finishes. The address and all prior in-container state " +
				"will change.",
			Type.Object({}, { additionalProperties: false }),
			async () => {
				const result = await client.benchmarkReset();
				if (!result.ok || result.data === undefined) return errorResult(result);
				return toolResult(
					`container_status: ${result.data.container_status}  addr: ${
						result.data.container_addr.join(", ") || "(not available)"
					} (rebuilt; all prior in-container state is gone)`,
					result.data,
				);
			},
		),
	];
}
