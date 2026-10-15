/**
 * TSecBench OpenAPI 客户端（控制端持有 BENCHMARK_TOKEN）。
 *
 * 设计约定：
 * - 所有方法返回 BenchmarkResult，不抛业务异常；仅当传入非法参数或遇到
 *   无法归类的编程错误时才可能抛出。
 * - token 只存在于控制端（serve 进程），Worker 容器通过执行协议代理调用，
 *   永远拿不到长期凭据。
 * - 网络失败归一化为 code=network_error，status=0，便于上层区分"平台拒绝"
 *   与"打不通平台"（后者通常是 VPN/网络问题）。
 */

import { requestJson } from "../shared/http.js";
import {
	isBenchmarkErrorCode,
	type BenchmarkError,
	type BenchmarkResult,
	type Challenge,
	type CloseChallengeResult,
	type HintResult,
	type StartChallengeResult,
	type SubmitFlagResult,
} from "./types.js";

/** 平台调用的最小接口：便于测试与替换实现。 */
export interface BenchmarkPlatformClient {
	listChallenges(): Promise<BenchmarkResult<Challenge[]>>;
	startChallenge(uniqueCode: string): Promise<BenchmarkResult<StartChallengeResult>>;
	getHint(uniqueCode: string): Promise<BenchmarkResult<HintResult>>;
	submitFlag(uniqueCode: string, flag: string): Promise<BenchmarkResult<SubmitFlagResult>>;
	closeChallenge(uniqueCode: string): Promise<BenchmarkResult<CloseChallengeResult>>;
}

export const DEFAULT_BENCHMARK_BASE_URL = "https://tsecbench.zc.tencent.com";
const DEFAULT_BENCHMARK_TIMEOUT_MS = 30_000;

interface BenchmarkClientOptions {
	baseUrl: string;
	token: string;
	timeoutMs?: number;
	/** 注入 fetch 便于测试；默认全局 fetch。 */
	fetchImpl?: typeof fetch;
}

export class TSecBenchClient implements BenchmarkPlatformClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(options: BenchmarkClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.token = options.token;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_BENCHMARK_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	listChallenges(): Promise<BenchmarkResult<Challenge[]>> {
		return this.request<Challenge[]>("GET", "/openapi/v1/challenges");
	}

	startChallenge(uniqueCode: string): Promise<BenchmarkResult<StartChallengeResult>> {
		return this.request<StartChallengeResult>(
			"POST",
			`/openapi/v1/challenges/start?${new URLSearchParams({ unique_code: uniqueCode })}`,
		);
	}

	getHint(uniqueCode: string): Promise<BenchmarkResult<HintResult>> {
		return this.request<HintResult>(
			"GET",
			`/openapi/v1/challenges/hint?${new URLSearchParams({ unique_code: uniqueCode })}`,
		);
	}

	submitFlag(uniqueCode: string, flag: string): Promise<BenchmarkResult<SubmitFlagResult>> {
		return this.request<SubmitFlagResult>("POST", "/openapi/v1/challenges/submit", {
			unique_code: uniqueCode,
			flag,
		});
	}

	closeChallenge(uniqueCode: string): Promise<BenchmarkResult<CloseChallengeResult>> {
		return this.request<CloseChallengeResult>(
			"POST",
			`/openapi/v1/challenges/close?${new URLSearchParams({ unique_code: uniqueCode })}`,
		);
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<BenchmarkResult<T>> {
		const result = await requestJson<T>({
			url: `${this.baseUrl}${path}`,
			method,
			headers: { BENCHMARK_TOKEN: this.token },
			body,
			timeoutMs: this.timeoutMs,
			fetchImpl: this.fetchImpl,
		});
		if (result.statusCode === 0) {
			return {
				ok: false,
				error: { code: "network_error", message: result.text, status: 0 },
			};
		}
		if (result.ok) {
			if (result.data !== undefined && result.data !== null) return { ok: true, data: result.data };
			return {
				ok: false,
				error: {
					code: "unexpected_error",
					message: "platform returned an empty or non-JSON success response",
					status: result.statusCode,
				},
			};
		}
		return { ok: false, error: normalizeError(result.statusCode, result.data, result.text) };
	}
}

export function normalizeError(status: number, parsed: unknown, rawText: string): BenchmarkError {
	if (parsed !== null && typeof parsed === "object") {
		const envelope = parsed as { code?: unknown; message?: unknown; detail?: unknown };
		if (isBenchmarkErrorCode(envelope.code)) {
			return {
				code: envelope.code,
				message: typeof envelope.message === "string" ? envelope.message : envelope.code,
				status,
				detail: envelope.detail,
			};
		}
	}
	if (status === 422 && parsed !== null && typeof parsed === "object" && "detail" in parsed) {
		return {
			code: "validation_error",
			message: "request failed framework validation",
			status,
			detail: (parsed as { detail: unknown }).detail,
		};
	}
	return {
		code: "unexpected_error",
		message: rawText.slice(0, 500) || `unexpected HTTP ${status}`,
		status,
	};
}
