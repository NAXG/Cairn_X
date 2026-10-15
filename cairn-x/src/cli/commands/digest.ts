import { writeFileSync } from "node:fs";
import path from "node:path";

import type { Command } from "commander";

import { buildExecutionDigest, buildProjectDigest } from "../../server/core/digest.js";
import { openDatabase } from "../../server/db.js";

export function registerDigestCommand(program: Command): void {
	program
		.command("digest")
		.description("Offline Trace Digester: classify executions and emit structured diagnosis")
		.option(
			"--db-path <path>",
			"SQLite database path",
			process.env.CAIRN_DB_PATH ?? "datas/cairn-x/cairn.db",
		)
		.requiredOption("--project <id>", "project id")
		.option("--execution <id>", "only digest one execution id")
		.option("--limit <n>", "max executions in a project digest", "200")
		.option("--event-limit <n>", "max trace events parsed per execution", "20000")
		.option("--out <path>", "write JSON to this path instead of stdout")
		.action(
			(options: {
				dbPath: string;
				project: string;
				execution?: string;
				limit: string;
				eventLimit: string;
				out?: string;
			}) => {
				const db = openDatabase(path.resolve(options.dbPath));
				try {
					const eventLimit = Number(options.eventLimit);
					const limit = Number(options.limit);
					if (
						!Number.isSafeInteger(eventLimit) ||
						eventLimit < 1 ||
						!Number.isSafeInteger(limit) ||
						limit < 1
					)
						throw new Error("--limit and --event-limit must be positive integers");
					const digest =
						options.execution === undefined
							? buildProjectDigest(db, options.project, {
									limit,
									event_limit: eventLimit,
								})
							: buildExecutionDigest(db, options.project, options.execution, {
									event_limit: eventLimit,
								});
					const text = JSON.stringify(digest, null, 2) + "\n";
					if (options.out === undefined) process.stdout.write(text);
					else writeFileSync(path.resolve(options.out), text);
				} catch (err) {
					console.error(err instanceof Error ? err.message : String(err));
					process.exitCode = 1;
				} finally {
					db.close();
				}
			},
		);
}
