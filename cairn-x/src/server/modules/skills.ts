import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ConfigurationControl } from "../../control/index.js";
import type { PluginRelease } from "../../contracts/plugins.js";
import { parseValue } from "../http.js";

const roleSchema = z.enum(["decide", "execute"]);
/** SKILL.md 体积上限：只读 frontmatter 与描述，不需要读取超大文件。 */
const MAX_SKILL_BYTES = 256 * 1024;

interface SkillSummary {
	id: string;
	name: string;
	description: string;
	path: string;
	package?: string;
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。文件不是 frontmatter 开头或解析失败时返回空对象，
 * 由调用方用目录名兜底 —— 技能清单只做展示，坏文件不该让整页报错。
 */
function readFrontmatter(text: string): Record<string, unknown> {
	if (!text.startsWith("---")) return {};
	const end = text.indexOf("\n---", 3);
	if (end < 0) return {};
	try {
		const parsed = parseYaml(text.slice(3, end));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** 技能名兜底：SKILL.md 取所在目录名，其它文件取去掉扩展名的文件名。 */
function fallbackName(absolute: string): string {
	const base = path.basename(absolute);
	return base.toLowerCase() === "skill.md"
		? path.basename(path.dirname(absolute))
		: base.replace(/\.[^.]+$/, "");
}

/**
 * 技能文件来自哪个已安装包。PI 把 npm 包放在 npm/node_modules、本地目录放在 sources/，
 * 这里按这两种布局做前缀匹配；匹配不到就不标来源，不猜。
 */
function packageOf(relative: string, packages: string[]): string | undefined {
	const normalized = relative.split(path.sep).join("/");
	for (const source of packages) {
		if (source.startsWith("npm:")) {
			const spec = source.slice(4);
			const name = spec.startsWith("@")
				? spec.split("@").slice(0, 2).join("@")
				: spec.split("@")[0];
			if (name && normalized.includes(`node_modules/${name}/`)) return source;
			continue;
		}
		if (source.startsWith("./sources/")) {
			const key = source.slice("./sources/".length);
			if (key && normalized.includes(`sources/${key}/`)) return source;
		}
	}
	return undefined;
}

/**
 * 当前插件版本里可用的技能清单（只读）。条目按 release 记录的相对路径逐个读取；
 * 路径越出 release、文件不可读或不是普通文件时跳过该条，保留其余条目。
 */
export function listSkills(release: PluginRelease | undefined): SkillSummary[] {
	if (!release) return [];
	const root = path.resolve(release.path);
	let resolvedRoot: string;
	try {
		resolvedRoot = realpathSync(root);
	} catch {
		return [];
	}
	const skills: SkillSummary[] = [];
	for (const relative of release.resources?.skills ?? []) {
		if (typeof relative !== "string" || relative === "") continue;
		const absolute = path.resolve(root, relative);
		const inside = path.relative(root, absolute);
		if (inside.startsWith("..") || path.isAbsolute(inside) || inside === "") continue;
		try {
			const resolved = realpathSync(absolute);
			const resolvedInside = path.relative(resolvedRoot, resolved);
			if (
				resolvedInside.startsWith("..") ||
				path.isAbsolute(resolvedInside) ||
				resolvedInside === ""
			)
				continue;
			const stat = statSync(resolved);
			if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue;
			const frontmatter = readFrontmatter(readFileSync(resolved, "utf8"));
			const rawName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
			const rawDescription =
				typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
			const pkg = packageOf(relative, release.packages ?? []);
			const normalizedPath = relative.split(path.sep).join("/");
			skills.push({
				id: normalizedPath,
				name: rawName || fallbackName(absolute),
				description: rawDescription,
				path: normalizedPath,
				...(pkg ? { package: pkg } : {}),
			});
		} catch {
			continue;
		}
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillRoutes(control: ConfigurationControl): Hono {
	const app = new Hono();
	app.get("/settings/agents/:role/skills", (c) => {
		const role = parseValue(c.req.param("role"), roleSchema);
		const release = control.plugins.list(role);
		const enabled = release?.enabled === true && release.retiring !== true;
		return c.json({
			role,
			revision: release?.revision ?? null,
			sources: release?.packages ?? [],
			enabled,
			skills: enabled ? listSkills(release) : [],
		});
	});
	return app;
}
