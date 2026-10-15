import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, onTestFinished, test } from "vitest";

import {
	loadRegressionSet,
	parseRegressionSet,
	RegressionSetError,
} from "../../src/regression/set.js";

function fixtureFile(content: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-regression-set-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "regression-set.yaml");
	writeFileSync(file, content, "utf8");
	return file;
}

test("loads a fixed regression set with smoke, regression and holdout sections", () => {
	const file = fixtureFile(
		[
			"version: 1",
			"platform: tsecbench",
			"smoke:",
			"  b-01:",
			"    runs: 1",
			"    max_seconds: 1800",
			"regression:",
			"  b-02:",
			"    runs: 3",
			"    max_seconds: 2400",
			"holdout:",
			"  b-10:",
			"    runs: 1",
		].join("\n"),
	);
	const set = loadRegressionSet(file);
	expect(set.version).toBe(1);
	expect(set.platform).toBe("tsecbench");
	expect(set.cases).toHaveLength(3);
	expect(set.cases.find((item) => item.unique_code === "b-02")).toMatchObject({
		section: "regression",
		runs: 3,
		max_seconds: 2400,
	});
});

test("rejects unknown versions and missing platform", () => {
	expect(() => parseRegressionSet({ version: 2, platform: "tsecbench" })).toThrowError(
		RegressionSetError,
	);
	expect(() => parseRegressionSet({ version: 1 })).toThrowError(RegressionSetError);
});
