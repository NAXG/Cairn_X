import {
	mkdirSync,
	existsSync,
	writeFileSync,
	readFileSync,
	chmodSync,
	rmSync,
	renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { consoleLogger } from "../shared/logger.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, AuthEvent } from "@earendil-works/pi-ai";
import type { ProviderConnection } from "../contracts/configuration.js";
import { ConfigurationStore } from "./store.js";
import { ApiError } from "../server/core/base.js";

interface LoginAttempt {
	id: string;
	provider_id: string;
	owner: string;
	state: string;
	events: unknown[];
	controller: AbortController;
	input?: { token: string; resolve: (v: string) => void };
}
/** ModelRuntime 缓存上限（按连接修订版本淘汰）。 */
const MAX_MODEL_RUNTIMES = 64;

/**
 * 与 PI WEB 对齐的目录刷新节奏：启动后稍等，随后后台检查。
 *
 * Pi SDK 自己会为远程目录保留四小时的新鲜期和 ETag；这里的一小时 tick
 * 不会把每个 tick 都变成网络请求，只确保过期目录不会长期无人触发刷新。
 */
const MODEL_CATALOG_START_DELAY_MS = 15_000;
export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 60 * 60_000;
const MODEL_CATALOG_RETRY_DELAY_MS = 5 * 60_000;
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 60_000;

interface CatalogRefreshOptions {
	/** 只刷新指定内置供应商；省略时刷新所有内置目录。 */
	providers?: string[];
	/** 忽略 SDK 的目录新鲜期（登录、登出及凭据变更后使用）。 */
	force?: boolean;
	/** 内部重试不再安排下一次短期重试，交给正常小时 tick。 */
	retryOnFailure?: boolean;
}

interface ModelServiceOptions {
	/** 测试注入或私有 Pi 目录镜像；生产环境使用 SDK 默认的 pi.dev。 */
	catalogBaseUrl?: string;
	startDelayMs?: number;
	refreshIntervalMs?: number;
	refreshTimeoutMs?: number;
}

export class ModelService {
	private runtimes = new Map<string, Promise<ModelRuntime>>();
	private catalogRuntimePromise?: Promise<ModelRuntime>;
	private catalogStartTimer?: NodeJS.Timeout;
	private catalogRefreshTimer?: NodeJS.Timeout;
	private catalogRetryTimer?: NodeJS.Timeout;
	private readonly catalogDir: string;
	readonly logins = new Map<string, LoginAttempt>();
	constructor(
		readonly store: ConfigurationStore,
		readonly root: string,
		private readonly options: ModelServiceOptions = {},
	) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		chmodSync(root, 0o700);
		// 模型目录与凭据分开保存。此目录只含 Pi 的公开模型目录缓存，不含用户 key。
		this.catalogDir = path.join(root, "..", "model-catalog");
		mkdirSync(this.catalogDir, { recursive: true, mode: 0o700 });
		chmodSync(this.catalogDir, 0o700);
	}
	private catalogModelsPath() {
		return path.join(this.catalogDir, "models.json");
	}
	private catalogRuntime() {
		if (!this.catalogRuntimePromise) {
			this.catalogRuntimePromise = ModelRuntime.create({
				authPath: path.join(this.catalogDir, "auth.json"),
				// 不传 null：SDK 因而使用文件 ModelsStore，远程目录可跨重启恢复。
				modelsPath: this.catalogModelsPath(),
				catalogBaseUrl: this.options.catalogBaseUrl,
				allowModelNetwork: false,
			});
			this.catalogRuntimePromise.catch(() => {
				this.catalogRuntimePromise = undefined;
			});
		}
		return this.catalogRuntimePromise;
	}
	/**
	 * Pi 的远程目录刷新会先确认供应商已配置认证。目录请求本身不携带用户 key，
	 * 但需要这一份“已配置”信号；把已有 API key 放进 catalog runtime 的内存覆盖
	 * 即可，既支持刷新，也不把 key 复制进 model-catalog/。
	 */
	private apiKeyFor(p: ProviderConnection): string | undefined {
		try {
			const value = JSON.parse(readFileSync(this.credentialPath(p.credential_id), "utf8"))[
				p.sdk_id
			];
			return value?.type === "api_key" && typeof value.key === "string" ? value.key : undefined;
		} catch {
			return undefined;
		}
	}
	private async configureCatalogRuntimeAuth(runtime: ModelRuntime, providerIds?: string[]) {
		const selected = providerIds === undefined ? undefined : new Set(providerIds);
		for (const p of this.store.list<ProviderConnection>("provider")) {
			if (p.kind !== "builtin" || (selected && !selected.has(p.sdk_id))) continue;
			const key = this.apiKeyFor(p);
			if (key) await runtime.setRuntimeApiKey(p.sdk_id, key);
		}
	}
	credentialPath(id: string) {
		if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new ApiError(400, "Invalid credential id");
		return path.join(this.root, id + ".json");
	}
	setKey(connection: ProviderConnection, key: string) {
		const file = this.credentialPath(connection.credential_id);
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify({ [connection.sdk_id]: { type: "api_key", key } }), {
				mode: 0o600,
				flag: "wx",
			});
			chmodSync(temporary, 0o600);
			renameSync(temporary, file);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	/**
	 * best-effort 删除凭据文件。轮换 / clear_key / OAuth 重新登录都会换发
	 * 新 credential_id，旧文件必须随之删除：否则明文 key 会作为孤儿文件
	 * 在磁盘上永久累积。删除失败不阻断配置保存（文件已不再被引用）。
	 */
	removeKey(credentialId: string) {
		try {
			rmSync(this.credentialPath(credentialId), { force: true });
		} catch {
			// 忽略：旧文件不再被任何连接引用，下一次轮换会再尝试清理。
		}
	}
	status(p: ProviderConnection) {
		const file = this.credentialPath(p.credential_id);
		if (!existsSync(file)) return { configured: false, oauth: false };
		try {
			const value = JSON.parse(readFileSync(file, "utf8"))[p.sdk_id];
			return { configured: !!value, oauth: value?.type === "oauth" };
		} catch {
			return { configured: false, oauth: false };
		}
	}
	runtime(p: ProviderConnection) {
		const key = `${p.id}:${p.revision}:${p.credential_id}`;
		let promise = this.runtimes.get(key);
		if (!promise) {
			promise = (async () => {
				const r = await ModelRuntime.create({
					authPath: this.credentialPath(p.credential_id),
					// 与后台目录共享同一持久 ModelsStore。创建时只恢复缓存，不发网络请求，
					// 因此运行任务不会因供应商目录慢或不可达而被阻塞。
					modelsPath: this.catalogModelsPath(),
					catalogBaseUrl: this.options.catalogBaseUrl,
					refreshOnCreate: false,
					allowModelNetwork: false,
				});
				// refreshOnCreate:false 避免无谓的全量可用性检查；但仍需恢复已落盘的
				// 远程目录 overlay，才能让后台刚发现的模型立即可被活动运行时解析。
				await r.refresh({ allowNetwork: false });
				if (p.kind === "custom")
					r.registerProvider(p.sdk_id, {
						name: p.name,
						api: p.api,
						baseUrl: p.base_url,
						headers: p.headers,
						models: p.models.map((m) => ({
							...m,
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						})),
					});
				return r;
			})();
			this.runtimes.set(key, promise);
			promise.catch(() => this.runtimes.delete(key));
			// 容量上限：key 含 revision/credential_id，频繁改配置会累积失效条目；FIFO 淘汰最旧。
			while (this.runtimes.size > MAX_MODEL_RUNTIMES) {
				this.runtimes.delete(this.runtimes.keys().next().value!);
			}
		}
		return promise;
	}
	/**
	 * 后台刷新内置模型目录。Pi SDK 负责 ETag、四小时 TTL、合并和失败保留旧值；
	 * Cairn 只负责编排时机、超时与把新缓存同步给已创建的活动运行时。
	 */
	async refreshCatalogs(options: CatalogRefreshOptions = {}) {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.options.refreshTimeoutMs ?? MODEL_CATALOG_REFRESH_TIMEOUT_MS,
		);
		try {
			const runtime = await this.catalogRuntime();
			await this.configureCatalogRuntimeAuth(runtime, options.providers);
			const result = await runtime.refresh({
				allowNetwork: true,
				force: options.force,
				providers: options.providers,
				signal: controller.signal,
			});
			// 每个连接 runtime 的目录 overlay 是内存投影；把持久的新目录载入它们，
			// 这样「设置里已经看见新模型、实际活动却报不在目录中」不会再发生。
			await Promise.allSettled(
				[...this.runtimes.values()].map(async (pending) =>
					(await pending).refresh({ allowNetwork: false }),
				),
			);
			if (result.errors.size > 0 || result.aborted) {
				const providers = [...result.errors.keys()];
				consoleLogger.warn(
					`[cairn] model catalog refresh ${result.aborted ? "timed out" : "failed"}` +
						(providers.length ? `: ${providers.join(", ")}` : ""),
				);
				if (options.retryOnFailure !== false) this.scheduleCatalogRetry(options.providers);
			}
			return result;
		} catch (error) {
			consoleLogger.warn(
				`[cairn] model catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (options.retryOnFailure !== false) this.scheduleCatalogRetry(options.providers);
			return undefined;
		} finally {
			clearTimeout(timeout);
		}
	}
	private scheduleCatalogRetry(providers?: string[]) {
		if (this.catalogRetryTimer) return;
		this.catalogRetryTimer = setTimeout(() => {
			this.catalogRetryTimer = undefined;
			void this.refreshCatalogs({ providers, retryOnFailure: false });
		}, MODEL_CATALOG_RETRY_DELAY_MS);
		this.catalogRetryTimer.unref?.();
	}
	/** 启动后与正常请求解耦的后台目录刷新；重复调用是幂等的。 */
	startCatalogRefresh() {
		if (this.catalogStartTimer || this.catalogRefreshTimer) return;
		const run = () => void this.refreshCatalogs();
		this.catalogStartTimer = setTimeout(() => {
			this.catalogStartTimer = undefined;
			run();
		}, this.options.startDelayMs ?? MODEL_CATALOG_START_DELAY_MS);
		this.catalogStartTimer.unref?.();
		this.catalogRefreshTimer = setInterval(
			run,
			this.options.refreshIntervalMs ?? MODEL_CATALOG_REFRESH_INTERVAL_MS,
		);
		this.catalogRefreshTimer.unref?.();
	}
	stopCatalogRefresh() {
		if (this.catalogStartTimer) clearTimeout(this.catalogStartTimer);
		if (this.catalogRefreshTimer) clearInterval(this.catalogRefreshTimer);
		if (this.catalogRetryTimer) clearTimeout(this.catalogRetryTimer);
		this.catalogStartTimer = undefined;
		this.catalogRefreshTimer = undefined;
		this.catalogRetryTimer = undefined;
	}
	async catalog() {
		const r = await this.catalogRuntime();
		return r.getProviders().map((p) => ({
			id: p.id,
			name: p.name ?? p.id,
			oauth: !!p.auth.oauth,
			api_key: !!p.auth.apiKey,
			models: r.getModels(p.id).map((m) => ({
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning,
				thinkingLevelMap: m.thinkingLevelMap,
			})),
		}));
	}
	connection(id: string) {
		const p = this.store.get<ProviderConnection>("provider", id);
		if (!p) throw new ApiError(404, "供应商不存在");
		return p;
	}
	/**
	 * 面向控制台的供应商视图：builtin 的模型清单一律以 SDK 目录为准。
	 *
	 * provider 行里的 `models` 是**配置当时的快照**。内置目录后来增删过名字
	 * （例如 deepseek 的 `deepseek-flash` 被 v4 系列取代）之后，快照里会残留
	 * 已不存在的 id：控制台拿这份快照渲染模型下拉框，保存 Agent 时却用
	 * `models.model()` → `runtime.getModel()` 校验实时目录，于是出现"下拉框
	 * 选得到、保存报『模型不在目录中』"。这里直接以实时目录渲染，顺带保留
	 * 同 id 条目的思考等级覆盖（与 `model()` 的 override 语义一致）。
	 *
	 * custom 端点的模型由使用者在控制台手动维护，无法枚举，原样返回。
	 */
	async catalogFor(p: ProviderConnection): Promise<ProviderConnection> {
		if (p.kind !== "builtin") return p;
		const overrides = new Map(p.models.map((m) => [m.id, m]));
		const runtime = await this.catalogRuntime();
		return {
			...p,
			models: runtime.getModels(p.sdk_id).map((m) => {
				const override = overrides.get(m.id);
				return {
					id: m.id,
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					reasoning: override?.reasoning ?? m.reasoning,
					thinkingLevelMap: override?.thinkingLevelMap ?? m.thinkingLevelMap,
				};
			}),
		};
	}
	async model(p: ProviderConnection, id: string) {
		const runtime = await this.runtime(p);
		const model = runtime.getModel(p.sdk_id, id);
		if (!model) throw new ApiError(400, "模型不在目录中，请重新选择");
		// Preserve native API/compat/auth metadata for built-ins, while honoring the
		// per-connection thinking controls edited in the model catalog.
		const override = p.models.find((m) => m.id === id);
		return {
			runtime,
			model: override
				? {
						...model,
						reasoning: override.reasoning,
						thinkingLevelMap: override.thinkingLevelMap,
					}
				: model,
		};
	}
	startLogin(id: string, owner: string) {
		const original = this.connection(id);
		if (original.kind !== "builtin") throw new ApiError(400, "自定义端点不支持 OAuth");
		if ([...this.logins.values()].some((x) => x.provider_id === id && x.state === "pending"))
			throw new ApiError(409, "该供应商已有登录进行中");
		const connection = { ...original, credential_id: randomUUID() };
		const attempt: LoginAttempt = {
			id: randomUUID(),
			provider_id: id,
			owner,
			state: "pending",
			events: [],
			controller: new AbortController(),
		};
		this.logins.set(attempt.id, attempt);
		const timer = setTimeout(() => {
			attempt.state = "expired";
			attempt.controller.abort();
		}, 600000);
		timer.unref();
		attempt.controller.signal.addEventListener(
			"abort",
			() => {
				attempt.input = undefined;
				if (attempt.state === "pending") {
					attempt.state = "cancelled";
					attempt.events.push({ type: "cancelled" });
				}
			},
			{ once: true },
		);
		void (async () => {
			try {
				const runtime = await this.runtime(connection);
				if (!runtime.getProvider(connection.sdk_id)?.auth.oauth) throw Error("unsupported");
				await runtime.login(connection.sdk_id, "oauth", {
					signal: attempt.controller.signal,
					notify: (event: AuthEvent) => {
						attempt.events.push(event);
					},
					prompt: (prompt: AuthPrompt) =>
						new Promise<string>((resolve, reject) => {
							if (attempt.controller.signal.aborted) {
								reject(Error("cancelled"));
								return;
							}
							const token = randomUUID();
							const onAbort = () => reject(Error("cancelled"));
							attempt.input = {
								token,
								resolve: (value) => {
									attempt.controller.signal.removeEventListener("abort", onAbort);
									resolve(value);
								},
							};
							attempt.events.push({ type: "input", token, prompt });
							attempt.controller.signal.addEventListener("abort", onAbort, { once: true });
						}),
				});
				if (attempt.controller.signal.aborted) return;
				const current = this.connection(id);
				if (current.revision !== original.revision) throw Error("configuration changed");
				chmodSync(this.credentialPath(connection.credential_id), 0o600);
				this.store.put("provider", id, { ...connection, revision: original.revision + 1 });
				// 登录换发了新的 credential_id：旧凭据文件（可能是旧 OAuth
				// token 或明文 key）必须删除，不能留在磁盘上累积。
				if (original.credential_id !== connection.credential_id) {
					this.removeKey(original.credential_id);
				}
				void this.refreshCatalogs({ providers: [connection.sdk_id], force: true });
				attempt.state = "success";
				attempt.events.push({ type: "success" });
			} catch {
				if (attempt.state === "pending") {
					attempt.state = "failed";
					attempt.events.push({ type: "error", message: "登录失败或配置已修改，请重试" });
				}
			} finally {
				clearTimeout(timer);
				attempt.input = undefined;
				setTimeout(() => this.logins.delete(attempt.id), 600000).unref();
			}
		})();
		return attempt;
	}
	async logout(id: string) {
		const p = this.connection(id);
		await (await this.runtime(p)).logout(p.sdk_id);
		void this.refreshCatalogs({ providers: [p.sdk_id], force: true });
	}
}
