import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, onTestFinished, test, vi } from "vitest";

import { startManualRun } from "../../src/regression/manual.js";
import { parseRegressionSet } from "../../src/regression/set.js";
import { readRecords } from "../../src/regression/store.js";
import { ClientError, type FgsClient } from "../../src/orchestrator/client.js";

function fixtureRoot(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-regression-manual-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("creates a manual target project, records the run, and stores stats/digest", async () => {
	const root = fixtureRoot();
	const set = parseRegressionSet({
		version: 1,
		platform: "tsecbench",
		smoke: { "b-01": { runs: 1, max_seconds: 1 } },
	});
	const fake = {
		createProject: async () => ({
			ok: true,
			data: { project: { id: "p1" } },
			text: "",
			statusCode: 201,
		}),
		createStep: async () => ({ ok: true, data: { id: "s1" }, text: "", statusCode: 201 }),
		setProjectStatus: async () => ({ ok: true, data: undefined, text: "", statusCode: 200 }),
		getProjectStats: async () => ({ project_id: "p1" }),
		getProjectDigest: async () => ({ project_id: "p1", executions: [] }),
	} as unknown as FgsClient;

	const result = await startManualRun(fake, root, set, {
		experimentId: "baseline",
		uniqueCode: "b-01",
		run: 1,
		targets: ["10.0.0.1:80"],
		// 0 不再是合法输入。用极小正数让 deadline 立刻到期；pollSeconds 也必须给
		// 极小值 —— 它被钳到最少 1s，否则循环万一进一次就要睡满（默认 5s 会直接
		// 撞上 vitest 的 5s 超时）。
		timeoutSeconds: 0.001,
		pollSeconds: 0.001,
	});
	expect(result.projectId).toBe("p1");
	expect(result.stepId).toBe("s1");
	expect(result.finished.agent_status).toBe("timeout");
	expect(result.finished.stats_file === null).toBe(false);
	expect(result.finished.digest_file === null).toBe(false);
	expect(existsSync(result.finished.stats_file ?? "")).toBe(true);
	expect(existsSync(result.finished.digest_file ?? "")).toBe(true);

	const records = readRecords(root, "baseline");
	expect(records.map((record) => record.type)).toEqual(["run_started", "run_finished"]);
	expect(records[1]).toMatchObject({
		type: "run_finished",
		unique_code: "b-01",
		run: 1,
		project_id: "p1",
		step_id: "s1",
		agent_status: "timeout",
	});
});

test.each(["completed", "step_missing"])(
	"manual runs use scoped reads when %s",
	async (scenario) => {
		const root = fixtureRoot();
		const set = parseRegressionSet({
			version: 1,
			platform: "tsecbench",
			smoke: { "b-01": { runs: 1, max_seconds: 5 } },
		});
		const record = vi.fn(async () => {
			throw new ClientError("Step not found", 404);
		});
		const state = vi.fn(async () => ({
			id: "p1",
			status: scenario === "completed" ? "completed" : "active",
		}));
		const fake = {
			createProject: async () => ({
				ok: true,
				data: { project: { id: "p1" } },
				text: "",
				statusCode: 201,
			}),
			createStep: async () => ({ ok: true, data: { id: "s1" }, text: "", statusCode: 201 }),
			getSchedulingProjectState: state,
			getRecord: record,
			getProjectStats: async () => ({ project_id: "p1" }),
			getProjectDigest: async () => ({ project_id: "p1", executions: [] }),
		} as unknown as FgsClient;
		const result = await startManualRun(fake, root, set, {
			experimentId: "scoped",
			uniqueCode: "b-01",
			run: 1,
			targets: ["10.0.0.1:80"],
			timeoutSeconds: 5,
			pollSeconds: 0.001,
		});
		expect(result.finished.agent_status).toBe(scenario === "completed" ? "concluded" : "cancelled");
		expect(state).toHaveBeenCalledWith("p1");
		if (scenario === "completed") expect(record).not.toHaveBeenCalled();
		else expect(record).toHaveBeenCalledWith("p1", "step", "s1");
	},
);
