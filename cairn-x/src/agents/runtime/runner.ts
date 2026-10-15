/**
 * Decide / Execute 共用的有界运行管线：预算耗尽时请求在回合边界停止，
 * 宽限期内未结束则 abort；外部 AbortSignal 立即中止。
 * Execute 的探索与收尾 pass 复用同一 session（见 worker/agent.ts）。
 */

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

import type { UsageRecord } from "./agent.js";
import { consoleLogger, type Logger } from "../../shared/logger.js";
import { type Outcome } from "../../contracts/activity.js";

/** ActivityAgent 的结构化视图，便于测试注入伪实现。 */
export interface AgentRun {
	agent: {
		prompt(message: AgentMessage): Promise<void>;
		steer(message: AgentMessage): void;
		abort(): void;
		subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
	};
	usage(): UsageRecord;
	/** 请求在下一个回合边界结束运行（到点强停）；不再依赖 steer 被模型采纳。 */
	requestStop(): void;
}

export interface RunOutcome {
	outcome: Outcome;
	finalText: string;
	/** 取消原因：外部 AbortSignal.reason，或宽限期耗尽时的超时文本。 */
	cancelledReason?: string;
	/** 取消是否由运行自身的软超时触发（区别于外部信号取消）。 */
	timedOut?: boolean;
	/**
	 * 运行是在预算耗尽后被**强停**的：循环在回合边界正常退出，既没有被模型
	 * 自然收尾，也没有被 abort 硬杀。调用方据此判断"这一轮的探索是被预算截断
	 * 的"，并接管收尾（execute 交给收割 pass）。
	 */
	budgetExhausted?: boolean;
}

interface RunAgentOptions {
	run: AgentRun;
	initialMessage: string;
	signal: AbortSignal;
	/** 请求回合边界停止前的运行预算。 */
	timeoutMs: number;
	graceMs: number;
	/**
	 * 预算内的中途提醒：到点后 steer 一条消息。用于在长探索里逼出增量提交
	 * （否则 agent 可能整段探索一次 submit_fact 都不发）。
	 */
	checkpoints?: Array<{ atMs: number; text: string }>;
	logger?: Logger;
}

/** 预算耗尽且超过宽限期后硬中止的原因。 */
const TIMEOUT_CANCEL_REASON = "time limit reached";

/** AbortSignal.reason 转成可读文本；未提供时回落到 undefined。 */
function signalReason(signal: AbortSignal): string | undefined {
	const reason: unknown = signal.reason;
	if (reason === undefined || reason === null) return undefined;
	if (reason instanceof Error) return reason.message;
	const text = String(reason);
	return text === "" ? undefined : text;
}

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("")
		.trim();
}

export async function runAgent(options: RunAgentOptions): Promise<RunOutcome> {
	const log = options.logger ?? consoleLogger;
	if (options.signal.aborted)
		return {
			outcome: "cancelled",
			finalText: "",
			cancelledReason: signalReason(options.signal),
		};
	let abortKind: "signal" | "timeout" | null = null;
	/** 外部 AbortSignal 的取消原因（onSignalAbort 时记录）。 */
	let signalAbortReason: string | undefined;
	let lastText = "";
	let lastStopReason: string | undefined;
	/** 到点强停的请求时刻；非空表示本轮跑到了预算上限。 */
	let stopRequestedAt: number | null = null;
	let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	let graceTimer: ReturnType<typeof setTimeout> | null = null;
	const checkpointTimers: Array<ReturnType<typeof setTimeout>> = [];

	const unsubscribe = options.run.agent.subscribe((event) => {
		if (event.type !== "message_end") {
			return;
		}
		if (event.message.role !== "assistant") {
			return;
		}
		lastStopReason = event.message.stopReason;
		const text = assistantText(event.message);
		if (text !== "") {
			lastText = text;
		}
	});

	const onSignalAbort = () => {
		if (abortKind === null) {
			abortKind = "signal";
			signalAbortReason = signalReason(options.signal);
			options.run.agent.abort();
		}
	};
	options.signal.addEventListener("abort", onSignalAbort, { once: true });

	for (const checkpoint of options.checkpoints ?? []) {
		checkpointTimers.push(
			setTimeout(() => {
				if (abortKind !== null || options.signal.aborted) return;
				log.info(`progress checkpoint: steering agent at ${checkpoint.atMs}ms`);
				options.run.agent.steer(userMessage(checkpoint.text));
			}, checkpoint.atMs),
		);
	}

	const settle = () => {
		unsubscribe();
		options.signal.removeEventListener("abort", onSignalAbort);
		if (timeoutTimer !== null) {
			clearTimeout(timeoutTimer);
		}
		if (graceTimer !== null) {
			clearTimeout(graceTimer);
		}
		for (const timer of checkpointTimers) {
			clearTimeout(timer);
		}
	};

	// 定时器必须先于 prompt 安装；同步完成的 prompt 也要能由 settle 全部清理。
	timeoutTimer = setTimeout(() => {
		if (abortKind !== null || options.signal.aborted) return;
		log.info("budget exhausted: stopping at the next turn boundary");
		stopRequestedAt = Date.now();
		options.run.requestStop();
		graceTimer = setTimeout(() => {
			if (abortKind === null) {
				abortKind = "timeout";
				options.run.agent.abort();
			}
		}, options.graceMs);
	}, options.timeoutMs);

	const result = (async (): Promise<RunOutcome> => {
		try {
			await options.run.agent.prompt(userMessage(options.initialMessage));
		} catch (err) {
			settle();
			// StreamFn 契约把 LLM 失败编码在事件流中，
			// 因此这里的 reject 是 endpoint 或循环层面的失败。
			log.warn(
				`agent run rejected kind=${abortKind ?? "none"} error=${err instanceof Error ? err.message : String(err)}`,
			);
			if (abortKind === "signal" || options.signal.aborted) {
				return { outcome: "cancelled", finalText: lastText, cancelledReason: signalAbortReason };
			}
			if (abortKind === "timeout") {
				// 软截止强杀会让 prompt() reject：这是"模型慢"，不是"端点不健康"。
				// 混成 unhealthy 会毒化端点健康度（健康但慢的模型被冷却），
				// 也会丢掉"本次是超时"这个诊断信息。
				return {
					outcome: "cancelled",
					finalText: lastText,
					cancelledReason: TIMEOUT_CANCEL_REASON,
					timedOut: true,
				};
			}
			return { outcome: "unhealthy", finalText: lastText };
		}
		settle();
		if (abortKind === "signal" || options.signal.aborted) {
			return { outcome: "cancelled", finalText: lastText, cancelledReason: signalAbortReason };
		}
		if (abortKind === "timeout") {
			return {
				outcome: "cancelled",
				finalText: lastText,
				cancelledReason: TIMEOUT_CANCEL_REASON,
				timedOut: true,
			};
		}
		if (lastStopReason === "error") {
			return { outcome: "unhealthy", finalText: lastText };
		}
		if (lastStopReason === "aborted") {
			// 原因未知的外部 abort：按失败处理。
			return { outcome: "failed", finalText: lastText };
		}
		return {
			outcome: "success",
			finalText: lastText,
			...(stopRequestedAt !== null ? { budgetExhausted: true } : {}),
		};
	})();

	return result;
}
