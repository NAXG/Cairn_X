import { installActivityReadVersions } from "../server/core/read-versions.js";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../server/db.js";
import type { DeploymentConfig, DispatchConfig, ModelConfig } from "../scheduler/config.js";
import { loadPrompt, renderPrompt } from "../agents/prompts/index.js";
import type {
	AgentProfile,
	AgentRole,
	ProviderConnection,
	ActivitySnapshot,
	RuntimeSettings,
} from "../contracts/configuration.js";
import {
	EXECUTE_TIMEOUT_DEFAULTS,
	MODEL_DEFAULTS,
	RUNTIME_DEFAULTS,
} from "../contracts/configuration.js";
import {
	clampThinkingLevel,
	type ThinkingLevel,
	type ThinkingLevelMap,
} from "../contracts/thinking.js";
import type { CompactionOptions } from "./compaction.js";
import { ApiError } from "../server/core/base.js";
import type { PluginStore } from "../plugins/store.js";
import type { PluginSnapshot } from "../contracts/plugins.js";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

const ACTIVITY_SNAPSHOT_KEEP = 5;

/**
 * dispatch.yaml 导入模型时的默认思考等级。
 *
 * 必须与模型能力一起设置：路由侧（routes.ts）的约定是「选了非 off 等级
 * 就把该模型登记为 reasoning」，这里同理 —— 若只改 thinking 而模型仍是
 * reasoning:false，supportedThinkingLevels() 会把它规约回 off，默认值形同虚设。
 */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

/**
 * DeepSeek 思考等级 → reasoning_effort 映射（取官方文档的映射表：
 * minimal/low→low，medium/high/xhigh→high，max/ultra→max）。
 *
 * 这张表不只是翻译：supportedThinkingLevels() 规定 xhigh/max 必须显式映射
 * 才视为可用，否则 clampThinkingLevel() 会把 max 悄悄降回 high。
 * PI 自己也是按 base_url 是否含 deepseek.com 识别该端点族的，这里沿用同一判据。
 */
const DEEPSEEK_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	minimal: "low",
	low: "low",
	medium: "high",
	high: "high",
	xhigh: "high",
	max: "max",
};

const isDeepSeekEndpoint = (baseUrl: string) => baseUrl.toLowerCase().includes("deepseek.com");

/** dispatch.yaml 导入的模型条目；profile 的默认思考等级必须用同一对象规约。 */
function importedModel(model: ModelConfig): ProviderConnection["models"][number] {
	return {
		id: model.model_id,
		name: model.model_id,
		contextWindow: model.context_window ?? MODEL_DEFAULTS.context_window,
		maxTokens: model.max_output_tokens ?? MODEL_DEFAULTS.max_output_tokens,
		reasoning: DEFAULT_THINKING_LEVEL !== "off",
		...(isDeepSeekEndpoint(model.base_url)
			? { thinkingLevelMap: DEEPSEEK_THINKING_LEVEL_MAP }
			: {}),
	};
}

/**
 * 活动 id 规约到文件名安全字符集：snapshot.id 直接用作会话 JSONL 文件名。
 * worker 名形如 decide:<model>:<suffix>:<uuid>，model_id 还可能含 "/"。
 */
export const sanitizeActivityId = (raw: string) => raw.replace(/[^0-9A-Za-z-]/g, "-");

/** 当前 decide 租约对应的快照 id（无租约时为永不匹配的占位符）。 */
function activeDecideSnapshotId(db: Db, projectId: string): string {
	const row = db.prepare("SELECT decide_worker FROM projects WHERE id = ?").get(projectId) as
		{ decide_worker: string | null } | undefined;
	return row?.decide_worker ? `decide-${sanitizeActivityId(row.decide_worker)}` : "";
}

export class ConfigurationStore {
	constructor(
		readonly db: Db,
		private readonly compactionOptions?: CompactionOptions,
		private readonly plugins?: PluginStore,
	) {
		db.exec(`CREATE TABLE IF NOT EXISTS configuration_objects (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS activity_configurations (id TEXT PRIMARY KEY,body TEXT NOT NULL);
`);
		installActivityReadVersions(db);
	}
	get<T>(kind: string, id: string): T | undefined {
		const r = this.db
			.prepare("SELECT body FROM configuration_objects WHERE kind=? AND id=?")
			.get(kind, id) as { body: string } | undefined;
		return r ? JSON.parse(r.body) : undefined;
	}
	list<T>(kind: string): T[] {
		return (
			this.db
				.prepare("SELECT body FROM configuration_objects WHERE kind=? ORDER BY rowid")
				.all(kind) as { body: string }[]
		).map((r) => JSON.parse(r.body));
	}
	put(kind: string, id: string, value: unknown) {
		this.db
			.prepare(
				"INSERT INTO configuration_objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
			)
			.run(kind, id, JSON.stringify(value));
	}
	remove(kind: string, id: string) {
		this.db.prepare("DELETE FROM configuration_objects WHERE kind=? AND id=?").run(kind, id);
	}
	profile(role: AgentRole): AgentProfile {
		const stored = this.get<AgentProfile>("agent", role);
		if (!stored) throw new ApiError(404, `Agent profile not found: ${role}`);
		return { ...stored };
	}
	/**
	 * 仓库默认提示词与库内 profile.prompt 的漂移报告。
	 *
	 * prompt 只在 initialize() 时从文件播种一次，之后**以 DB 为准**（控制台可编辑）。
	 * 于是"改了仓库里的 execute.md / decide.md 却没生效"是一个**完全静默**的失败：
	 * 文件改了、行为没变、没有任何报错。启动时必须显式告警。
	 *
	 * 只报告不覆盖：库里的版本可能是有人在控制台有意编辑的。
	 */
	promptDrift(role: AgentRole): { drifted: boolean; storedBytes: number; fileBytes: number } {
		const stored = this.profile(role)?.prompt ?? "";
		const file = loadPrompt(role);
		return {
			drifted: stored !== file,
			storedBytes: Buffer.byteLength(stored, "utf8"),
			fileBytes: Buffer.byteLength(file, "utf8"),
		};
	}
	initialize(config?: DispatchConfig | DeploymentConfig) {
		if (this.get("meta", "initialized")) return;
		// 只有显式传入导入配置才播种运行参数；部署配置不承载这些值。
		const seed = config && "models" in config ? config : undefined;
		// 解析出的 tasks.execute 恒有值（schema prefault），这里兜的是「没有导入配置」。
		// 键集与 EXECUTE_TIMEOUT_DEFAULTS 完全同形故可整段回落；RUNTIME_DEFAULTS 只是
		// runtime 段的子集，只能逐字段回落（见下方 runtime 播种）。
		const executeTimeouts = seed?.tasks.execute ?? EXECUTE_TIMEOUT_DEFAULTS;
		this.db.transaction(() => {
			for (const role of ["decide", "execute"] as const) {
				const model = seed?.models[role];
				const id = `imported-${role}`;
				const imported = model ? importedModel(model) : undefined;
				if (model && imported)
					this.put("provider", id, {
						id,
						revision: 1,
						name: role === "decide" ? "Dispatcher 连接" : "Execute 连接",
						kind: "custom",
						sdk_id: id,
						base_url: model.base_url,
						api: model.api,
						headers: {},
						models: [imported],
						credential_id: randomUUID(),
					} satisfies ProviderConnection);
				this.put("agent", role, {
					role,
					revision: 1,
					provider_id: model ? id : "",
					model_id: model?.model_id ?? "",
					prompt: loadPrompt(role),
					// Decide / Execute 默认 high，并按模型能力规约；未配置模型时保持 off。
					thinking: imported ? clampThinkingLevel(imported, DEFAULT_THINKING_LEVEL) : "off",
					// 与 thinking 同源：都消费上面已解析好的 imported。
					context_window: imported?.contextWindow ?? MODEL_DEFAULTS.context_window,
					max_output_tokens: imported?.maxTokens ?? MODEL_DEFAULTS.max_output_tokens,
					run_seconds: role === "decide" ? 300 : executeTimeouts.step_timeout,
					harvest_seconds: executeTimeouts.harvest_timeout,
					// 默认极简：Execute 只挂常驻 bash（单世界工具）。
					// 需要完整工具集时在控制台「设置 → Agents → Execute」切回「完整」。
					tools: role === "execute" ? ["bash"] : [],
					...(role === "execute" ? { bash_mode: "persistent" as const } : {}),
				} satisfies AgentProfile);
			}
			this.put("runtime", "global", {
				revision: 1,
				max_workers: seed?.runtime.max_workers ?? RUNTIME_DEFAULTS.max_workers,
				max_running_projects:
					seed?.runtime.max_running_projects ?? RUNTIME_DEFAULTS.max_running_projects,
				max_project_workers:
					seed?.runtime.max_project_workers ?? RUNTIME_DEFAULTS.max_project_workers,
				decide_min_interval:
					seed?.runtime.decide_min_interval ?? RUNTIME_DEFAULTS.decide_min_interval,
			} satisfies RuntimeSettings);
			this.put("meta", "initialized", { at: new Date().toISOString() });
		})();
	}
	/**
	 * Agent Profile 的完整校验（不写任何状态）。
	 *
	 * 目录外模型由调用方传入「拟写入」的 provider 视图即可在校验期解析：
	 * 这样路由可以先校验、全部通过后再写供应商目录，避免校验失败留下
	 * revision 已自增的目录副作用。
	 */
	validateProfile(profile: AgentProfile, providerOverride?: ProviderConnection) {
		const old = this.profile(profile.role);
		if (profile.revision !== old.revision) throw new ApiError(409, "配置已被修改，请重新加载");
		const vars: Record<string, string> =
			profile.role === "execute" ? { container_semantics: "" } : {};
		try {
			renderPrompt(profile.prompt, vars);
		} catch (e) {
			throw new ApiError(400, (e as Error).message);
		}
		if (profile.max_output_tokens > profile.context_window)
			throw new ApiError(400, "输出上限不能超过上下文窗口");
		// 未配置模型（provider_id/model_id 同为空）是合法状态：不能开始活动
		// （见 createSnapshot），但允许保存 prompt/工具/预算，也允许把 Agent 从某个
		// 供应商上解绑 —— 否则被 Agent 绑定的供应商永远删不掉。
		if (profile.provider_id === "") {
			if (profile.model_id !== "") throw new ApiError(400, "请选择供应商");
			return;
		}
		const provider =
			providerOverride ?? this.get<ProviderConnection>("provider", profile.provider_id);
		if (!provider) throw new ApiError(400, "请选择供应商");
		if (provider.kind === "custom" && !provider.models.some((m) => m.id === profile.model_id))
			throw new ApiError(400, "模型不在供应商目录中");
	}
	saveProfile(profile: AgentProfile) {
		this.validateProfile(profile);
		const old = this.profile(profile.role);
		const next = { ...profile, revision: old.revision + 1 };
		this.put("agent", profile.role, next);
		return next;
	}
	/** 运行时限独立保存，避免未配置模型或其他 Agent 草稿阻断设置。 */
	saveBudget(
		role: AgentRole,
		budget: Pick<AgentProfile, "revision" | "run_seconds" | "harvest_seconds">,
	) {
		const old = this.profile(role);
		if (budget.revision !== old.revision) throw new ApiError(409, "配置已被修改，请重新加载");
		const next = { ...old, ...budget, revision: old.revision + 1 };
		this.put("agent", role, next);
		return next;
	}
	snapshot(id: string, role: AgentRole, projectId: string): ActivitySnapshot {
		return this.db.transaction(() => this.createSnapshot(id, role, projectId)).immediate();
	}
	private createSnapshot(id: string, role: AgentRole, projectId: string): ActivitySnapshot {
		const old = this.readSnapshot(id);
		if (old) return old;
		const profile = this.profile(role);
		const provider = this.get<ProviderConnection>("provider", profile.provider_id);
		if (!provider) throw new ApiError(409, "请先配置 Agent 模型");
		const plugin = this.plugins?.list(role);
		const snap = {
			id,
			role,
			project_id: projectId,
			profile,
			provider,
			...(this.compactionOptions ? { compaction: this.compactionOptions } : {}),
			created_at: new Date().toISOString(),
			profile_revision: profile.revision,
			prompt_hash: sha256(profile.prompt),
			tools_hash: sha256([...profile.tools, profile.bash_mode ?? "one-shot"].join("\n")),
			model_id: profile.model_id,
			...(plugin?.enabled && !plugin.retiring
				? {
						plugins: {
							role,
							...(plugin.installation_id ? { installation_id: plugin.installation_id } : {}),
							revision: plugin.revision,
							sources: plugin.packages,
							resources: plugin.resources,
						} satisfies PluginSnapshot,
					}
				: {}),
		};
		this.db
			.prepare("INSERT INTO activity_configurations VALUES (?,?)")
			.run(id, JSON.stringify(snap));
		// 每次执行都会产生新快照：每项目每角色只保留最近若干条，防止随运行次数无界增长。
		// 保护例外（与 server 表同库，无外键）：非终态 execution 的 execute 快照
		// （Worker claim 时要读），以及当前 decide_worker 租约对应的 decide 快照。
		const protectedDecideId = activeDecideSnapshotId(this.db, projectId);
		this.db
			.prepare(
				`DELETE FROM activity_configurations WHERE json_extract(body,'$.project_id')=? AND json_extract(body,'$.role')=? AND id NOT IN (
      SELECT id FROM activity_configurations WHERE json_extract(body,'$.project_id')=? AND json_extract(body,'$.role')=? ORDER BY json_extract(body,'$.created_at') DESC LIMIT ?)
      AND id NOT IN (SELECT id FROM executions WHERE project_id=? AND status NOT IN ('succeeded','failed','cancelled','lost'))
      AND id <> ?`,
			)
			.run(projectId, role, projectId, role, ACTIVITY_SNAPSHOT_KEEP, projectId, protectedDecideId);
		return snap;
	}
	readSnapshot(id: string): ActivitySnapshot | undefined {
		const r = this.db.prepare("SELECT body FROM activity_configurations WHERE id=?").get(id) as
			{ body: string } | undefined;
		return r ? JSON.parse(r.body) : undefined;
	}
	report(id: string, report: Pick<ActivitySnapshot, "final_prompt" | "tools" | "diagnostics">) {
		this.db
			.transaction(() => {
				const snap = this.readSnapshot(id);
				if (!snap) throw new ApiError(404, "未记录活动配置");
				this.db
					.prepare("UPDATE activity_configurations SET body=? WHERE id=?")
					.run(JSON.stringify({ ...snap, ...report }), id);
			})
			.immediate();
	}
}
