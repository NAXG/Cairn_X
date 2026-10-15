import { expect, onTestFinished, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";
import { listSkills } from "../../src/server/modules/skills.js";
import type { PluginRelease } from "../../src/contracts/plugins.js";

/** 一次性的技能目录：release.path 下按 PI 的 npm/sources 布局摆 SKILL.md。 */
function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-skills-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const write = (relative: string, body: string) => {
		const absolute = path.join(dir, relative);
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, body);
	};
	write(
		"npm/node_modules/pkg-a/skills/idapython/SKILL.md",
		"---\nname: idapython\ndescription: IDA Pro Python scripting.\n---\n\n正文\n",
	);
	write("npm/node_modules/pkg-a/skills/plain/SKILL.md", "# 没有 frontmatter\n");
	return { dir, write };
}

function release(root: string, skills: string[], enabled = true): PluginRelease {
	return {
		role: "decide",
		revision: 7,
		source: "npm:pkg-a",
		enabled,
		created_at: "2026-09-22T00:00:00Z",
		resources: { extensions: [], skills },
		packages: ["npm:pkg-a@1.0.0"],
		path: root,
	};
}

test("listSkills reads SKILL.md frontmatter and tolerates missing pieces", () => {
	const { dir } = fixture();
	const skills = listSkills(
		release(dir, [
			"npm/node_modules/pkg-a/skills/idapython/SKILL.md",
			"npm/node_modules/pkg-a/skills/plain/SKILL.md",
			"npm/node_modules/pkg-a/skills/gone/SKILL.md",
			"../../../outside/SKILL.md",
		]),
	);
	// 目录里不存在的文件与越出 release 的路径都不应出现在清单里。
	expect(skills).toHaveLength(2);
	expect(skills[0]).toMatchObject({
		name: "idapython",
		description: "IDA Pro Python scripting.",
		package: "npm:pkg-a@1.0.0",
	});
	// 没有 frontmatter 时用目录名兜底，描述留空。
	expect(skills[1]).toMatchObject({ name: "plain", description: "" });
	expect(skills.map((s) => s.path)).not.toContain("../../../outside/SKILL.md");
});

test("skills route reports the role's current release and stays empty without one", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-skills-route-"));
	const db = openDatabase(path.join(dir, "test.db"));
	const app = createApp(db, undefined, undefined, dir);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const empty = await app.request("/settings/agents/decide/skills");
	expect(empty.status).toBe(200);
	expect(await empty.json()).toMatchObject({ role: "decide", revision: null, skills: [] });

	const releaseDir = path.join(dir, "plugins", "decide", "releases", "7");
	mkdirSync(path.join(releaseDir, "npm/node_modules/pkg-a/skills/idapython"), { recursive: true });
	writeFileSync(
		path.join(releaseDir, "npm/node_modules/pkg-a/skills/idapython/SKILL.md"),
		"---\nname: idapython\ndescription: IDA Pro Python scripting.\n---\n",
	);
	db.prepare("INSERT INTO plugin_objects VALUES(?,?,?)").run(
		"current",
		"decide",
		JSON.stringify(release(releaseDir, ["npm/node_modules/pkg-a/skills/idapython/SKILL.md"])),
	);
	const listed = await app.request("/settings/agents/decide/skills");
	expect(listed.status).toBe(200);
	expect(await listed.json()).toMatchObject({
		role: "decide",
		revision: 7,
		enabled: true,
		skills: [{ name: "idapython", package: "npm:pkg-a@1.0.0" }],
	});

	// 停用后的版本不再向 Agent 暴露技能，页面也应为空。
	db.prepare(
		"INSERT INTO plugin_objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
	).run(
		"current",
		"decide",
		JSON.stringify(
			release(releaseDir, ["npm/node_modules/pkg-a/skills/idapython/SKILL.md"], false),
		),
	);
	const disabled = await app.request("/settings/agents/decide/skills");
	expect(await disabled.json()).toMatchObject({ enabled: false, skills: [] });
});
