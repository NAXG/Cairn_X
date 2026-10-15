/**
 * TSecBench（腾讯安全云鼎实验室智能攻防 Agent 评测）OpenAPI 契约。
 *
 * 平台通过请求头 BENCHMARK_TOKEN 鉴权；所有业务异常返回统一信封：
 *   { "code": "...", "message": "...", "detail": {} }
 * 框架级参数校验返回 FastAPI 的标准 422 结构（detail 为字段错误数组），与业务
 * 异常格式不同。
 *
 * 这里只做类型与错误码建模，网络调用见 client.ts。
 */

export type ContainerStatus = "pending" | "available" | "stop_pending" | "stopped";

export interface Challenge {
	unique_code: string;
	description: string | null;
	difficulty: string;
	level: number;
	total_score: number;
	flag_count: number;
	correct_flag_count: number;
	is_completed: boolean;
	container_status: ContainerStatus;
	/** 仅当 container_status == "available" 时非空。 */
	container_addr: string[];
}

export interface StartChallengeResult {
	unique_code: string;
	container_addr: string[];
}

export interface HintResult {
	unique_code: string;
	hint: string | null;
}

export interface SubmitFlagResult {
	correct: boolean;
	awarded: number;
	cumulative_score: number;
	correct_flag_count: number;
	total_flag_count: number;
	matched_flag_index: number | null;
}

export interface CloseChallengeResult {
	unique_code: string;
	closed: boolean;
}

/** 业务/传输错误码。前 6 个是平台错误码，后 3 个由客户端归一化。 */
export type BenchmarkErrorCode =
	| "task_not_found"
	| "challenge_not_found"
	| "invalid_state"
	| "duplicate"
	| "resource_unavailable"
	| "internal_error"
	| "validation_error"
	| "network_error"
	| "unexpected_error";

export interface BenchmarkError {
	code: BenchmarkErrorCode;
	message: string;
	/** HTTP 状态码；传输失败为 0。 */
	status: number;
	detail?: unknown;
}

/**
 * 调用结果。业务异常（token 无效、重复提交、容器上限…）不抛异常 ——
 * 它们都是调用方需要分支处理的正常控制流。
 */
export type BenchmarkResult<T> = { ok: true; data: T } | { ok: false; error: BenchmarkError };

/** 平台固定错误码（未知 code 归一化为 unexpected_error）。 */
const BENCHMARK_ERROR_CODES: readonly BenchmarkErrorCode[] = [
	"task_not_found",
	"challenge_not_found",
	"invalid_state",
	"duplicate",
	"resource_unavailable",
	"internal_error",
];

/** 平台硬性并发上限：同一时间最多启动 3 道题目。 */
export const MAX_ACTIVE_CHALLENGES = 3;

/**
 * 平台对单个靶场容器的运行时上限（秒）：容器启动满 2 小时后被平台自动回收。
 * 这是评测时限，控制面据此判断"回收"是时限到达还是异常，不再复活超时容器。
 */
export const PLATFORM_CONTAINER_TIMEOUT_SECONDS = 7200;

export function isBenchmarkErrorCode(value: unknown): value is BenchmarkErrorCode {
	return typeof value === "string" && (BENCHMARK_ERROR_CODES as readonly string[]).includes(value);
}
