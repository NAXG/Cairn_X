import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, test } from "vitest";

import {
	ConfigError,
	dispatchConfigSchema,
	loadBenchmarkConfig,
	loadDispatchConfig,
	loadDeploymentConfig,
	workerControlUrl,
} from "../../src/scheduler/config.js";

test("Compose requires explicit nonempty credentials for every control-plane service", () => {
	const compose = YAML.parse(
		readFileSync(new URL("../../../docker-compose.yaml", import.meta.url), "utf8"),
	);
	for (const service of ["cairn-x-server", "cairn-x-dispatcher", "cairn-x-benchmark"]) {
		expect(compose.services[service].environment.CAIRN_API_TOKEN).toMatch(
			/^\$\{CAIRN_API_TOKEN:\?.+\}$/,
		);
	}
	expect(compose.services["cairn-x-server"].environment.CAIRN_WEB_PASSWORD).toMatch(
		/^\$\{CAIRN_WEB_PASSWORD:\?.+\}$/,
	);
	expect(JSON.stringify(compose)).not.toContain("cairn-change-me");
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "cairn-x-config-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.CFG_TEST_KEY;
});
test("loadBenchmarkConfig loads server + benchmark without model credentials", () => {
	const file = writeConfig(
		[
			'server: "http://cairn-x-server:8000"',
			"models:",
			"  decide:",
			"    model_id: x",
			'    base_url: "https://api.deepseek.com/anthropic"',
			"    api: anthropic-messages",
			'    api_key: "env:NO_SUCH_MODEL_KEY"',
			"  execute:",
			"    model_id: x",
			'    base_url: "https://api.deepseek.com/anthropic"',
			"    api: anthropic-messages",
			'    api_key: "env:NO_SUCH_MODEL_KEY"',
			"benchmark:",
			'  token: "env:CFG_BENCH_TOKEN"',
		].join("\n"),
	);
	process.env.CFG_BENCH_TOKEN = "bm-token";
	try {
		const config = loadBenchmarkConfig(file);
		expect(config.server).toBe("http://cairn-x-server:8000");
		expect(config.benchmark?.token).toBe("bm-token");
		expect(config.benchmark?.max_active).toBe(3);
	} finally {
		delete process.env.CFG_BENCH_TOKEN;
	}
});

test("loadBenchmarkConfig falls back to BENCHMARK_TOKEN in the environment", () => {
	const file = writeConfig('server: "http://s:8000"\n' + MODELS);
	process.env.BENCHMARK_TOKEN = "env-token";
	try {
		const config = loadBenchmarkConfig(file);
		expect(config.benchmark?.token).toBe("env-token");
	} finally {
		delete process.env.BENCHMARK_TOKEN;
	}
});

function writeConfig(content: string): string {
	const file = path.join(dir, "dispatch.yaml");
	writeFileSync(file, content);
	return file;
}

const MODELS = `
models:
  decide:
    model_id: "deepseek-v4-pro"
    base_url: "https://api.deepseek.com/anthropic"
    api: "anthropic-messages"
    api_key: "sk-plain"
  execute:
    model_id: "deepseek-v4-pro"
    base_url: "https://api.deepseek.com/anthropic"
    api: "anthropic-messages"
    api_key: "sk-plain-2"
`;

test("deployment config needs no models and ignores obsolete runtime values and missing model keys", () => {
	const minimal = loadDeploymentConfig(writeConfig('server: "http://localhost:8000"'));
	expect(minimal.tasks.execute).toEqual({ bash_timeout: 300 });
	expect(minimal.runtime).not.toHaveProperty("max_workers");
	const deployed = loadDeploymentConfig(
		writeConfig(`
server: "http://localhost:8000"
${MODELS.replaceAll('"sk-plain"', '"env:NO_SUCH_MODEL_KEY"')}
runtime:
  interval: 2
  max_workers: invalid-obsolete-value
  max_project_workers: 999
tasks:
  execute:
    step_timeout: invalid-obsolete-value
    harvest_timeout: -1
    bash_timeout: 30
`),
	);
	expect(deployed).not.toHaveProperty("models");
	expect(deployed.runtime.interval).toBe(2);
	expect(deployed.runtime).not.toHaveProperty("max_project_workers");
	expect(deployed.tasks.execute).toEqual({ bash_timeout: 30 });
	expect(() => loadDeploymentConfig(writeConfig("server: x\ncontainer:\n  cpus: -1"))).toThrow(
		ConfigError,
	);
});

describe("loadDispatchConfig", () => {
	it("loads a full container-mode config", () => {
		process.env.CFG_TEST_KEY = "sk-from-env";
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
runtime:
  execution: container
  interval: 2
  max_workers: 4
  max_running_projects: 2
  max_project_workers: 3
  decide_min_interval: 15
  endpoint_cooldown: 8
models:
  decide:
    model_id: "deepseek-v4-pro"
    base_url: "https://api.deepseek.com/anthropic"
    api: "anthropic-messages"
    api_key: "env:CFG_TEST_KEY"
    context_window: 262144
  execute:
    model_id: "gpt-x"
    base_url: "https://api.openai.com/v1"
    api: "openai-responses"
    api_key: "sk-plain"
container:
  image: "cairn-x-worker:latest"
  network: "cairn-workers"
  cpus: 4
  memory_mb: 4096
tasks:
  execute:
    step_timeout: 60
    harvest_timeout: 90
healthcheck:
  timeout: 5
`);
		const config = loadDispatchConfig(file);
		expect(config.server).toBe("http://127.0.0.1:8000");
		expect(config.runtime).toEqual({
			interval: 2,
			max_workers: 4,
			max_running_projects: 2,
			max_project_workers: 3,
			decide_min_interval: 15,
			endpoint_cooldown: 8,
			endpoint_unhealthy_threshold: 3,
		});
		expect(config.models.decide.api_key).toBe("sk-from-env");
		expect(config.models.decide.context_window).toBe(262144);
		expect(config.models.execute.api_key).toBe("sk-plain");
		expect(config.models.execute.api).toBe("openai-responses");
		expect(config.container).toEqual({
			image: "cairn-x-worker:latest",
			network: "cairn-workers",
			cpus: 4,
			memory_mb: 4096,
			pids_limit: 512,
			stop_grace_seconds: 20,
			auto_remove: false,
			project_idle_seconds: 600,
		});
		expect(config.tasks.execute.step_timeout).toBe(60);
		expect(config.tasks.execute.harvest_timeout).toBe(90);
		expect(config.healthcheck.timeout).toBe(5);
	});

	it("applies defaults for a minimal config", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
${MODELS}`);
		const config = loadDispatchConfig(file);
		expect(config.runtime).toEqual({
			interval: 3,
			max_workers: 9,
			max_running_projects: 3,
			max_project_workers: 3,
			decide_min_interval: 10,
			endpoint_cooldown: 5,
			endpoint_unhealthy_threshold: 3,
		});
		expect(config.tasks.execute.step_timeout).toBe(1200);
		expect(config.tasks.execute.harvest_timeout).toBe(180);
		expect(config.healthcheck.timeout).toBe(20);
		expect(config.container.image).toBeTypeOf("string");
		expect(config.container.network).toBe("cairn-workers");
	});

	it("errors when the env: variable is not set, without leaking anything", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
models:
  decide:
    model_id: "m"
    base_url: "https://example.com"
    api: "openai-completions"
    api_key: "env:CFG_TEST_KEY"
  execute:
    model_id: "m"
    base_url: "https://example.com"
    api: "openai-completions"
    api_key: "sk-x"
`);
		expect(() => loadDispatchConfig(file)).toThrowError(
			/models\.decide\.api_key: environment variable CFG_TEST_KEY is not set/,
		);
	});

	it("applies container defaults", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
container:
  image: "img"
${MODELS}`);
		const config = loadDispatchConfig(file);
		expect(config.container.network).toBe("cairn-workers");
		expect(config.container.cpus).toBe(2);
		expect(config.container.memory_mb).toBe(2048);
		expect(config.container.pids_limit).toBe(512);
		expect(config.container.stop_grace_seconds).toBe(20);
	});

	it("rejects max_project_workers above max_workers", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
runtime:
  max_workers: 2
  max_project_workers: 3
${MODELS}`);
		expect(() => loadDispatchConfig(file)).toThrowError(
			/max_project_workers cannot exceed max_workers/,
		);
	});

	it("rejects unknown api values", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
runtime:
models:
  decide:
    model_id: "m"
    base_url: "https://example.com"
    api: "grpc"
    api_key: "sk-x"
  execute:
    model_id: "m"
    base_url: "https://example.com"
    api: "openai-completions"
    api_key: "sk-x"
`);
		expect(() => loadDispatchConfig(file)).toThrowError(/models\.decide\.api/);
	});

	it("does not leak api keys into validation errors", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
runtime:
  max_workers: 0
models:
  decide:
    model_id: "m"
    base_url: "https://example.com"
    api: "openai-completions"
    api_key: "sk-super-secret-value"
  execute:
    model_id: "m"
    base_url: "https://example.com"
    api: "openai-completions"
    api_key: "sk-super-secret-value"
`);
		let message = "";
		try {
			loadDispatchConfig(file);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("max_workers");
		expect(message).not.toContain("sk-super-secret-value");
	});

	it("parses the optional compaction section", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
runtime: {}
${MODELS}
compaction:
  reserve_tokens: 565000
  keep_recent_tokens: 40000
`);
		const config = loadDispatchConfig(file);
		expect(config.compaction).toEqual({ reserve_tokens: 565000, keep_recent_tokens: 40000 });
	});

	it("leaves compaction undefined when the section is absent", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
runtime: {}
${MODELS}`);
		expect(loadDispatchConfig(file).compaction).toBeUndefined();
	});

	it("rejects missing models", () => {
		const file = writeConfig(`
server: "http://127.0.0.1:8000"
runtime:
`);
		expect(() => loadDispatchConfig(file)).toThrowError(ConfigError);
	});

	it("reports unreadable files, invalid YAML and non-mapping configs", () => {
		expect(() => loadDispatchConfig(path.join(dir, "nope.yaml"))).toThrowError(
			/cannot read config file/,
		);
		expect(() => loadDispatchConfig(writeConfig("server: [unclosed"))).toThrowError(/invalid YAML/);
		expect(() => loadDispatchConfig(writeConfig("- just\n- a\n- list\n"))).toThrowError(
			/must be a YAML mapping/,
		);
	});
});

test("worker control URL derives from the server host, not a hardcoded host.docker.internal", () => {
	const config = (over: Record<string, unknown>) =>
		dispatchConfigSchema.parse({
			server: "http://cairn-x-server:8000",
			models: {
				decide: {
					model_id: "m",
					base_url: "http://x.example",
					api: "openai-completions",
					api_key: "k",
				},
				execute: {
					model_id: "m",
					base_url: "http://x.example",
					api: "openai-completions",
					api_key: "k",
				},
			},
			container: over,
		});
	// compose 部署：server 是服务别名，Worker 必须原样使用。
	expect(workerControlUrl(config({}))).toBe("http://cairn-x-server:8000/");
	// host 部署：server 是宿主 loopback，容器内要换成 host.docker.internal。
	expect(workerControlUrl({ ...config({}), server: "http://127.0.0.1:8000" })).toBe(
		"http://host.docker.internal:8000/",
	);
	expect(workerControlUrl({ ...config({}), server: "http://localhost:9001" })).toBe(
		"http://host.docker.internal:9001/",
	);
	expect(workerControlUrl({ ...config({}), server: "https://controller.example:443" })).toBe(
		"https://controller.example:443/",
	);
	expect(workerControlUrl({ ...config({}), server: "http://[2001:db8::1]:8000" })).toBe(
		"http://[2001:db8::1]:8000/",
	);
	expect(workerControlUrl({ ...config({}), server: "https://[::1]" })).toBe(
		"https://host.docker.internal:443/",
	);
	// 显式配置始终优先。
	expect(workerControlUrl(config({ worker_control_url: "http://custom:1234" }))).toBe(
		"http://custom:1234",
	);
});

test("worker container config rejects invalid values", () => {
	const mk = (over: Record<string, unknown>) => {
		const schema = dispatchConfigSchema;
		const parsed = schema.safeParse({
			server: "http://x",
			models: {
				decide: {
					model_id: "m",
					base_url: "http://x.example",
					api: "openai-completions",
					api_key: "k",
				},
				execute: {
					model_id: "m",
					base_url: "http://x.example",
					api: "openai-completions",
					api_key: "k",
				},
			},
			container: { image: "i", ...over },
		});
		return parsed;
	};
	expect(mk({}).success).toBe(true);
	expect(mk({ network: "workers-net" }).success).toBe(true);
	expect(mk({ cpus: 0 }).success).toBe(false);
	expect(mk({ memory_mb: -1 }).success).toBe(false);
	expect(mk({ pids_limit: 1.5 }).success).toBe(false);
});
