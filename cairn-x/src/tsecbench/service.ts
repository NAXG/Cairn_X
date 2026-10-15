/**
 * TSecBench 业务服务：控制端唯一持有平台 token，Worker 与 driver 都只经
 * 它读写（Worker 走执行协议，driver 走机器 token 的内部接口）。
 *
 * 这里把平台返回、绑定表、容器生命周期三者的关系收敛到一处：
 * - bind：登记项目 ↔ unique_code，并按 auto_start 启动靶场；
 * - submit/hint：代理平台调用并回写进度；
 * - refresh：用平台快照纠正本地容器状态（容器被平台回收后本地能感知）。
 */

import type { Db } from "../server/db.js";
import type { BenchmarkConfig } from "../scheduler/config.js";
import {
	applyChallengeState,
	applySubmitResult,
	createBenchmarkBinding,
	deleteBenchmarkBinding,
	getBenchmarkBinding,
	getBenchmarkBindingByCode,
	listBenchmarkBindings,
	markClosed,
	markContainerStarted,
	markHintUsed,
	type BenchmarkBinding,
} from "./store.js";
import type { BenchmarkPlatformClient } from "./client.js";
import { challengeProjectTitle } from "./driver.js";
import type { BenchmarkError, Challenge, SubmitFlagResult } from "./types.js";

type BenchmarkServiceErrorCode =
	BenchmarkError["code"] | "not_bound" | "already_bound" | "already_completed";

interface BenchmarkServiceError {
	code: BenchmarkServiceErrorCode;
	message: string;
}

export type BenchmarkServiceResult<T> =
	{ ok: true; data: T } | { ok: false; error: BenchmarkServiceError };

interface BindInput {
	projectId: string;
	uniqueCode: string;
	title?: string;
	description?: string | null;
	/** 是否立即启动靶场容器（默认取 config.auto_start）。 */
	start?: boolean;
}

export interface BenchmarkService {
	listPlatformChallenges(): Promise<BenchmarkServiceResult<Challenge[]>>;
	listTasks(): BenchmarkBinding[];
	/** Worker/driver 读取题目进度（默认尝试刷新平台快照）。 */
	status(
		projectId: string,
		options?: { refresh?: boolean },
	): Promise<BenchmarkServiceResult<BenchmarkBinding>>;
	bind(input: BindInput): Promise<BenchmarkServiceResult<BenchmarkBinding>>;
	start(projectId: string): Promise<BenchmarkServiceResult<BenchmarkBinding>>;
	close(projectId: string): Promise<BenchmarkServiceResult<BenchmarkBinding>>;
	submit(projectId: string, flag: string): Promise<BenchmarkServiceResult<SubmitFlagResult>>;
	hint(projectId: string): Promise<BenchmarkServiceResult<string | null>>;
	/**
	 * 真正重建靶场容器（close → start）。平台的 start 对 available 容器是
	 * no-op，只有重建才能拿到干净实例 —— 目标被打脏/打死时的唯一恢复原语。
	 */
	rebuild(projectId: string): Promise<BenchmarkServiceResult<BenchmarkBinding>>;
	reset(projectId: string): BenchmarkServiceResult<{ deleted: boolean }>;
}

type BenchmarkServiceFailure = { ok: false; error: BenchmarkServiceError };

function failure(code: BenchmarkServiceErrorCode, message: string): BenchmarkServiceFailure {
	return { ok: false, error: { code, message } };
}

function fromPlatform(error: BenchmarkError): BenchmarkServiceFailure {
	return failure(error.code, error.message);
}

const notBound = () => failure("not_bound", "project is not bound to a challenge");
const alreadyCompleted = () => failure("already_completed", "challenge already completed");

function bindingResult(
	binding: BenchmarkBinding | undefined,
): BenchmarkServiceResult<BenchmarkBinding> {
	return binding === undefined ? notBound() : { ok: true, data: binding };
}

export function createBenchmarkService(options: {
	client: BenchmarkPlatformClient;
	config: BenchmarkConfig;
	db: Db;
}): BenchmarkService {
	const { client, config, db } = options;
	// 平台的 flag 计数不是并发安全的：同一题两个 flag 同时提交时，两个请求
	// 可能都被判定 correct，却只累计一次进度。Worker 分属不同进程，锁必须放在
	// 共同经过的控制端。按 project_id 排队既保护同一题，又不阻塞其它题提交。
	const submitQueues = new Map<string, Promise<void>>();

	async function withSubmitLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
		const previous = submitQueues.get(projectId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(
			() => gate,
			() => gate,
		);
		submitQueues.set(projectId, tail);
		await previous.catch(() => undefined);
		try {
			return await action();
		} finally {
			release();
			if (submitQueues.get(projectId) === tail) submitQueues.delete(projectId);
		}
	}

	async function refreshFromList(projectId: string): Promise<BenchmarkBinding | undefined> {
		const binding = getBenchmarkBinding(db, projectId);
		if (binding === undefined) return undefined;
		const listed = await client.listChallenges();
		if (!listed.ok) return binding;
		const challenge = listed.data.find((item) => item.unique_code === binding.unique_code);
		if (challenge === undefined) return binding;
		return applyChallengeState(db, projectId, challenge);
	}

	/**
	 * 关闭靶场并回写本地状态；平台已找不到该题视为已关闭。close 与 rebuild 的
	 * 共同前置：rebuild 需要拿到关闭前的绑定才能重启同一个实例。
	 */
	async function closeBinding(
		projectId: string,
	): Promise<{ binding: BenchmarkBinding } | { failure: BenchmarkServiceFailure }> {
		const binding = getBenchmarkBinding(db, projectId);
		if (binding === undefined) return { failure: notBound() };
		const closed = await client.closeChallenge(binding.unique_code);
		if (!closed.ok && closed.error.code !== "challenge_not_found") {
			return { failure: fromPlatform(closed.error) };
		}
		markClosed(db, projectId);
		return { binding };
	}

	return {
		listPlatformChallenges: () => client.listChallenges(),

		listTasks: () => listBenchmarkBindings(db),

		async status(projectId, options = {}) {
			const binding = getBenchmarkBinding(db, projectId);
			if (binding === undefined) return notBound();
			if (options.refresh === false) return { ok: true, data: binding };
			const refreshed = await refreshFromList(projectId);
			return { ok: true, data: refreshed ?? binding };
		},

		async bind(input) {
			const existing = getBenchmarkBinding(db, input.projectId);
			if (existing !== undefined) {
				return { ok: false, error: { code: "already_bound", message: "project already bound" } };
			}
			if (getBenchmarkBindingByCode(db, input.uniqueCode) !== undefined) {
				return {
					ok: false,
					error: { code: "already_bound", message: "challenge already bound to another project" },
				};
			}
			const listed = await client.listChallenges();
			if (!listed.ok) return fromPlatform(listed.error);
			const challenge = listed.data.find((item) => item.unique_code === input.uniqueCode);
			if (challenge === undefined) {
				return {
					ok: false,
					error: { code: "challenge_not_found", message: `unknown challenge ${input.uniqueCode}` },
				};
			}
			const conflict = db
				.transaction(() => {
					if (getBenchmarkBinding(db, input.projectId) !== undefined)
						return "project already bound";
					if (getBenchmarkBindingByCode(db, input.uniqueCode) !== undefined)
						return "challenge already bound to another project";
					createBenchmarkBinding(db, {
						projectId: input.projectId,
						uniqueCode: input.uniqueCode,
						title: input.title ?? challengeProjectTitle(challenge),
						description: input.description ?? challenge.description,
						difficulty: challenge.difficulty,
						level: challenge.level,
						totalScore: challenge.total_score,
						flagCount: challenge.flag_count,
						containerAddr: challenge.container_addr,
						containerStatus: challenge.container_status,
					});
					return null;
				})
				.immediate();
			if (conflict !== null)
				return { ok: false, error: { code: "already_bound", message: conflict } };
			const created = getBenchmarkBinding(db, input.projectId)!;
			const shouldStart = input.start ?? config.auto_start;
			if (shouldStart && challenge.container_status !== "available") {
				const started = await this.start(input.projectId);
				if (!started.ok) {
					// bind 没有成功：释放占位，让 driver 下一轮可以重试该题。
					deleteBenchmarkBinding(db, input.projectId, {
						uniqueCode: created.unique_code,
						createdAt: created.created_at,
					});
					return started;
				}
			}
			return { ok: true, data: getBenchmarkBinding(db, input.projectId)! };
		},

		async start(projectId) {
			const binding = getBenchmarkBinding(db, projectId);
			if (binding === undefined) return notBound();
			const started = await client.startChallenge(binding.unique_code);
			if (!started.ok) {
				// 平台把"已达并发上限/实例未就绪"作为业务异常返回，原样上浮。
				return fromPlatform(started.error);
			}
			// 启动后立刻拉一次列表，拿到权威的 container_status。
			const refreshed = await refreshFromList(projectId);
			return bindingResult(refreshed ?? getBenchmarkBinding(db, projectId));
		},

		async close(projectId) {
			const closed = await closeBinding(projectId);
			if ("failure" in closed) return closed.failure;
			return bindingResult(getBenchmarkBinding(db, projectId));
		},

		async submit(projectId, flag) {
			return withSubmitLock(projectId, async () => {
				// 必须在取得锁后读取绑定：前一个提交可能刚刚推进进度或完成题目。
				const binding = getBenchmarkBinding(db, projectId);
				if (binding === undefined) return notBound();
				if (binding.is_completed) return alreadyCompleted();
				const submitted = await client.submitFlag(binding.unique_code, flag);
				if (!submitted.ok) {
					// duplicate（同 flag 重复提交）错误里也带有当前进度，尽量回写。
					if (submitted.error.code === "duplicate") {
						await refreshFromList(projectId);
					}
					return fromPlatform(submitted.error);
				}
				const updated = applySubmitResult(db, projectId, submitted.data);
				if (updated?.is_completed) {
					await refreshFromList(projectId);
				}
				return { ok: true, data: submitted.data } as const;
			});
		},

		async rebuild(projectId) {
			const closed = await closeBinding(projectId);
			if ("failure" in closed) return closed.failure;
			const started = await client.startChallenge(closed.binding.unique_code);
			if (!started.ok) return fromPlatform(started.error);
			markContainerStarted(db, projectId, started.data.container_addr);
			const refreshed = await refreshFromList(projectId);
			return bindingResult(refreshed ?? getBenchmarkBinding(db, projectId));
		},

		reset(projectId) {
			return { ok: true, data: { deleted: deleteBenchmarkBinding(db, projectId) } };
		},

		async hint(projectId) {
			const binding = getBenchmarkBinding(db, projectId);
			if (binding === undefined) return notBound();
			if (binding.is_completed) return alreadyCompleted();
			const result = await client.getHint(binding.unique_code);
			if (!result.ok) return fromPlatform(result.error);
			if (result.data.hint !== null && result.data.hint !== "") {
				markHintUsed(db, projectId);
			}
			return { ok: true, data: result.data.hint };
		},
	};
}
