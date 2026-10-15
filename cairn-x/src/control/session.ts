import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
	ModelRuntime,
	SettingsManager,
	SessionManager,
	createAgentSessionServices,
	createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ActivitySnapshot } from "../contracts/configuration.js";
import type { ThinkingLevel } from "../contracts/thinking.js";
import type { UsageRecord } from "../agents/runtime/agent.js";
import { renderPrompt } from "../agents/prompts/index.js";
import type { AgentRun } from "../agents/runtime/runner.js";
import type { Logger } from "../shared/logger.js";
import { resolveCompactionSettings } from "./compaction.js";
import { activityResourceDir } from "./resources.js";
import { sessionFileName } from "../contracts/transcripts.js";
import { createCairnToolResultHook } from "../shared/tool-result-hooks.js";

/**
 * 活动会话建立期的永久性错误：配置问题（占位符缺失、提示词渲染失败）
 * 或控制面协议故障。
 *
 * 这类错误与模型端点健康无关：Worker 侧必须按普通 failed 上报，绝不能带
 * UNHEALTHY_ERROR_MARKER 去冷却一个健康的端点（否则每次配置错误都会按
 * 端点故障反复冷却）。
 */
export class ActivitySetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActivitySetupError";
	}
}

/**
 * 控制端回收执行导致的模型流终止（步骤被放弃 / 租约失效）。
 *
 * 刻意与本活动自己的取消、以及上游模型故障区分开：这不是端点健康问题。
 * 运行器把它归类为 failed 而不是 unhealthy —— 后者会冷却一个健康的端点，
 * 也会把一次自伤伪装成供应商故障。
 */
class ActivityRevokedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActivityRevokedError";
	}
}

/**
 * 工具闸门：返回理由即拦截该次调用（框架 beforeToolCall 层，工具不会执行）。
 * 用于收割阶段关闭会产生世界动作的工具。
 */
type ToolGate = (toolName: string) => string | undefined;

/**
 * 供应商缓存路由键（prompt_cache_key / x-session-affinity）。
 *
 * 同一「系统提示词 + 模型」的所有执行共享同一个键，跨 Step、跨项目都能命中
 * 供应商前缀缓存；提示词或模型变化时自然换键。键是哈希，不含业务内容。
 */
export function activityCacheSessionId(
	systemPrompt: string,
	modelId: string,
	pluginRevision?: number,
	installationId?: string,
): string {
	const material = installationId
		? `cairn-cache-v3\0${modelId}\0${installationId}\0${pluginRevision ?? 0}\0${systemPrompt}`
		: `cairn-cache-v2\0${modelId}\0${pluginRevision ?? 0}\0${systemPrompt}`;
	return createHash("sha256").update(material).digest("hex").slice(0, 64);
}

/** 缓存保留策略：跨执行复用为主（OpenAI 24h / Anthropic 1h 断点），代价是缓存写入单价略高。 */
const ACTIVITY_CACHE_RETENTION = "long" as const;

export interface ConfiguredActivityRun extends AgentRun {
	/** 安装（或置空）工具闸门；闸门只在框架层生效，工具清单保持不变。 */
	setToolGate(gate: ToolGate | null): void;
	dispose(): void;
}

/**
 * 把事件 seq 追加到工具结果最后一段文本，供模型在 evidence 里直接引用。
 *
 * 调用时机有严格要求：必须在 SDK 把消息对象放进会话历史之后（订阅回调里就是）、
 * 且在 sink 序列化之前。前者保证模型下一次请求看到的就是这份标注，后者保证落盘
 * 轨迹与模型所见逐字节一致。
 */
export function annotateEventSeq(message: { content: unknown }, seq: number): void {
	const marker = `\n[event seq=${seq}]`;
	const content = message.content;
	if (typeof content === "string") {
		message.content = content + marker;
		return;
	}
	if (!Array.isArray(content)) return;
	const last = content.at(-1) as { type?: string; text?: string } | undefined;
	if (last?.type !== "text" || typeof last.text !== "string") return;
	last.text += marker;
}

export async function createConfiguredSession(options: {
	snapshot: ActivitySnapshot;
	controlUrl: string;
	token: string;
	workspace: string;
	dataRoot: string;
	/** Frozen PI plugin release directory for this activity, if any. */
	pluginDirectory?: string;
	variables: Record<string, string | number>;
	tools: AgentTool[];
	stepId?: string;
	/** 会话 cwd：SDK 会把它拼进系统提示词末尾，逐执行变化会打短缓存尾。缺省用 workspace。 */
	sessionCwd?: string;
	sink?: (line: string) => void;
	/**
	 * 事件 sink 的下一个 seq。提供时把「本条工具结果自己的事件 seq」写回消息本体：
	 * 模型提交 evidence 需要 (execution_id, seq)，不标注就只能事后用搜索工具反查，
	 * 每步多付两次 LLM 往返。取号必须早于 sink（sink 内部按调用顺序自增）。
	 */
	nextEventSeq?: () => number;
	logger: Logger;
}): Promise<ConfiguredActivityRun> {
	const { snapshot, token } = options;
	const profile = snapshot.profile;
	const catalogModel = snapshot.provider.models.find((m) => m.id === profile.model_id);
	const controlUrl = options.controlUrl.replace(/\/$/, "");
	const post = async (endpoint: string, data: unknown, signal?: AbortSignal) => {
		// 模型流由执行预算和调用方信号约束，不能套用报告请求的短超时。
		const timeout =
			endpoint === "/internal/activities/model" ? undefined : AbortSignal.timeout(30_000);
		const r = await fetch(controlUrl + endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(data),
			signal: timeout ? (signal ? AbortSignal.any([signal, timeout]) : timeout) : signal,
		});
		if (!r.ok) throw new ActivitySetupError(`控制面请求失败 (${r.status})`);
		return r;
	};
	const runtime = await ModelRuntime.create({
		authPath: path.join(options.dataRoot, "empty-auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerProvider("cairn-remote", {
		baseUrl: controlUrl,
		api: "openai-completions",
		models: [
			{
				id: profile.model_id,
				name: profile.model_id,
				reasoning: catalogModel?.reasoning ?? profile.thinking !== "off",
				thinkingLevelMap: catalogModel?.thinkingLevelMap,
				input: ["text", "image"],
				contextWindow: profile.context_window,
				maxTokens: profile.max_output_tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		streamSimple: (model, context, streamOptions) => {
			const output = createAssistantMessageEventStream();
			void (async () => {
				let terminal = false;
				try {
					const response = await post(
						"/internal/activities/model",
						{
							context,
							options: {
								reasoning: streamOptions?.reasoning,
								maxTokens: streamOptions?.maxTokens,
								temperature: streamOptions?.temperature,
								// 主循环不传 sessionId：注入稳定缓存键（跨执行命中）。
								// 压缩等一次性请求自带新 sessionId + cacheRetention=none：原样转发，
								// 不写缓存也不占普通请求的键。
								sessionId: streamOptions?.sessionId ?? cacheSessionId,
								cacheRetention: streamOptions?.cacheRetention ?? ACTIVITY_CACHE_RETENTION,
							},
						},
						streamOptions?.signal,
					);
					const reader = response.body!.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					const consumeBlock = (block: string): void => {
						const line = block.split("\n").find((part) => part.startsWith("data:"));
						if (!line) return;
						const event = JSON.parse(line.slice(5));
						if (event.type === "transport_error") {
							throw event.reason === "revoked"
								? new ActivityRevokedError(event.message)
								: Error(event.message);
						}
						if (event.type === "done" || event.type === "error") terminal = true;
						output.push(event);
					};
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							buffer += decoder.decode(value, { stream: true });
							let end;
							while ((end = buffer.indexOf("\n\n")) >= 0) {
								const block = buffer.slice(0, end);
								buffer = buffer.slice(end + 2);
								consumeBlock(block);
							}
						}
						buffer += decoder.decode();
						if (buffer.trim()) consumeBlock(buffer);
					} finally {
						reader.releaseLock();
					}
					if (!terminal) throw Error("模型流提前结束");
				} catch (e) {
					// 被控制端回收 → 按"被中止"上报，运行器归类为 failed 而非
					// unhealthy（见 ActivityRevokedError 的说明）。
					const revoked = e instanceof ActivityRevokedError;
					const stop = revoked || streamOptions?.signal?.aborted ? "aborted" : "error";
					output.push({
						type: "error",
						reason: stop,
						error: {
							role: "assistant",
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: stop,
							errorMessage: (e as Error).message,
							timestamp: Date.now(),
						},
					});
				} finally {
					output.end();
				}
			})();
			return output;
		},
	});
	await runtime.setRuntimeApiKey("cairn-remote", "activity-token");
	const agentDir = activityResourceDir(options.dataRoot, snapshot.id);
	mkdirSync(agentDir, { recursive: true });
	let systemPrompt: string;
	try {
		systemPrompt = renderPrompt(profile.prompt, options.variables);
	} catch (err) {
		// 占位符缺失是配置永久错误：换用新模板或补齐变量前重试也不会成功。
		throw new ActivitySetupError(err instanceof Error ? err.message : String(err));
	}
	// 与系统提示词同源的稳定缓存键：跨执行共享供应商前缀缓存。
	const cacheSessionId = activityCacheSessionId(
		systemPrompt,
		profile.model_id,
		snapshot.plugins?.revision,
		snapshot.plugins?.installation_id,
	);
	const compaction = resolveCompactionSettings(profile.context_window, snapshot.compaction);
	let pluginExtensions: string[] = [];
	let pluginSkills: string[] = [];
	if (options.pluginDirectory) {
		const manifestPath = path.join(options.pluginDirectory, "plugin.json");
		if (!existsSync(manifestPath)) throw new ActivitySetupError("PI 插件版本目录缺少 plugin.json");
		let manifest: {
			role?: string;
			revision?: number;
			installation_id?: string;
			enabled?: boolean;
			resources?: { extensions?: string[]; skills?: string[] };
		};
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (!manifest || typeof manifest !== "object") throw new Error("manifest is not an object");
		} catch (err) {
			throw new ActivitySetupError(
				`PI 插件清单无效: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (
			!snapshot.plugins ||
			manifest.role !== snapshot.role ||
			manifest.revision !== snapshot.plugins.revision ||
			manifest.installation_id !== snapshot.plugins.installation_id
		)
			throw new ActivitySetupError("PI 插件目录与活动快照不匹配");
		if (manifest.enabled === false) throw new ActivitySetupError("PI 插件已停用");
		const root = realpathSync(options.pluginDirectory);
		const resolveResource = (value: string): string => {
			if (typeof value !== "string" || path.isAbsolute(value))
				throw new ActivitySetupError("PI 插件资源路径无效");
			let resolved: string;
			try {
				resolved = realpathSync(path.join(root, value));
			} catch {
				throw new ActivitySetupError("PI 插件资源不存在");
			}
			if (resolved !== root && !resolved.startsWith(root + path.sep))
				throw new ActivitySetupError("PI 插件资源越过版本目录");
			return resolved;
		};
		if (
			!Array.isArray(manifest.resources?.extensions ?? []) ||
			!Array.isArray(manifest.resources?.skills ?? [])
		)
			throw new ActivitySetupError("PI 插件资源清单无效");
		pluginExtensions = (manifest.resources?.extensions ?? []).map(resolveResource);
		pluginSkills = (manifest.resources?.skills ?? []).map(resolveResource);
	}
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: compaction.reserveTokens,
			keepRecentTokens: compaction.keepRecentTokens,
		},
		retry: { enabled: false },
	});
	const services = await createAgentSessionServices({
		cwd: options.sessionCwd ?? options.workspace,
		agentDir: options.pluginDirectory ?? agentDir,
		modelRuntime: runtime,
		settingsManager,
		resourceLoaderOptions: {
			systemPrompt,
			noContextFiles: true,
			noPromptTemplates: true,
			noThemes: true,
			// 宿主机的技能、扩展与 APPEND_SYSTEM.md 不属于活动提示词：
			// 任何一段被发现进来都会让「系统提示词逐字节稳定」的缓存不变量失效。
			noSkills: true,
			noExtensions: true,
			additionalExtensionPaths: pluginExtensions,
			additionalSkillPaths: pluginSkills,
			appendSystemPromptOverride: () => [],
		},
		resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
	});
	const tools = [...options.tools];
	const extensionToolNames =
		options.pluginDirectory === undefined
			? []
			: services.resourceLoader
					.getExtensions()
					.extensions.flatMap((extension) => [...extension.tools.keys()]);
	const collisions = extensionToolNames.filter((name) => tools.some((tool) => tool.name === name));
	if (collisions.length > 0) {
		throw new ActivitySetupError(
			`PI 插件工具与 Cairn 工具重名: ${[...new Set(collisions)].join(", ")}`,
		);
	}
	const duplicateExtensionTools = extensionToolNames.filter(
		(name, index) => extensionToolNames.indexOf(name) !== index,
	);
	if (duplicateExtensionTools.length > 0) {
		throw new ActivitySetupError(
			`PI 插件工具重名: ${[...new Set(duplicateExtensionTools)].join(", ")}`,
		);
	}
	const sessionDir = path.join(options.dataRoot, snapshot.project_id, "sessions");
	if (!options.sink) mkdirSync(sessionDir, { recursive: true });
	// snapshot.id 在创建时已规约到文件名安全字符集（见 activity-routes 的
	// sanitizeActivityId）：这里直接拼文件名，控制台的会话列表/导出依赖该命名模式。
	const sessionManager = options.sink
		? SessionManager.inMemory(options.workspace)
		: SessionManager.create(options.workspace, sessionDir);
	if (!options.sink)
		sessionManager.setSessionFile(path.join(sessionDir, sessionFileName(snapshot.id)));
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: runtime.getModel("cairn-remote", profile.model_id),
		// AgentProfile.thinking 在契约里是 string；控制台只写入 contracts/thinking 的
		// 合法等级，这里收窄成与 pi-agent-core 完全一致的联合类型。
		thinkingLevel: profile.thinking as ThinkingLevel,
		noTools: "builtin",
		customTools: tools,
		// Explicitly allow Cairn tools plus tools registered by the frozen PI release.
		// Passing only the SDK tools would silently hide extension tools because PI treats
		// `tools` as an allow-list.
		tools: [
			...tools.map((t) => t.name),
			...(options.pluginDirectory === undefined ? [] : extensionToolNames),
			...(options.pluginDirectory === undefined ||
			services.resourceLoader.getSkills().skills.length === 0
				? []
				: ["read"]),
		],
	});
	const diagnostics = services.diagnostics.map((d) => d.message);
	await session.bindExtensions({
		mode: "print",
		onError: (error) => {
			diagnostics.push(String(error.error));
		},
	});
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		seq = 0;
	// 上报内容只在这里定义一次：两处各写一遍时，改一处漏一处，每回合的上报就会
	// 覆盖掉初次上报的正确值。
	const reportActivity = () =>
		post("/internal/activities/report", {
			// 0.86 起系统提示词由 transcript 承载，agent.state.systemPrompt 不再是权威来源
			// （在活动会话里可能为空，会把正确的 final_prompt 覆盖成空串）；
			// session.systemPrompt 是 SDK 承诺的「与 provider 实际所见一致」的取值。
			final_prompt: session.systemPrompt,
			tools: session.getActiveToolNames(),
			diagnostics,
		});
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "turn_start") {
			void reportActivity().catch(() => {});
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant") {
				input += event.message.usage.input;
				output += event.message.usage.output;
				cacheRead += event.message.usage.cacheRead;
				cacheWrite += event.message.usage.cacheWrite;
			}
			if (options.nextEventSeq !== undefined && event.message.role === "toolResult") {
				annotateEventSeq(event.message, options.nextEventSeq());
			}
			options.sink?.(
				JSON.stringify({
					type: "message",
					id: `${snapshot.id}-${++seq}`,
					parentId: seq > 1 ? `${snapshot.id}-${seq - 1}` : null,
					timestamp: new Date().toISOString(),
					message: event.message,
				}),
			);
		}
	});
	try {
		await reportActivity();
	} catch (error) {
		unsubscribe();
		session.dispose();
		throw error;
	}
	// 到点强停与工具闸门都走框架钩子，不再依赖模型自觉：
	//
	// - finishTurn：置位后循环在**回合边界**退出（当前回合的工具照常
	//   执行完），不需要 steer 被采纳，也不需要 abort 硬杀。
	// - beforeToolCall：闸门命中时返回 {block, reason, terminate}，工具不执行、
	//   模型收到一条 error 工具结果，且本批全被拦时该回合直接收尾。
	//
	// 框架为扩展装的 beforeToolCall 必须**包住**而不是覆盖 —— session 只在会话
	// 构造时安装一次（agent-session.js 的 _installAgentToolHooks），直接赋值会
	// 静默废掉扩展的 tool_call 拦截。
	let toolGate: ToolGate | null = null;
	let stopRequested = false;
	const extensionBeforeToolCall = session.agent.beforeToolCall;
	// PI marks a normally returned result as successful, even with details.error=true.
	// Normalize only our tools before extensions, persistence and model feedback.
	session.agent.afterToolCall = createCairnToolResultHook(tools, session.agent.afterToolCall);
	session.agent.beforeToolCall = async (context, signal) => {
		const reason = toolGate?.(context.toolCall.name);
		if (reason !== undefined) {
			return { block: true, reason, terminate: true };
		}
		return extensionBeforeToolCall ? await extensionBeforeToolCall(context, signal) : undefined;
	};
	session.agent.finishTurn = async (turn) => {
		// finishTurn 也会收到错误和中止回合；旧的 shouldStopAfterTurn 只处理
		// 正常回合，保留这个守卫以维持原有收尾语义。
		if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
		return stopRequested ? { action: "end" } : undefined;
	};
	return {
		agent: {
			prompt: async (message: AgentMessage) => {
				if (message.role !== "user") throw Error("Expected user prompt");
				// 每个 pass（探索 / 收割）开始时复位停止标志。requestStop 是“到点
				// 强停”的单向闩锁：若不复位，探索耗尽预算后收割 pass 会在第一个
				// 回合结束就被 finishTurn 掐死，收割预算形同虚设、
				// 事实抢救失效（超时执行只能以 failed/无总结收场）。
				stopRequested = false;
				await session.prompt(
					typeof message.content === "string" ? message.content : JSON.stringify(message.content),
				);
			},
			steer: (message: AgentMessage) => {
				if (message.role === "user")
					void session.steer(
						typeof message.content === "string" ? message.content : JSON.stringify(message.content),
					);
			},
			abort: () => {
				void session.abort();
			},
			subscribe: (listener) => session.agent.subscribe(listener),
		},
		requestStop: () => {
			stopRequested = true;
		},
		setToolGate: (gate) => {
			toolGate = gate;
		},
		usage: (): UsageRecord => ({
			activity: snapshot.role,
			step_id: options.stepId,
			model: profile.model_id,
			input_tokens: input,
			output_tokens: output,
			cache_read_tokens: cacheRead,
			cache_write_tokens: cacheWrite,
		}),
		dispose: () => {
			unsubscribe();
			session.dispose();
		},
	};
}
