import type { Command } from "commander";

import { FgsClient } from "../../orchestrator/client.js";

export function registerPluginsCommand(program: Command): void {
	program
		.command("plugins <action> [source]")
		.description("Manage independent PI plugins for Decide or Execute")
		.option("--role <role>", "plugin role", "execute")
		.option(
			"--server-url <url>",
			"Cairn server URL",
			process.env.CAIRN_SERVER_URL ?? "http://127.0.0.1:8000",
		)
		.option("--api-token <token>", "server API token", process.env.CAIRN_API_TOKEN)
		.action(
			async (
				action: string,
				source: string | undefined,
				options: { role: string; serverUrl: string; apiToken?: string },
			) => {
				if (options.role !== "decide" && options.role !== "execute")
					throw new Error("--role must be decide or execute");
				const role = options.role as "decide" | "execute";
				const client = new FgsClient(options.serverUrl, 10_000, options.apiToken);
				if (action === "list") {
					console.log(JSON.stringify(await client.listPlugins(role), null, 2));
					return;
				}
				const kind = action as "install" | "update" | "remove" | "enable" | "disable";
				if (!["install", "update", "remove", "enable", "disable"].includes(kind))
					throw new Error(`Unknown plugin action: ${action}`);
				const operation = await client.enqueuePluginOperation(role, kind, source);
				if (!operation.ok || !operation.data)
					throw new Error(`Plugin operation rejected (${operation.statusCode}): ${operation.text}`);
				console.log(`plugin operation ${operation.data.id} queued`);
				for (;;) {
					const current = await client.getPluginOperation(role, operation.data.id);
					console.log(
						`${current.status} ${current.progress ?? 0}%${current.message ? `: ${current.message}` : ""}`,
					);
					if (current.status === "succeeded") return;
					if (current.status === "failed")
						throw new Error(current.message ?? "Plugin operation failed");
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			},
		);
}
