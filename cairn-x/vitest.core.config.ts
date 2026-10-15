import { defineConfig } from "vitest/config";

/**
 * 固定核心回归集合：跑得不依赖前端构建、真实模型或 Docker。
 *
 * 完整集合见 vitest.config.ts（`npm test`）。这里显式列文件而不是用目录 glob，
 * 因为 tests/server、tests/orchestrator 里混有需要 Docker 或较长超时的用例。
 */
export default defineConfig({
	test: {
		include: [
			"tests/server/usage.test.ts",
			"tests/server/usage-backfill.test.ts",
			"tests/server/digest.test.ts",
			"tests/server/stats.test.ts",
			"tests/server/step-stats.test.ts",
			"tests/server/planning-graph.test.ts",
			"tests/web/read-cache.test.ts",
			"tests/orchestrator/heartbeat.test.ts",
			"tests/orchestrator/execution-protocol.test.ts",
			"tests/orchestrator/execution-regressions.test.ts",
			"tests/orchestrator/decide-runner.test.ts",
			"tests/orchestrator/worker-run.test.ts",
			"tests/orchestrator/worker-harvest-cancellation.test.ts",
			"tests/orchestrator/loop.test.ts",
			"tests/orchestrator/project-loop.test.ts",
			"tests/orchestrator/project-loop-lifecycle.test.ts",
			"tests/orchestrator/project-execute-runner.test.ts",
			"tests/orchestrator/healthcheck.test.ts",
		],
		// 每个 worker 都会加载 PI 运行时并启动控制服务；限制并发保证租约/取消用例稳定。
		maxWorkers: 4,
	},
});
