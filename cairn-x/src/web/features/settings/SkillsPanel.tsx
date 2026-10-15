import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AgentRole } from "../../../contracts/configuration";
import { roleName } from "../../labels";

type SkillSummary = {
	id: string;
	name: string;
	description: string;
	path: string;
	package?: string;
};

type SkillsResponse = {
	role: AgentRole;
	revision: number | null;
	sources: string[];
	enabled: boolean;
	skills: SkillSummary[];
};

/**
 * 技能页是只读视图：技能随插件版本发布，安装与启停都在插件页完成。
 * 这里只展示 PI 解析出的资源路径、frontmatter 名称与描述。
 */
export function SkillsPanel({ role }: { role: AgentRole }) {
	const [data, setData] = useState<SkillsResponse | null>(null);
	const [error, setError] = useState("");
	const [selected, setSelected] = useState("");
	useEffect(() => {
		let cancelled = false;
		setData(null);
		setError("");
		void api<SkillsResponse>(`/settings/agents/${role}/skills`)
			.then((value) => {
				if (cancelled) return;
				setData(value);
				setSelected(value.skills[0]?.id ?? "");
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message);
			});
		return () => {
			cancelled = true;
		};
	}, [role]);

	// 标题与状态行始终可见，空状态只替换下面的清单与详情。
	const header = (
		<div className="cfg-detail-heading">
			<div className="cfg-detail-title">
				<h2>{roleName(role)} 技能</h2>
				<div className="cfg-chips">
					<span className="cfg-chip">只读</span>
				</div>
			</div>
		</div>
	);
	if (error)
		return (
			<div className="cfg-stack">
				{header}
				<p role="alert">技能加载失败：{error}</p>
			</div>
		);
	if (!data)
		return (
			<div className="cfg-stack">
				{header}
				<p>加载技能…</p>
			</div>
		);
	if (!data.enabled)
		return (
			<div className="cfg-stack">
				{header}
				<p className="meta-line">
					{roleName(role)} 没有启用的插件。技能由插件提供，先在插件页安装并启用插件。
				</p>
			</div>
		);
	if (data.skills.length === 0)
		return (
			<div className="cfg-stack">
				{header}
				<p className="meta-line">当前插件版本没有提供 SKILL.md，或只提供扩展。</p>
			</div>
		);

	const current = data.skills.find((s) => s.id === selected) ?? data.skills[0];
	return (
		<div className="cfg-stack">
			{header}
			<div className="cfg-skill-list" role="tablist" aria-label="技能">
				{data.skills.map((skill) => (
					<button
						type="button"
						key={skill.id}
						role="tab"
						aria-selected={skill.id === current.id}
						aria-current={skill.id === current.id ? "page" : undefined}
						onClick={() => setSelected(skill.id)}
					>
						<span className="cfg-dot" />
						{skill.name}
					</button>
				))}
			</div>
			<div className="cfg-skill-detail">
				<div className="cfg-chips">
					<span className="cfg-chip">
						{current.package ? `来源 ${current.package}` : "来源 插件版本"}
					</span>
					<span className="cfg-chip">{current.path}</span>
				</div>
				<div className="cfg-readonly">
					<span>Name</span>
					<p>{current.name}</p>
				</div>
				<div className="cfg-readonly">
					<span>Description</span>
					<p>{current.description || "该技能没有在 SKILL.md 里写描述。"}</p>
				</div>
			</div>
		</div>
	);
}
