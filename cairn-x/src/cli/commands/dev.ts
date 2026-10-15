import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

/** CLI 入口（`src/cli.ts`）：dev 用它拉起独立的 serve / dispatch 子进程。 */
const CLI_ENTRY = fileURLToPath(new URL("../../cli.ts", import.meta.url));

export function registerDevCommand(program: Command): void {
	program
		.command("dev")
		.description("Run an isolated local Server + Dispatcher pair")
		.option("--config <path>", "dispatch config file", "dispatch.yaml")
		.option(
			"--data-root <path>",
			"isolated development data directory",
			process.env.CAIRN_DEV_DATA_ROOT ?? path.resolve("datas/cairn-x-dev"),
		)
		.option("--db-path <path>", "development database path")
		.option("--host <host>", "server bind host", "0.0.0.0")
		.option("--port <port>", "server port", "18000")
		.option("--web-user <user>", "web console username", process.env.CAIRN_WEB_USER ?? "admin")
		.option("--web-password <password>", "web console password", process.env.CAIRN_WEB_PASSWORD)
		.option("--api-token <token>", "machine API token", process.env.CAIRN_API_TOKEN)
		.option("--data-host-root <path>", "Docker host path for development data")
		.option("--worker-control-url <url>", "Worker URL override")
		.option("--container-prefix <prefix>", "development Worker container prefix", "cairn-dev-pw-")
		.option("--import-config", "seed a fresh development database from YAML", false)
		.action(
			async (options: {
				config: string;
				dataRoot: string;
				dbPath?: string;
				host: string;
				port: string;
				webUser: string;
				webPassword?: string;
				apiToken?: string;
				dataHostRoot?: string;
				workerControlUrl?: string;
				containerPrefix: string;
				importConfig: boolean;
			}) => {
				await runDevMode(options);
			},
		);
}

interface DevModeOptions {
	config: string;
	dataRoot: string;
	dbPath?: string;
	host: string;
	port: string;
	webUser: string;
	webPassword?: string;
	apiToken?: string;
	dataHostRoot?: string;
	workerControlUrl?: string;
	containerPrefix: string;
	importConfig: boolean;
}

function devChildArgs(command: "serve" | "dispatch", args: string[]): string[] {
	return [CLI_ENTRY, command, ...args];
}

function spawnDevChild(
	label: string,
	command: "serve" | "dispatch",
	args: string[],
	envOverrides: Record<string, string | undefined> = {},
): ChildProcess {
	const child = spawn(process.execPath, ["--import", "tsx", ...devChildArgs(command, args)], {
		cwd: path.dirname(CLI_ENTRY),
		env: { ...process.env, ...envOverrides },
		stdio: ["inherit", "pipe", "pipe", "ipc"],
	});
	child.stdout?.on("data", (data: Buffer) => process.stdout.write(`[${label}] ${data}`));
	child.stderr?.on("data", (data: Buffer) => process.stderr.write(`[${label}] ${data}`));
	return child;
}

function childExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

async function runDevMode(options: DevModeOptions): Promise<void> {
	if (!options.webPassword?.trim() || !options.apiToken?.trim()) {
		throw new Error(
			"dev requires --web-password/CAIRN_WEB_PASSWORD and --api-token/CAIRN_API_TOKEN",
		);
	}
	const config = path.resolve(options.config);
	const dataRoot = path.resolve(options.dataRoot);
	const dbPath = path.resolve(options.dbPath ?? path.join(dataRoot, "cairn.db"));
	const dataHostRoot = path.resolve(options.dataHostRoot ?? dataRoot);
	const port = Number(options.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`invalid dev port: ${options.port}`);
	const workerControlUrl = options.workerControlUrl ?? `http://host.docker.internal:${port}`;
	const serverUrl = `http://127.0.0.1:${port}`;
	const common = ["--config", config, "--data-root", dataRoot, "--data-host-root", dataHostRoot];
	const serverArgs = [
		"--host",
		options.host,
		"--port",
		String(port),
		"--db-path",
		dbPath,
		"--data-root",
		dataRoot,
		"--web-user",
		options.webUser,
		"--config",
		config,
		"--worker-control-url",
		workerControlUrl,
		...(options.importConfig ? ["--import-config"] : []),
	];
	const dispatchArgs = [
		...common,
		"--server-url",
		serverUrl,
		"--worker-control-url",
		workerControlUrl,
		"--container-prefix",
		options.containerPrefix,
	];

	const childCredentials = {
		CAIRN_WEB_USER: options.webUser,
		CAIRN_WEB_PASSWORD: options.webPassword,
		CAIRN_API_TOKEN: options.apiToken,
	};
	const server = spawnDevChild("server", "serve", serverArgs, childCredentials);
	let dispatcher: ChildProcess | undefined;
	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		const waitOrTimeout = (child: ChildProcess) =>
			Promise.race([childExit(child), new Promise((resolve) => setTimeout(resolve, 30_000))]);
		// Dispatcher owns Worker cancellation and cleanup; give it the first chance
		// to finish before closing the Server it reports to.
		if (dispatcher?.exitCode === null) {
			dispatcher.kill("SIGTERM");
			await waitOrTimeout(dispatcher);
		}
		if (server.exitCode === null) {
			server.kill("SIGTERM");
			await waitOrTimeout(server);
		}
		for (const child of [server, ...(dispatcher === undefined ? [] : [dispatcher])]) {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	};
	const signalHandler = () => {
		void stop().then(() => process.exit(0));
	};
	process.on("SIGINT", signalHandler);
	process.on("SIGTERM", signalHandler);
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("dev server did not become ready within 30 seconds")),
			30_000,
		);
		server.on("message", (message: unknown) => {
			if (
				typeof message === "object" &&
				message !== null &&
				(message as { type?: string }).type === "ready"
			) {
				clearTimeout(timer);
				resolve();
			}
		});
		server.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`dev server exited before ready (code=${code ?? "signal"})`));
		});
	});
	try {
		await ready;
		if (stopping) return;
		dispatcher = spawnDevChild("dispatcher", "dispatch", dispatchArgs, childCredentials);
		const first = await Promise.race([childExit(server), childExit(dispatcher)]);
		if (!stopping) {
			console.error(
				`dev ${first.signal ? `received ${first.signal}` : `child exited with code ${first.code ?? 1}`}; stopping the other service`,
			);
			await stop();
			process.exitCode = first.code ?? 1;
		}
	} finally {
		if (!stopping) await stop();
		process.off("SIGINT", signalHandler);
		process.off("SIGTERM", signalHandler);
	}
}
