import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

type RegressionSection = "smoke" | "regression" | "holdout";

export interface RegressionCase {
	unique_code: string;
	section: RegressionSection;
	runs: number;
	max_seconds: number;
}

export interface RegressionSet {
	version: 1;
	platform: "tsecbench";
	cases: RegressionCase[];
}

export class RegressionSetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegressionSetError";
	}
}

const caseSchema = z.object({
	runs: z.number().int().positive().default(1),
	max_seconds: z.number().positive().default(1800),
});

const setSchema = z.object({
	version: z.literal(1),
	platform: z.literal("tsecbench"),
	smoke: z.record(z.string(), caseSchema).default({}),
	regression: z.record(z.string(), caseSchema).default({}),
	holdout: z.record(z.string(), caseSchema).default({}),
});

function sectionCases(
	section: RegressionSection,
	cases: Record<string, z.infer<typeof caseSchema>>,
): RegressionCase[] {
	return Object.entries(cases).map(([uniqueCode, config]) => ({
		unique_code: uniqueCode,
		section,
		runs: config.runs,
		max_seconds: config.max_seconds,
	}));
}

export function parseRegressionSet(raw: unknown): RegressionSet {
	const parsed = setSchema.safeParse(raw);
	if (parsed.success === false) {
		throw new RegressionSetError(
			parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "),
		);
	}
	const cases = [
		...sectionCases("smoke", parsed.data.smoke),
		...sectionCases("regression", parsed.data.regression),
		...sectionCases("holdout", parsed.data.holdout),
	];
	const seen = new Set<string>();
	for (const item of cases) {
		if (seen.has(item.unique_code))
			throw new RegressionSetError(`duplicate challenge code: ${item.unique_code}`);
		seen.add(item.unique_code);
	}
	return {
		version: 1,
		platform: "tsecbench",
		cases,
	};
}

export function loadRegressionSet(path: string): RegressionSet {
	let raw: unknown;
	try {
		raw = parseYaml(readFileSync(path, "utf8"));
	} catch (err) {
		throw new RegressionSetError(
			"failed to read regression set " +
				path +
				": " +
				(err instanceof Error ? err.message : String(err)),
		);
	}
	return parseRegressionSet(raw);
}

export function findRegressionCase(set: RegressionSet, uniqueCode: string): RegressionCase {
	const item = set.cases.find((candidate) => candidate.unique_code === uniqueCode);
	if (item === undefined) {
		throw new RegressionSetError("unknown regression case: " + uniqueCode);
	}
	return item;
}
