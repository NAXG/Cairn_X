import type { ThinkingLevelMap } from "./thinking.js";

export type AgentRole = "decide" | "execute";
export interface AgentProfile {
	role: AgentRole;
	revision: number;
	provider_id: string;
	model_id: string;
	prompt: string;
	thinking: string;
	max_output_tokens: number;
	context_window: number;
	run_seconds: number;
	harvest_seconds: number;
	tools: string[];
	/**
	 * bash 槽位的实现：one-shot = PI 一次性 bash -c（默认）；
	 * persistent = 常驻 shell（状态跨调用保留）。
	 */
	bash_mode?: "one-shot" | "persistent";
}
export interface ProviderConnection {
	id: string;
	revision: number;
	name: string;
	kind: "custom" | "builtin";
	sdk_id: string;
	base_url: string;
	api: string;
	headers: Record<string, string>;
	models: Array<{
		id: string;
		name: string;
		contextWindow: number;
		maxTokens: number;
		reasoning: boolean;
		thinkingLevelMap?: ThinkingLevelMap;
	}>;
	credential_id: string;
	configured?: boolean;
	oauth?: boolean;
}
export interface ActivitySnapshot {
	/** 可选的 dispatch.yaml compaction 参数（随快照冻结）。 */
	compaction?: { reserve_tokens?: number; keep_recent_tokens?: number };
	id: string;
	role: AgentRole;
	project_id: string;
	profile: AgentProfile;
	provider: ProviderConnection;
	created_at: string;
	profile_revision?: number;
	prompt_hash?: string;
	tools_hash?: string;
	model_id?: string;
	final_prompt?: string;
	tools?: string[];
	diagnostics?: string[];
	plugins?: import("./plugins.js").PluginSnapshot;
}
/** Seed 默认并发与规划间隔：调度配置与配置中心 seed 共用，避免字面量漂移。 */
export const RUNTIME_DEFAULTS = {
	max_workers: 9,
	max_running_projects: 3,
	max_project_workers: 3,
	decide_min_interval: 10,
} as const;

/** 模型窗口 / 输出上限的缺省值：导入配置、端点目录探针、控制台新建模型共用。 */
export const MODEL_DEFAULTS = {
	context_window: 128_000,
	max_output_tokens: 32_768,
} as const;

/**
 * tasks.execute 各段的默认秒数：YAML 校验与配置中心播种共用（播种时 decide 的
 * harvest_seconds 也取 harvest_timeout）；bash 只用于 YAML 校验默认值。
 */
export const EXECUTE_TIMEOUT_DEFAULTS = {
	step_timeout: 1200,
	harvest_timeout: 180,
	bash_timeout: 300,
} as const;

export interface RuntimeSettings {
	revision: number;
	max_workers: number;
	max_running_projects: number;
	max_project_workers: number;
	decide_min_interval: number;
}
