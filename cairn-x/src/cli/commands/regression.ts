import path from "node:path";

import type { Command } from "commander";

import { FgsClient } from "../../orchestrator/client.js";
import { recordManualResult, startManualRun } from "../../regression/manual.js";
import { loadExperimentMetrics, writeExperimentMetrics } from "../../regression/report.js";
import { loadRegressionSet } from "../../regression/set.js";

export function registerRegressionCommand(program: Command): void {
	const regression = program
		.command("regression")
		.description("Human-in-the-loop TSecBench regression ledger (manual remote targets)");

	regression
		.command("run")
		.description("Create a Cairn project for one manually prepared remote target")
		.requiredOption("--experiment <id>", "experiment id, e.g. baseline or prompt-v2")
		.option("--set <path>", "regression set YAML", "regression-set.yaml")
		.requiredOption("--case <code>", "TSecBench unique_code / regression case id")
		.option("--run <n>", "run number", "1")
		.requiredOption("--server <url>", "Cairn server base URL")
		.option("--api-token <token>", "Cairn API token", process.env.CAIRN_API_TOKEN)
		.requiredOption("--target <targets>", "remote target address(es), comma-separated")
		.option("--title <title>", "project title override")
		.option("--goal <goal>", "project goal / executor step description override")
		.option("--description <text>", "challenge description copied from the platform")
		.option("--flag-format <format>", "flag format hint")
		.option("--harness-variant <id>", "harness variant metadata")
		.option("--timeout <seconds>", "manual run timeout; defaults to the case max_seconds")
		.option("--poll <seconds>", "polling interval", "5")
		.option("--experiments-dir <path>", "experiment output directory", "experiments")
		.action(
			async (options: {
				experiment: string;
				set: string;
				case: string;
				run: string;
				server: string;
				apiToken?: string;
				target: string;
				title?: string;
				goal?: string;
				description?: string;
				flagFormat?: string;
				harnessVariant?: string;
				timeout?: string;
				poll: string;
				experimentsDir: string;
			}) => {
				try {
					const set = loadRegressionSet(options.set);
					const client = new FgsClient(options.server, 20_000, options.apiToken);
					const result = await startManualRun(client, path.resolve(options.experimentsDir), set, {
						experimentId: options.experiment,
						uniqueCode: options.case,
						run: Number(options.run),
						targets: options.target.split(","),
						title: options.title,
						goal: options.goal,
						description: options.description,
						flagFormat: options.flagFormat,
						harnessVariant: options.harnessVariant,
						timeoutSeconds: options.timeout === undefined ? undefined : Number(options.timeout),
						pollSeconds: Number(options.poll),
					});
					console.log(
						"project=" +
							result.projectId +
							" step=" +
							result.stepId +
							" agent_status=" +
							result.finished.agent_status +
							" seconds=" +
							result.finished.seconds,
					);
					if (result.finished.stats_file !== null)
						console.log("stats=" + result.finished.stats_file);
					if (result.finished.digest_file !== null)
						console.log("digest=" + result.finished.digest_file);
					console.log(
						"after manual platform submission:\n" +
							"  npm run cli -- regression record --experiment " +
							options.experiment +
							" --case " +
							options.case +
							" --run " +
							options.run +
							" --status solved",
					);
				} catch (err) {
					console.error(err instanceof Error ? err.message : String(err));
					process.exitCode = 1;
				}
			},
		);

	regression
		.command("record")
		.description("Record the human platform outcome for one manual run")
		.requiredOption("--experiment <id>", "experiment id")
		.requiredOption("--case <code>", "TSecBench unique_code / regression case id")
		.requiredOption("--run <n>", "run number")
		.requiredOption("--status <status>", "solved | failed | timeout | skipped")
		.option("--flags-correct <n>", "correct flag count reported by the platform")
		.option("--flags-total <n>", "total flag count reported by the platform")
		.option("--hints-used", "whether platform hints were used")
		.option("--notes <text>", "free-form notes")
		.option("--experiments-dir <path>", "experiment output directory", "experiments")
		.action(
			(options: {
				experiment: string;
				case: string;
				run: string;
				status: "solved" | "failed" | "timeout" | "skipped";
				flagsCorrect?: string;
				flagsTotal?: string;
				hintsUsed?: boolean;
				notes?: string;
				experimentsDir: string;
			}) => {
				try {
					const record = recordManualResult(path.resolve(options.experimentsDir), {
						experimentId: options.experiment,
						uniqueCode: options.case,
						run: Number(options.run),
						result: options.status,
						flagsCorrect:
							options.flagsCorrect === undefined ? undefined : Number(options.flagsCorrect),
						flagsTotal: options.flagsTotal === undefined ? undefined : Number(options.flagsTotal),
						hintsUsed: options.hintsUsed,
						notes: options.notes,
					});
					console.log(JSON.stringify(record));
				} catch (err) {
					console.error(err instanceof Error ? err.message : String(err));
					process.exitCode = 1;
				}
			},
		);

	regression
		.command("report")
		.description("Aggregate manual run results into metrics.json and per_challenge.jsonl")
		.requiredOption("--experiment <id>", "experiment id")
		.option("--set <path>", "regression set YAML", "regression-set.yaml")
		.option("--experiments-dir <path>", "experiment output directory", "experiments")
		.action((options: { experiment: string; set: string; experimentsDir: string }) => {
			try {
				const root = path.resolve(options.experimentsDir);
				const set = loadRegressionSet(options.set);
				const metrics = loadExperimentMetrics(set, root, options.experiment);
				const files = writeExperimentMetrics(root, options.experiment, metrics);
				console.log(JSON.stringify({ summary: metrics.summary, files }, null, 2));
			} catch (err) {
				console.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		});
}
