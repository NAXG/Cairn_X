import { randomUUID, createHash } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ModelService } from "./models.js";
import { ConfigurationStore } from "./store.js";
import {
	agentBudgetSchema,
	agentSchema,
	providerSchema,
	roleSchema,
	runtimeSchema,
} from "./schemas.js";
import {
	MODEL_DEFAULTS,
	type ProviderConnection,
	type RuntimeSettings,
} from "../contracts/configuration.js";
import { ApiError } from "../server/core/base.js";
import { parseBody, parseValue } from "../server/http.js";
import { loadPrompt } from "../agents/prompts/index.js";

export function configurationRoutes(store: ConfigurationStore, models: ModelService) {
	const app = new Hono();
	app.get("/settings/agents", (c) =>
		c.json((["decide", "execute"] as const).map((role) => store.profile(role))),
	);
	app.get("/settings/agents/:role", (c) =>
		c.json(store.profile(parseValue(c.req.param("role"), roleSchema))),
	);
	app.patch("/settings/agents/:role/budget", async (c) => {
		const role = parseValue(c.req.param("role"), roleSchema);
		const budget = await parseBody(c, agentBudgetSchema);
		return c.json(store.saveBudget(role, budget));
	});
	app.put("/settings/agents/:role", async (c) => {
		const p = await parseBody(c, agentSchema);
		if (p.role !== c.req.param("role")) throw new ApiError(400, "角色不一致");
		// provider_id/model_id 同为空 = 未配置模型：跳过供应商/模型校验直接保存，
		// 让 Agent 能先保存提示词等改动，也能从某个供应商上解绑。
		if (p.provider_id !== "") {
			const provider = models.connection(p.provider_id);
			// 手动输入的目录外模型：先以「拟写入」的供应商目录视图完成全部校验
			// （模型可解析、思考等级受支持、profile 自身合法），任何一项不通过都
			// 不落盘；全部通过后才登记目录并保存 Profile，400 不再留下副作用。
			const registerModel =
				provider.kind === "custom" && !provider.models.some((m) => m.id === p.model_id);
			const prospective: ProviderConnection = registerModel
				? {
						...provider,
						revision: provider.revision + 1,
						models: [
							...provider.models,
							{
								id: p.model_id,
								name: p.model_id,
								contextWindow: p.context_window,
								maxTokens: p.max_output_tokens,
								reasoning: p.thinking !== "off",
							},
						],
					}
				: provider;
			const { model } = await models.model(prospective, p.model_id);
			if (!getSupportedThinkingLevels(model).includes(p.thinking)) {
				throw new ApiError(400, "此模型不支持所选思考等级，请在模型设置中调整或重新选择等级");
			}
			// 内置（订阅）供应商仍要求目录内模型。
			store.validateProfile(p, prospective);
			if (registerModel) {
				store.put("provider", provider.id, prospective);
			}
		}
		return c.json(store.saveProfile(p));
	});
	app.get("/settings/agents/:role/default-prompt", (c) =>
		c.json({ prompt: loadPrompt(parseValue(c.req.param("role"), roleSchema)) }),
	);
	app.get("/settings/providers", async (c) =>
		c.json(
			await Promise.all(
				store.list<ProviderConnection>("provider").map(async (p) => ({
					...(await models.catalogFor(p)),
					...models.status(p),
				})),
			),
		),
	);
	app.get("/settings/provider-catalog", async (c) => c.json(await models.catalog()));
	app.put("/settings/providers/:id", async (c) => {
		const b = await parseBody(c, providerSchema);
		const id = c.req.param("id");
		if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new ApiError(400, "Invalid provider id");
		const old = store.get<ProviderConnection>("provider", id);
		if ((old?.revision ?? 0) !== b.revision) throw new ApiError(409, "配置已被修改，请重新加载");
		if (b.kind === "custom") {
			let url;
			try {
				url = new URL(b.base_url);
			} catch {
				throw new ApiError(400, "端点 URL 无效");
			}
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new ApiError(400, "端点必须是无内嵌凭据的 HTTP URL");
			if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(b.api))
				throw new ApiError(400, "不支持的 API 协议");
		} else if (!(await models.catalog()).some((p) => p.id === b.sdk_id))
			throw new ApiError(400, "未知 SDK 供应商");
		if (
			Object.keys(b.headers).some((k) =>
				/authorization|apikey|authtoken|cookie|host|contentlength|token|secret|password|credential|session/.test(
					k.toLowerCase().replace(/[^a-z0-9]/g, ""),
				),
			)
		)
			throw new ApiError(400, "认证信息请使用凭据字段");
		const { api_key, clear_key, ...values } = b;
		const next: ProviderConnection = {
			...values,
			id,
			sdk_id: b.kind === "custom" ? id : b.sdk_id,
			revision: b.revision + 1,
			credential_id:
				!old || api_key || clear_key || old.sdk_id !== b.sdk_id ? randomUUID() : old.credential_id,
		};
		if (api_key) models.setKey(next, api_key);
		try {
			store.db
				.transaction(() => {
					const current = store.get<ProviderConnection>("provider", id);
					if ((current?.revision ?? 0) !== b.revision)
						throw new ApiError(409, "配置已被修改，请重新加载");
					store.put("provider", id, next);
				})
				.immediate();
		} catch (err) {
			if (api_key) models.removeKey(next.credential_id);
			throw err;
		}
		// 轮换 / clear_key / 换 SDK 都会换发新 credential_id：旧凭据文件
		// （明文 key）必须 best-effort 删除，否则会在磁盘上永久累积。
		if (old && old.credential_id !== next.credential_id) {
			models.removeKey(old.credential_id);
		}
		// 凭据/登录态改变后，后台强制复核该内置供应商的目录；不等待网络，保存配置
		// 始终只依赖已缓存目录。自定义端点仍由用户显式点击“发现并导入模型”。
		if (next.kind === "builtin")
			void models.refreshCatalogs({ providers: [next.sdk_id], force: true });
		let catalog = next;
		try {
			catalog = await models.catalogFor(next);
		} catch {
			// The settings write already committed; a catalog read must not make it look failed.
		}
		return c.json({ ...catalog, ...models.status(next) });
	});
	app.delete("/settings/providers/:id", (c) => {
		const id = c.req.param("id");
		const holders = (["decide", "execute"] as const).filter(
			(role) => store.profile(role).provider_id === id,
		);
		if (holders.length > 0) {
			const names = holders
				.map((role) => (role === "decide" ? "Dispatcher" : "Execute"))
				.join("、");
			throw new ApiError(
				409,
				`供应商仍被 Agent 使用（${names}）：请先在「子代理」里解绑或改绑后重试`,
			);
		}
		const connection = store.get<ProviderConnection>("provider", id);
		store.remove("provider", id);
		if (connection) models.removeKey(connection.credential_id);
		return c.json({ ok: true });
	});
	app.post("/settings/providers/:id/test", async (c) => {
		const b = await parseBody(c, z.object({ model_id: z.string().min(1) }));
		const p = models.connection(c.req.param("id"));
		const { runtime, model } = await models.model(p, b.model_id);
		const start = Date.now();
		try {
			const message = await runtime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
				{ maxTokens: 32, signal: AbortSignal.timeout(20000) },
			);
			if (message.stopReason === "error") throw Error();
			return c.json({ ok: true, model: model.id, elapsed_ms: Date.now() - start });
		} catch {
			throw new ApiError(502, "模型测试失败，请检查账号、模型权限和端点");
		}
	});
	app.post("/settings/providers/:id/discover", async (c) => {
		const p = models.connection(c.req.param("id"));
		if (p.kind === "builtin") {
			// 内置目录由后台持续维护；此按钮只把已缓存的最新目录导入草稿，绝不让
			// 用户请求等待网络。真正的目录抓取由 ModelService 的后台任务完成。
			return c.json((await models.catalogFor(p)).models);
		}
		try {
			const r = await models.runtime(p);
			const auth = await r.getAuth(p.sdk_id);
			const response = await fetch(p.base_url.replace(/\/$/, "") + "/models", {
				headers: { ...p.headers, Authorization: `Bearer ${auth?.auth?.apiKey ?? ""}` },
				signal: AbortSignal.timeout(15000),
			});
			if (!response.ok) throw Error();
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== "object" ||
				!Array.isArray((result as { data?: unknown }).data)
			)
				throw new Error("invalid model catalog");
			const entries = (result as { data: unknown[] }).data;
			return c.json(
				entries.slice(0, 500).map((entry) => {
					if (
						!entry ||
						typeof entry !== "object" ||
						typeof (entry as { id?: unknown }).id !== "string"
					)
						throw new Error("invalid model entry");
					const id = (entry as { id: string }).id;
					return {
						id,
						name: id,
						contextWindow: MODEL_DEFAULTS.context_window,
						maxTokens: MODEL_DEFAULTS.max_output_tokens,
						reasoning: false,
					};
				}),
			);
		} catch {
			throw new ApiError(502, "端点未提供模型目录，请手动添加");
		}
	});
	const owner = (c: Context, issue = false) => {
		let token = getCookie(c, "cairn-oauth-owner");
		if (!token && issue) {
			token = randomUUID();
			setCookie(c, "cairn-oauth-owner", token, {
				httpOnly: true,
				sameSite: "Lax",
				secure: new URL(c.req.url).protocol === "https:",
				path: "/",
				maxAge: 3600,
			});
		}
		if (!token) throw new ApiError(404, "登录任务不存在或已过期");
		return createHash("sha256").update(token).digest("hex");
	};
	app.post("/settings/providers/:id/login", (c) => {
		const a = models.startLogin(c.req.param("id"), owner(c, true));
		return c.json({ id: a.id }, 202);
	});
	function attempt(c: Context) {
		const id = c.req.param("id");
		const a = id === undefined ? undefined : models.logins.get(id);
		if (!a || a.owner !== owner(c)) throw new ApiError(404, "登录任务不存在或已过期");
		return a;
	}
	app.get("/settings/login-attempts/:id/events", (c) => {
		const a = attempt(c);
		return streamSSE(c, async (stream) => {
			let index = 0;
			while (!stream.aborted) {
				while (index < a.events.length)
					await stream.writeSSE({ data: JSON.stringify(a.events[index++]) });
				if (a.state !== "pending") break;
				await stream.sleep(250);
			}
		});
	});
	app.post("/settings/login-attempts/:id/input", async (c) => {
		const a = attempt(c);
		const b = await parseBody(
			c,
			z.object({ token: z.string(), value: z.string().min(1).max(10000) }),
		);
		if (a.state !== "pending" || a.input?.token !== b.token)
			throw new ApiError(409, "授权输入已失效");
		const input = a.input;
		a.input = undefined;
		input.resolve(b.value);
		return c.json({ ok: true });
	});
	app.delete("/settings/login-attempts/:id", (c) => {
		attempt(c).controller.abort();
		return c.json({ ok: true });
	});
	app.post("/settings/providers/:id/logout", async (c) => {
		await models.logout(c.req.param("id"));
		return c.json({ ok: true });
	});
	app.get("/settings/runtime", (c) => c.json(store.get("runtime", "global")));
	app.put("/settings/runtime", async (c) => {
		const b = await parseBody(c, runtimeSchema);
		const old = store.get<RuntimeSettings>("runtime", "global");
		if (!old) throw new ApiError(404, "运行配置不存在");
		if (old.revision !== b.revision) throw new ApiError(409, "配置已被修改，请重新加载");
		if (b.max_project_workers > b.max_workers) throw new ApiError(400, "项目并发不能超过总并发");
		const next = { ...b, revision: b.revision + 1 };
		store.put("runtime", "global", next);
		return c.json(next);
	});
	app.get("/projects/:pid/activities/:id/configuration", (c) => {
		const s = store.readSnapshot(c.req.param("id"));
		if (!s || s.project_id !== c.req.param("pid")) throw new ApiError(404, "未记录活动配置");
		return c.json(s);
	});
	return app;
}
