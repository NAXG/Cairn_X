import { expect, test } from "vitest";

import { dispatchConfigSchema } from "../../src/scheduler/config.js";
import {
	containerNameForProject,
	PROJECT_CONTAINER_PREFIX,
	projectWorkerContainerArgs,
	type ExecutionContainerConfig,
	type ProjectWorkerSpec,
} from "../../src/environments/execution-manager.js";
import { containerNameForProject as launcherContainerNameForProject } from "../../src/scheduler/launcher.js";

const baseConfig: ExecutionContainerConfig = {
	image: "cairn-x-worker:test",
	network: "cairn-workers",
	controlUrl: "http://server:8000/",
	dataRoot: "/tmp/cairn",
	dataHostRoot: "/tmp/cairn",
	resources: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
	stopGraceSeconds: 20,
	autoRemove: false,
};

function spec(overrides: Partial<ProjectWorkerSpec> = {}): ProjectWorkerSpec {
	return {
		projectId: "p001",
		projectToken: "tok-secret",
		concurrency: 4,
		uploadsDirectory: "/tmp/cairn/uploads/p001",
		...overrides,
	};
}

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

test("project container names are deterministic and docker-safe", () => {
	expect(PROJECT_CONTAINER_PREFIX).toBe("cairn-pw-");
	expect(containerNameForProject("p001")).toBe("cairn-pw-p001");
	expect(containerNameForProject("a/b c")).toBe("cairn-pw-a-b-c");
	expect(containerNameForProject("", "test-pw-")).toBe("test-pw-project");
	expect(launcherContainerNameForProject("p001")).toBe("cairn-pw-p001");
	// 超长项目 id 截断，避免超出 Docker 名称上限。
	expect(containerNameForProject("x".repeat(200)).length).toBe(
		PROJECT_CONTAINER_PREFIX.length + 96,
	);
});

test("project container args inject project mode env and fixed container resources", () => {
	const args = projectWorkerContainerArgs(baseConfig, spec(), "cairn-pw-p001");
	expect(args[0]).toBe("run");
	// auto_remove=false 时不加 --rm，保留退出容器用于诊断。
	expect(args).toContain("--init");
	expect(args).not.toContain("--rm");
	expect(valueAfter(args, "--name")).toBe("cairn-pw-p001");
	expect(valueAfter(args, "--network")).toBe("cairn-workers");
	expect(valueAfter(args, "--cpus")).toBe("2");
	expect(valueAfter(args, "--memory")).toBe("2048m");
	expect(valueAfter(args, "--pids-limit")).toBe("512");
	expect(args.filter((a) => a.startsWith("CAIRN_"))).toEqual([
		"CAIRN_CONTROL_URL=http://server:8000/",
		"CAIRN_PROJECT_ID=p001",
		"CAIRN_PROJECT_TOKEN=tok-secret",
		"CAIRN_PROJECT_CONCURRENCY=4",
	]);
	expect(args).toContain("/tmp/cairn/uploads/p001:/workspace/uploads:ro");
	expect(args).toContain(
		"/tmp/cairn/plugins/execute/releases:/workspace/plugins/execute/releases:ro",
	);
	expect(args).toContain("no-new-privileges");
	// Kali 的 nmap 等二进制带 file capabilities，容器 bounding set 必须覆盖它们，
	// 否则 execve 直接 EPERM（exec /usr/lib/nmap/nmap: operation not permitted）。
	expect(args.filter((_a, i) => args[i - 1] === "--cap-add")).toEqual([
		"NET_RAW",
		"NET_ADMIN",
		"NET_BIND_SERVICE",
	]);
	expect(args.at(-1)).toBe("cairn-x-worker:test");
});

test("project container args keep configured resources when concurrency is two", () => {
	const args = projectWorkerContainerArgs(
		{ ...baseConfig, autoRemove: true, resources: { cpus: 3, memoryMb: 1024, pidsLimit: 100 } },
		spec({ concurrency: 2 }),
		"cairn-pw-p001",
	);
	expect(args).toContain("--rm");
	// 一个项目容器的总资源固定为 dispatch.yaml 的 container 段，不随内部 step 并发变化。
	expect(valueAfter(args, "--cpus")).toBe("3");
	expect(valueAfter(args, "--memory")).toBe("1024m");
	expect(valueAfter(args, "--pids-limit")).toBe("100");
});

test("container idle timeout defaults to 600s and can be overridden", () => {
	const parsed = dispatchConfigSchema.parse({
		server: "http://s:8000",
		models: {
			decide: {
				model_id: "m",
				base_url: "http://x",
				api: "openai-completions",
				api_key: "sk-x",
			},
			execute: {
				model_id: "m",
				base_url: "http://x",
				api: "openai-completions",
				api_key: "sk-x",
			},
		},
	});

	expect(parsed.container.project_idle_seconds).toBe(600);

	const on = dispatchConfigSchema.parse({
		server: "http://s:8000",
		container: { project_idle_seconds: 120 },
		models: {
			decide: {
				model_id: "m",
				base_url: "http://x",
				api: "openai-completions",
				api_key: "sk-x",
			},
			execute: {
				model_id: "m",
				base_url: "http://x",
				api: "openai-completions",
				api_key: "sk-x",
			},
		},
	});

	expect(on.container.project_idle_seconds).toBe(120);
});
