/**
 * Cairn_X 的 dispatch.yaml 加载与校验（Executor Worker 架构）。
 *
 * `api_key: "env:VAR_NAME"` 表示在加载时从环境变量读取密钥。
 * API key 永远不会出现在错误信息或日志中；长期模型凭据只被控制端
 * （dispatcher 健康检查 / serve 模型代理）持有，Worker 仅获得绑定
 * 单次执行的短期令牌。
 */

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { DEFAULT_BENCHMARK_BASE_URL } from "../tsecbench/client.js";
import { MAX_ACTIVE_CHALLENGES } from "../tsecbench/types.js";
import { EXECUTE_TIMEOUT_DEFAULTS, RUNTIME_DEFAULTS } from "../contracts/configuration.js";

const ENV_PREFIX = "env:";

const urlString = z
	.string()
	.min(1)
	.refine((v) => {
		try {
			new URL(v);
			return true;
		} catch {
			return false;
		}
	}, "must be a valid URL");

const modelConfigSchema = z.object({
	model_id: z.string().min(1),
	base_url: urlString,
	api: z.enum(["anthropic-messages", "openai-completions", "openai-responses"]),
	api_key: z.string().min(1),
	context_window: z.number().int().positive().optional(),
	/** 单次请求输出 token 上限（端点对 max_tokens 校验严格）；未配置时取 MODEL_DEFAULTS。 */
	max_output_tokens: z.number().int().positive().optional(),
});

const runtimeConfigSchema = z.object({
	interval: z.number().positive().default(3),
	max_workers: z.number().int().positive().default(RUNTIME_DEFAULTS.max_workers),
	max_running_projects: z.number().int().positive().default(RUNTIME_DEFAULTS.max_running_projects),
	max_project_workers: z.number().int().positive().default(RUNTIME_DEFAULTS.max_project_workers),
	decide_min_interval: z.number().nonnegative().default(RUNTIME_DEFAULTS.decide_min_interval),
	endpoint_cooldown: z.number().positive().default(5),
	/** 连续不健康结果达到该次数后，将单个项目的 cooldown 升级为整个 activity 级别的 cooldown。 */
	endpoint_unhealthy_threshold: z.number().int().positive().default(3),
});

const containerConfigSchema = z.object({
	image: z.string().min(1).default("cairn-x-worker:latest"),
	/** 独立容器网络（Worker 与控制端同网可达）。 */
	network: z.string().min(1).default("cairn-workers"),
	/** Worker 访问控制端的 URL（compose 内为服务别名；host 部署为宿主地址）。 */
	worker_control_url: urlString.optional(),
	/** Worker 容器资源与安全限制。 */
	cpus: z.number().positive().default(2),
	memory_mb: z.number().int().positive().default(2048),
	pids_limit: z.number().int().positive().default(512),
	/** 取消/停止的优雅宽限（秒）：SIGTERM → 等待 → SIGKILL。 */
	stop_grace_seconds: z.number().positive().default(20),
	/**
	 * 容器退出时是否自动删除（docker run --rm）。默认 false：保留退出的容器，
	 * 便于人工用 docker logs / inspect 排查；回收由 DispatcherLoop 的容器对账负责。
	 */
	auto_remove: z.boolean().default(false),
	/** per-project 容器空闲多久后停止（秒）；非 active 项目立即停止。 */
	project_idle_seconds: z.number().int().positive().default(600),
});

const tasksConfigSchema = z.object({
	execute: z
		.object({
			step_timeout: z.number().positive().default(EXECUTE_TIMEOUT_DEFAULTS.step_timeout),
			/** 主运行成功后的收割 pass（强制提交残留事实）的时间上限。 */
			harvest_timeout: z.number().positive().default(EXECUTE_TIMEOUT_DEFAULTS.harvest_timeout),
			/**
			 * 单条 bash 命令的默认超时（秒）。PI 的 bash 没有默认超时，不注入则一条
			 * 长扫描会把 agent loop 卡在工具边界，软收尾（进度提醒 / requestStop）
			 * 永不触发，只能等控制端硬 deadline 杀容器、已确认事实全丢。
			 */
			bash_timeout: z.number().int().positive().default(EXECUTE_TIMEOUT_DEFAULTS.bash_timeout),
		})
		.prefault({}),
});

const healthcheckConfigSchema = z.object({
	timeout: z.number().positive().default(20),
});

const compactionConfigSchema = z.object({
	/** 当上下文 token 数超过 context_window - reserve_tokens 时触发 compaction。 */
	reserve_tokens: z.number().int().positive().optional(),
	/** compaction 后大致保留的最近上下文 token 数。 */
	keep_recent_tokens: z.number().int().positive().optional(),
});

/**
 * TSecBench 评测平台接入配置。
 *
 * token 是跑分任务凭据，只由控制端持有：Worker 通过执行协议代理
 * submit/hint，容器里永远不出现 BENCHMARK_TOKEN。未配置该段时也可以
 * 只用环境变量 BENCHMARK_TOKEN / BENCHMARK_BASE_URL 启用。
 */
const benchmarkConfigSchema = z.object({
	base_url: urlString.default(DEFAULT_BENCHMARK_BASE_URL),
	/** 支持 "env:BENCHMARK_TOKEN" 引用，避免把 token 写进配置文件。 */
	token: z.string().min(1),
	/** 同时启动的靶场容器上限（平台硬上限 3）。 */
	max_active: z.number().int().positive().max(MAX_ACTIVE_CHALLENGES).default(MAX_ACTIVE_CHALLENGES),
	auto_start: z.boolean().default(true),
	auto_close: z.boolean().default(true),
	/** 单题总时限（秒）；超过后停止项目并释放容器。 */
	challenge_timeout: z.number().positive().default(7200),
});

const dispatchObjectSchema = z.object({
	server: urlString,
	runtime: runtimeConfigSchema.prefault({}),
	models: z.object({
		decide: modelConfigSchema,
		execute: modelConfigSchema,
	}),
	container: containerConfigSchema.prefault({}),
	tasks: tasksConfigSchema.prefault({}),
	healthcheck: healthcheckConfigSchema.prefault({}),
	compaction: compactionConfigSchema.optional(),
	benchmark: benchmarkConfigSchema.optional(),
});

export const dispatchConfigSchema = dispatchObjectSchema.superRefine((config, ctx) => {
	if (config.runtime.max_project_workers > config.runtime.max_workers) {
		ctx.addIssue({
			code: "custom",
			path: ["runtime", "max_project_workers"],
			message: "max_project_workers cannot exceed max_workers",
		});
	}
});

/** Worker 在容器内看不到的宿主地址：必须换成 host.docker.internal 才能回连。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);

/** 容器内不可达的宿主地址换成 host.docker.internal；compose 服务别名原样保留。 */
export function hostReachable(host: string): string {
	return LOOPBACK_HOSTS.has(host) ? "host.docker.internal" : host;
}

/**
 * Worker 容器访问控制面的 URL。
 *
 * 显式配置 `container.worker_control_url` 时优先；否则**从 `server` 的 host 推导**：
 * - compose 部署里 server 是服务别名（如 http://cairn-x-server:8000），Worker 与
 *   serve 同网，必须原样使用该 host；
 * - host 部署里 server 通常是 127.0.0.1，容器内不可达，要换成 host.docker.internal。
 *
 * 之前这里无条件返回 host.docker.internal 并丢弃 server 的 host：compose 部署的
 * 每个 Worker 都拨向解析不到的 host.docker.internal，表现为 next 永远 status=0、
 * 所有 step 无法开始，只有手工写 worker_control_url 才能恢复。
 */
export function workerControlUrl(config: Pick<DispatchConfig, "server" | "container">): string {
	const explicit = config.container.worker_control_url;
	if (explicit !== undefined) {
		return explicit;
	}
	const url = new URL(config.server);
	const host = hostReachable(url.hostname.replace(/^\[|\]$/g, ""));
	const authority = host.includes(":") ? `[${host}]` : host;
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	return `${url.protocol}//${authority}:${port}/`;
}

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;
export type DispatchConfig = z.infer<typeof dispatchConfigSchema>;

/** 正常启动只读取部署配置；模型、预算与并发只能由数据库提供。 */
export const deploymentConfigSchema = dispatchObjectSchema.omit({ models: true }).extend({
	runtime: runtimeConfigSchema
		.omit({
			max_workers: true,
			max_running_projects: true,
			max_project_workers: true,
			decide_min_interval: true,
		})
		.prefault({}),
	tasks: z
		.object({
			execute: tasksConfigSchema.shape.execute
				.unwrap()
				.omit({
					step_timeout: true,
					harvest_timeout: true,
				})
				.prefault({}),
		})
		.prefault({}),
});
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function resolveApiKey(value: string, fieldPath: string): string {
	if (!value.startsWith(ENV_PREFIX)) {
		return value;
	}
	const name = value.slice(ENV_PREFIX.length);
	if (name === "") {
		throw new ConfigError(`${fieldPath}: "env:" requires a variable name`);
	}
	const resolved = process.env[name];
	if (resolved === undefined || resolved === "") {
		throw new ConfigError(`${fieldPath}: environment variable ${name} is not set`);
	}
	return resolved;
}

function readConfigMapping(path: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		throw new ConfigError(
			`cannot read config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let data: unknown;
	try {
		data = parseYaml(raw);
	} catch (err) {
		throw new ConfigError(
			`invalid YAML in ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new ConfigError(`${path}: config must be a YAML mapping`);
	}
	return data;
}

/** 手动格式化 zod 错误：美化输出可能回显接收到的值（文件可能含 API key）。 */
function formatIssues(
	path: string,
	issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): ConfigError {
	const lines = issues.map((issue) => {
		const pathStr = issue.path.map(String).join(".") || "(root)";
		return `  ${pathStr}: ${issue.message}`;
	});
	return new ConfigError(`invalid config ${path}:\n${lines.join("\n")}`);
}

function parseConfig<S extends z.ZodTypeAny>(schema: S, data: unknown, path: string): z.infer<S> {
	const result = schema.safeParse(data);
	if (!result.success) throw formatIssues(path, result.error.issues);
	return result.data;
}

/** 部署加载不校验、不解析旧 YAML 中的模型凭据或运行参数。 */
export function loadDeploymentConfig(path: string): DeploymentConfig {
	const data = parseConfig(deploymentConfigSchema, readConfigMapping(path), path);
	return { ...data, benchmark: resolveBenchmarkConfig(data.benchmark) };
}

/** 显式首次导入 / YAML 端点健康检查专用，不用于正常启动。 */
export function loadDispatchConfig(path: string): DispatchConfig {
	const config = parseConfig(dispatchConfigSchema, readConfigMapping(path), path);
	config.models.decide = {
		...config.models.decide,
		api_key: resolveApiKey(config.models.decide.api_key, "models.decide.api_key"),
	};
	config.models.execute = {
		...config.models.execute,
		api_key: resolveApiKey(config.models.execute.api_key, "models.execute.api_key"),
	};
	config.benchmark = resolveBenchmarkConfig(config.benchmark);
	return config;
}

/**
 * benchmark / doctor 用的轻量加载：只取 server 与 benchmark，不解析模型凭据。
 * 这样 driver 可以作为独立后台服务运行，无需模型 API key 环境变量。
 */
export function loadBenchmarkConfig(path: string): {
	server: string;
	benchmark?: BenchmarkConfig;
} {
	const data = parseConfig(
		z.object({ server: urlString, benchmark: benchmarkConfigSchema.optional() }),
		readConfigMapping(path),
		path,
	);
	return {
		server: data.server,
		benchmark: resolveBenchmarkConfig(data.benchmark),
	};
}

/**
 * 解析 benchmark 配置：
 * - 未写 benchmark 段但设置了 BENCHMARK_TOKEN 时，用环境变量启用
 *   （平台约定的接入方式）；
 * - 写了 benchmark 段时，支持 token: "env:BENCHMARK_TOKEN" 引用。
 */
function resolveBenchmarkConfig(config: BenchmarkConfig | undefined): BenchmarkConfig | undefined {
	if (config === undefined) {
		const token = process.env.BENCHMARK_TOKEN;
		if (token === undefined || token === "") {
			return undefined;
		}
		const parsed = benchmarkConfigSchema.safeParse({
			token,
			...(process.env.BENCHMARK_BASE_URL ? { base_url: process.env.BENCHMARK_BASE_URL } : {}),
		});
		return parsed.success ? parsed.data : undefined;
	}
	try {
		return { ...config, token: resolveApiKey(config.token, "benchmark.token") };
	} catch (err) {
		// 评测凭据缺失不应拖垮 serve/dispatch（模型与执行控制面照常工作），
		// 只把 benchmark 集成关掉并给出可诊断的警告。
		console.warn(
			`benchmark integration disabled: ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}
