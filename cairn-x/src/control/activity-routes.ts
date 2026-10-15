import { randomBytes } from "node:crypto";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ConfigurationControl } from "./index.js";
import type { AuthConfig } from "../server/auth.js";
import { validApiToken } from "../server/auth.js";
import { ApiError } from "../server/core/base.js";
import { parseBody, parseValue } from "../server/http.js";
import { requireExecutionByToken, requireExecutionAlive } from "../server/core/executions.js";
import { hashToken } from "../server/core/tokens.js";
import { sanitizeActivityId } from "./store.js";
import { z } from "zod";
/** 上游模型流异常中断（连接/额度/授权等）。 */
const TRANSPORT_ERROR_EVENT = { type: "transport_error", message: "模型连接失败或活动已取消" };

/**
 * 执行被控制端回收导致的流终止（步骤被放弃 / 租约失效）。
 *
 * 必须与上游模型故障区分开：worker 侧的 session 会把它映射成"被中止"而不是
 * "出错"，否则一次自伤会被记成端点故障并冷却一个健康的端点。
 */
const REVOKED_EVENT = {
	type: "transport_error",
	reason: "revoked",
	message: "执行已被控制端回收（步骤被放弃或租约失效），模型流终止",
};

/** projects 表在活动鉴权里读取的两组列（decide 租约校验 / decide 领取校验）。 */
interface ProjectDecideLeaseRow {
	decide_worker: string | null;
	decide_expires_at: string | null;
	status: string;
}
interface ProjectDecideStatusRow {
	decide_worker: string | null;
	status: string;
}

export function activityRoutes(control: ConfigurationControl, auth?: AuthConfig) {
	const app = new Hono();
	const { store, models } = control;
	const machine = (c: Context) => {
		if (auth && !validApiToken(auth, c.req.header("authorization")))
			throw new ApiError(401, "Control token required");
	};
	function verify(c: Context) {
		const token = c.req.header("authorization")?.replace(/^Bearer /, "");
		if (!token) throw new ApiError(401, "Activity token required");
		const lease = store.get<{
			id: string;
			project_id: string;
			worker: string;
			created_at: string;
		}>("activity-token", hashToken(token));
		if (lease) {
			const p = store.db
				.prepare("SELECT decide_worker,decide_expires_at,status FROM projects WHERE id=?")
				.get(lease.project_id) as ProjectDecideLeaseRow | undefined;
			const active =
				p &&
				p.status === "active" &&
				p.decide_worker === lease.worker &&
				new Date(p.decide_expires_at ?? 0).getTime() > Date.now();
			if (!active) {
				// 运行尾声宽限：decide 通过 goal(action="achieve") 达成根目标后项目即完结、
				// 租约即释放，但本次运行的收尾 LLM 调用（总结文本）仍属于这一趟。
				// 在运行自身的时间预算内容许；被手动停止（stopped）不在宽限之列。
				const snap = store.readSnapshot(lease.id);
				const budgetMs =
					((snap?.profile.run_seconds ?? 300) + (snap?.profile.harvest_seconds ?? 60) + 180) * 1000;
				const ageMs = Date.now() - new Date(lease.created_at ?? 0).getTime();
				if (!p || p.status !== "completed" || !Number.isFinite(ageMs) || ageMs > budgetMs)
					throw new ApiError(409, "Planning lease is no longer active");
			}
			return lease.id;
		}
		const row = requireExecutionByToken(store.db, token);
		requireExecutionAlive(store.db, row);
		return row.id;
	}
	app.post("/internal/activities/decide", async (c) => {
		machine(c);
		const b = await parseBody(c, z.object({ project_id: z.string(), worker: z.string() }));
		const issued = store.db
			.transaction(() => {
				const p = store.db
					.prepare("SELECT decide_worker,status FROM projects WHERE id=?")
					.get(b.project_id) as ProjectDecideStatusRow | undefined;
				if (!p || p.status !== "active" || p.decide_worker !== b.worker)
					throw new ApiError(409, "Planning lease mismatch");
				const id = `decide-${sanitizeActivityId(b.worker)}`;
				const snapshot = store.snapshot(id, "decide", b.project_id);
				const token = randomBytes(32).toString("hex");
				// 旧令牌与新令牌的写入必须一同提交。
				store.db
					.prepare(
						"DELETE FROM configuration_objects WHERE kind='activity-token' AND json_extract(body,'$.project_id')=?",
					)
					.run(b.project_id);
				store.put("activity-token", hashToken(token), {
					id,
					project_id: b.project_id,
					worker: b.worker,
					created_at: new Date().toISOString(),
				});
				return { snapshot, token };
			})
			.immediate();
		return c.json(issued);
	});
	app.post("/internal/activities/report", async (c) => {
		const id = verify(c);
		const report = await parseBody(
			c,
			z.object({
				final_prompt: z.string().max(1000000),
				tools: z.array(z.string()).max(500),
				diagnostics: z.array(z.string()).max(100),
			}),
		);
		store.report(id, report);
		return c.json({ ok: true });
	});
	app.post("/internal/activities/model", async (c) => {
		const id = verify(c);
		const snapshot = store.readSnapshot(id);
		if (!snapshot) throw new ApiError(409, "Activity configuration missing");
		const raw = await c.req.text();
		if (raw.length > 16 * 1024 * 1024) throw new ApiError(413, "Model context too large");
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			throw new ApiError(400, "Request body must be valid JSON");
		}
		const body = parseValue(
			payload,
			z.object({
				context: z.object({
					systemPrompt: z.string().optional(),
					messages: z.array(z.any()),
					tools: z.array(z.any()).optional(),
				}),
				options: z
					.object({
						reasoning: z.string().optional(),
						maxTokens: z.number().int().positive().optional(),
						temperature: z.number().optional(),
						// 供应商缓存路由键（prompt_cache_key / x-session-affinity）。
						sessionId: z.string().min(1).max(64).optional(),
						cacheRetention: z.enum(["none", "short", "long"]).optional(),
					})
					.optional(),
			}),
		);
		const { runtime, model } = await models.model(snapshot.provider, snapshot.profile.model_id);
		const thinking = clampThinkingLevel(model, snapshot.profile.thinking as ModelThinkingLevel);
		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			// 执行被控制端回收（步骤被放弃 / 租约失效）是自伤，必须与本活动
			// 自己的取消区分开：否则 worker 会把它记成模型端点故障（unhealthy），
			// 进而冷却一个健康的端点。
			let revoked = false;
			stream.onAbort(() => abort.abort());
			const guard = setInterval(() => {
				try {
					verify(c);
				} catch {
					revoked = true;
					abort.abort();
				}
			}, 1000);
			const timeout = setTimeout(
				() => abort.abort(),
				(snapshot.profile.run_seconds + snapshot.profile.harvest_seconds + 120) * 1000,
			);
			try {
				const events = runtime.streamSimple(
					{
						...model,
						contextWindow: snapshot.profile.context_window,
						maxTokens: snapshot.profile.max_output_tokens,
					},
					body.context,
					{
						...body.options,
						reasoning: thinking === "off" ? undefined : thinking,
						maxTokens: Math.min(
							body.options?.maxTokens ?? snapshot.profile.max_output_tokens,
							snapshot.profile.max_output_tokens,
						),
						signal: abort.signal,
					},
				);
				for await (const event of events) {
					if (event.type === "error") {
						event.error.errorMessage = "模型调用失败：请检查连接、额度或授权状态";
					}
					await stream.writeSSE({ data: JSON.stringify(event) });
				}
				// 上游把 abort 当作"流正常结束"时不会抛错（取决于 provider 实现），
				// 所以回收原因必须在循环之后也补一次，不能只写在 catch 里。
				if (revoked) await stream.writeSSE({ data: JSON.stringify(REVOKED_EVENT) }).catch(() => {});
			} catch {
				await stream
					.writeSSE({ data: JSON.stringify(revoked ? REVOKED_EVENT : TRANSPORT_ERROR_EVENT) })
					.catch(() => {});
			} finally {
				clearInterval(guard);
				clearTimeout(timeout);
				abort.abort();
			}
		});
	});
	return app;
}
