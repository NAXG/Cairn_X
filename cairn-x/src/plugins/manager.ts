import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../contracts/configuration.js";
import type { PluginOperation } from "../contracts/plugins.js";
import { PluginStore } from "./store.js";
import { docker } from "../environments/docker.js";

function safeRole(role: AgentRole): AgentRole {
	return role === "decide" || role === "execute"
		? role
		: (() => {
				throw new Error("Invalid plugin role");
			})();
}

function copiedLocalSource(source: string): string {
	const key = source.replaceAll(/[^a-zA-Z0-9_.-]/g, "_").slice(-80);
	return `./sources/${key}`;
}

/** 打开 release 目录内的项目级包配置（本地包写在 .pi/settings.json）。 */
function openPackages(dir: string) {
	const settings = SettingsManager.create(dir, dir, { projectTrusted: true });
	const packages = new DefaultPackageManager({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
	});
	return { settings, packages };
}

/** 解析已启用、且位于 release 目录内的资源，路径相对该目录。 */
async function resolveResources(packages: DefaultPackageManager, dir: string) {
	const resolved = await packages.resolve();
	const inside = (item: { enabled: boolean; path: string }) =>
		item.enabled && item.path.startsWith(dir + path.sep);
	return {
		extensions: resolved.extensions.filter(inside).map((item) => path.relative(dir, item.path)),
		skills: resolved.skills.filter(inside).map((item) => path.relative(dir, item.path)),
	};
}

/**
 * 复制目录树时保留符号链接语义：相对链接必须保持相对，否则复制后它们指向源目录，
 * 新 release 的资源 realpath 会落在自己的版本目录之外（session 装载时抛「PI 插件
 * 资源越过版本目录」，该角色的所有活动都起不来）。
 *
 * 本地插件源与上一版 release 两处复制共用同一组选项 —— 此前各抄一遍，漏掉
 * verbatimSymlinks 的那次就是这么出问题的。
 */
const COPY_TREE_OPTIONS = {
	recursive: true,
	dereference: false,
	verbatimSymlinks: true,
} as const;

function copyDirectory(source: string, target: string): void {
	const resolved = realpathSync(source);
	const parent = realpathSync(path.dirname(source));
	if (lstatSync(source).isSymbolicLink() && !resolved.startsWith(parent + path.sep)) {
		throw new Error("本地插件路径不能通过符号链接越界");
	}
	if (!lstatSync(resolved).isDirectory()) throw new Error("本地插件路径必须是目录");
	const walk = (current: string): void => {
		for (const entry of readdirSync(current)) {
			const child = path.join(current, entry);
			const stat = lstatSync(child);
			if (stat.isSymbolicLink()) {
				if (path.isAbsolute(readlinkSync(child))) throw new Error("本地插件不能包含绝对符号链接");
				let linkTarget: string;
				try {
					linkTarget = realpathSync(child);
				} catch {
					throw new Error("本地插件包含失效的符号链接");
				}
				if (linkTarget !== resolved && !linkTarget.startsWith(resolved + path.sep))
					throw new Error("本地插件包含指向目录外的符号链接");
			} else if (stat.isDirectory()) walk(child);
		}
	};
	walk(resolved);
	cpSync(resolved, target, { ...COPY_TREE_OPTIONS, force: false });
}

export class PluginManager {
	constructor(
		private readonly dataRoot: string,
		private readonly store: PluginStore,
		private readonly workerImage?: string,
		private readonly dataHostRoot: string = dataRoot,
	) {}

	async run(operation: PluginOperation): Promise<"applied" | "deferred"> {
		const role = safeRole(operation.role);
		const root = path.join(this.dataRoot, "plugins", role);
		const releases = path.join(root, "releases");
		mkdirSync(releases, { recursive: true });
		const current = this.store.list(operation.role);
		const source = operation.source?.trim();
		const removedSource = source ?? current?.source;
		if (
			operation.kind === "remove" &&
			current &&
			removedSource &&
			!current.packages.includes(removedSource)
		)
			throw new Error(`插件来源未安装: ${removedSource}`);
		if (operation.kind === "remove" && (!current || current.packages.length === 1)) {
			const active = this.store.beginRemoval(role);
			if (active > 0) return "deferred";
			// Keep the releases mount point itself: existing project containers have this
			// directory bind-mounted and must see a later fresh installation.
			for (const entry of readdirSync(releases))
				rmSync(path.join(releases, entry), { recursive: true, force: true });
			rmSync(path.join(root, "current"), { recursive: true, force: true });
			this.store.removeCurrent(role);
			return "applied";
		}
		if (!current && operation.kind !== "install") throw new Error("没有可操作的已安装插件");
		if (current?.retiring) throw new Error("插件正在卸载");
		if (!current) {
			// store 里没有 release 记录 = 没有任何活动引用过插件（快照的 plugins 字段来自
			// current），不需要 fence。此前无条件走 beginRemoval：只要 execute 角色有在跑的
			// 执行，首次安装就会被无限期推迟（持续负载下永远装不上）。
			// A previous interrupted operation may also have left unpublished files.
			for (const entry of readdirSync(releases))
				rmSync(path.join(releases, entry), { recursive: true, force: true });
		}
		let revision = (current?.revision ?? 0) + 1;
		while (existsSync(path.join(releases, String(revision)))) revision += 1;
		const staging = path.join(releases, `.staging-${operation.id}`);
		const releaseDir = path.join(releases, String(revision));
		let packageSources = current?.packages ?? [];
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(staging, { recursive: true });
		try {
			if (current?.path && existsSync(current.path))
				// verbatimSymlinks 必须开：旧 release 里的相对链接要保持相对。默认行为会把
				// 它们解析成指向**上一版**目录的绝对路径，于是新 release 的资源 realpath
				// 落在自己的版本目录之外，session 装载时抛「PI 插件资源越过版本目录」，
				// 该角色的所有活动都起不来。与 copyDirectory 的选项保持一致。
				cpSync(current.path, staging, { ...COPY_TREE_OPTIONS, force: true });
			if (operation.kind === "enable" || operation.kind === "disable") {
				// Re-resolve resources from the copied package settings. This also repairs
				// releases produced by older versions whose resources.json contained a
				// deleted staging path.
				const { packages } = openPackages(staging);
				const resources = await resolveResources(packages, staging);
				writeFileSync(
					path.join(staging, "resources.json"),
					JSON.stringify(resources, null, 2) + "\n",
				);
			} else {
				if (!source && operation.kind !== "remove") throw new Error("插件来源不能为空");
				// Local packages live in the project-scoped .pi/settings.json. An
				// in-memory manager loses that file between immutable releases.
				let { settings, packages } = openPackages(staging);
				// Removing a package must not fall through to the install path below.
				// Keep this undefined for remove operations so a successful uninstall
				// cannot immediately reinstall the same source.
				let packageSource = operation.kind === "remove" ? undefined : source;
				if (operation.kind === "remove") {
					const target = source ?? current?.source;
					if (target) {
						const installedTarget =
							target.startsWith(".") || path.isAbsolute(target)
								? copiedLocalSource(target)
								: target;
						const local = installedTarget.startsWith("./");
						if (operation.role === "execute" && this.workerImage) {
							await this.runInWorker(
								staging,
								`await packages.removeAndPersist(${JSON.stringify(installedTarget)}, {local:${local}});`,
							);
							// Worker 容器改写了磁盘上的配置，重新打开以读取最新状态。
							({ settings, packages } = openPackages(staging));
						} else {
							await packages.removeAndPersist(installedTarget, { local });
						}
						if (local)
							rmSync(path.join(staging, installedTarget), { recursive: true, force: true });
					}
					packageSources = packageSources.filter((item) => item !== target);
				} else if (source!.startsWith(".") || source!.startsWith("/")) {
					const base = path.join(this.dataRoot, "plugin-sources", role);
					const local = path.resolve(base, source!);
					if (!local.startsWith(path.resolve(base) + path.sep) && !path.isAbsolute(source!))
						throw new Error("相对插件路径必须位于 plugin-sources 目录内");
					if (!existsSync(local)) throw new Error(`本地插件路径不存在: ${local}`);
					if (
						!path.isAbsolute(source!) &&
						!realpathSync(local).startsWith(realpathSync(base) + path.sep)
					)
						throw new Error("相对插件路径不能通过符号链接越界");
					const copied = path.join(staging, copiedLocalSource(source!));
					rmSync(copied, { recursive: true, force: true });
					mkdirSync(path.dirname(copied), { recursive: true });
					copyDirectory(local, copied);
					packageSource = copiedLocalSource(source!);
				}
				if (packageSource) {
					if (operation.role === "execute" && this.workerImage) {
						await this.runInWorker(
							staging,
							`await packages.installAndPersist(${JSON.stringify(packageSource)}, {local:${packageSource.startsWith("./")}});`,
						);
						// Worker 容器改写了磁盘上的配置，重新打开以读取最新状态。
						({ settings, packages } = openPackages(staging));
					} else {
						await packages.installAndPersist(packageSource, {
							local: packageSource.startsWith("./"),
						});
					}
				}
				if (operation.kind !== "remove" && source && !packageSources.includes(source))
					packageSources = [...packageSources, source];
				const configured = packages.listConfiguredPackages();
				const resources = await resolveResources(packages, staging);
				writeFileSync(
					path.join(staging, "settings.json"),
					JSON.stringify(settings.getGlobalSettings(), null, 2) + "\n",
				);
				writeFileSync(
					path.join(staging, "packages.json"),
					JSON.stringify(configured, null, 2) + "\n",
				);
				writeFileSync(
					path.join(staging, "resources.json"),
					JSON.stringify(resources, null, 2) + "\n",
				);
			}
			const oldManifest =
				current?.path && existsSync(path.join(current.path, "plugin.json"))
					? (JSON.parse(readFileSync(path.join(current.path, "plugin.json"), "utf8")) as Record<
							string,
							unknown
						>)
					: undefined;
			const enabled =
				operation.kind === "enable"
					? true
					: operation.kind === "disable"
						? false
						: (current?.enabled ?? true);
			const resourcesFile = path.join(staging, "resources.json");
			const resources = existsSync(resourcesFile)
				? JSON.parse(readFileSync(resourcesFile, "utf8"))
				: (oldManifest?.resources ?? { extensions: [], skills: [] });
			const relocate = (value: string) =>
				value.startsWith(staging + path.sep)
					? path.relative(releaseDir, releaseDir + value.slice(staging.length))
					: value;
			resources.extensions = resources.extensions.map(relocate);
			resources.skills = resources.skills.map(relocate);
			const previousSource = typeof oldManifest?.source === "string" ? oldManifest.source : "";
			const manifest = {
				role: operation.role,
				installation_id: current?.installation_id ?? randomUUID(),
				revision,
				source:
					packageSources.length === 0
						? ""
						: operation.kind === "remove"
							? (packageSources.at(-1) ?? "")
							: (operation.source ?? current?.source ?? previousSource),
				enabled,
				created_at: new Date().toISOString(),
				resources,
				packages: packageSources,
				path: releaseDir,
				install_platform: process.platform + "/" + process.arch,
				install_node: process.version,
				...(operation.role === "execute" && this.workerImage
					? { worker_image: this.workerImage }
					: {}),
			};
			writeFileSync(path.join(staging, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
			if (existsSync(releaseDir)) throw new Error(`插件版本目录已存在: ${releaseDir}`);
			renameSync(staging, releaseDir);
			const currentLink = path.join(root, "current");
			// Keep the link relative: in Compose the dispatcher sees /data while the
			// Docker daemon sees the host path from CAIRN_DATA_HOST_ROOT.
			const nextLink = path.join(root, `.current-${randomUUID()}`);
			try {
				symlinkSync(path.relative(root, releaseDir), nextLink, "dir");
				renameSync(nextLink, currentLink);
			} finally {
				rmSync(nextLink, { force: true });
			}
			this.store.setCurrent(operation.role, { ...manifest, path: releaseDir });
			return "applied";
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}

	private async runInWorker(staging: string, action: string): Promise<void> {
		if (!this.workerImage) throw new Error("Execute plugin worker image is not configured");
		const hostStaging = path.join(this.dataHostRoot, path.relative(this.dataRoot, staging));
		const script = [
			'import { DefaultPackageManager, SettingsManager } from "/app/node_modules/@earendil-works/pi-coding-agent/dist/index.js";',
			'const settings = SettingsManager.create("/plugin", "/plugin", { projectTrusted: true });',
			'const packages = new DefaultPackageManager({ cwd: "/plugin", agentDir: "/plugin", settingsManager: settings });',
			action,
		].join("\n");
		const result = await docker(
			[
				"run",
				"--rm",
				"--volume",
				`${hostStaging}:/plugin:rw`,
				"--workdir",
				"/plugin",
				this.workerImage,
				"node",
				"--input-type=module",
				"--eval",
				script,
			],
			10 * 60_000,
		);
		if (result.code !== 0) {
			throw new Error(`Execute 插件安装容器失败: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}
}
