#!/usr/bin/env tsx
import { Command } from "commander";

import { registerBenchmarkCommand } from "./cli/commands/benchmark.js";
import { registerDevCommand } from "./cli/commands/dev.js";
import { registerDigestCommand } from "./cli/commands/digest.js";
import { registerDispatchCommand } from "./cli/commands/dispatch.js";
import { registerPluginsCommand } from "./cli/commands/plugins.js";
import { registerRegressionCommand } from "./cli/commands/regression.js";
import { registerServeCommand } from "./cli/commands/serve.js";
import { consoleLogger, installCrashHandlers } from "./shared/logger.js";

const program = new Command();

program
	.name("cairn-x")
	.description("Cairn_X: FGS-based exploration orchestrator (Executor Worker architecture)")
	.hook("preAction", (_command, actionCommand) => {
		// 所有 CLI 命令共用的进程级兜底（未捕获异常 / 未处理 rejection）。
		installCrashHandlers(consoleLogger);
		// Validate resolved flag/env values before opening a DB or contacting a server.
		const options = actionCommand.opts();
		for (const [option, env] of [
			["webPassword", "CAIRN_WEB_PASSWORD"],
			["apiToken", "CAIRN_API_TOKEN"],
		] as const) {
			if (options[option]?.trim() === "cairn-change-me") {
				program.error(`${env}: insecure default credential is not allowed; set a unique secret`);
			}
		}
	});

registerPluginsCommand(program);
registerServeCommand(program);
registerDevCommand(program);
registerDispatchCommand(program);
registerBenchmarkCommand(program);
registerDigestCommand(program);
registerRegressionCommand(program);

program.parse();
