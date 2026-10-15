import type { ProjectSummary } from "../../../contracts/models";
import type { ReadPageState } from "../../hooks/useReadPage";
import type { ResizablePanelState } from "../../hooks/useResizablePanel";
import { LogoutIcon, ModelsIcon, SettingsIcon, SkillsIcon } from "../../icons";
import { Badge } from "../Badge";
import { PageNavigation } from "../PageNavigation";
import { PollError } from "../PollError";
import type { SettingsSection } from "../settings/SettingsDialog";

export function WorkspaceSidebar({
	mobile,
	setMobile,
	onNewProject,
	projectFilter,
	setProjectFilter,
	projects,
	navProject,
	openProject,
	left,
	onOpenSettings,
	onLogout,
}: {
	mobile: boolean;
	setMobile: (open: boolean) => void;
	onNewProject: () => void;
	projectFilter: string;
	setProjectFilter: (value: string) => void;
	projects: ReadPageState<Omit<ProjectSummary, "finding_schema">>;
	navProject: string;
	openProject: (project: string) => void;
	left: ResizablePanelState;
	onOpenSettings: (section: SettingsSection) => void;
	onLogout: () => void;
}) {
	const projectList = projects.items;
	return (
		<aside ref={left.panelRef} className={"sidebar " + (mobile ? "mobile-open" : "")}>
			<div className="brand">
				<span className="brand-mark">◈</span>
				<strong>Cairn</strong>
				<small>工作台</small>
				<button className="mobile-only" aria-label="关闭导航" onClick={() => setMobile(false)}>
					×
				</button>
			</div>
			<button className="new-project" onClick={onNewProject}>
				＋ 新建项目
			</button>
			<div className="sidebar-search">
				<input
					type="search"
					aria-label="搜索项目"
					placeholder="搜索项目"
					value={projectFilter}
					onChange={(e) => setProjectFilter(e.target.value)}
				/>
			</div>
			<div className="sidebar-scroll">
				{projects.loading && <p className="meta-line">加载项目…</p>}
				{projects.error && <PollError error={projects.error} onRetry={projects.refresh} />}
				{projectList.map((p) => (
					<button
						key={p.id}
						className={"project-link " + (navProject === p.id ? "selected" : "")}
						onClick={() => openProject(p.id)}
					>
						<span className="project-name" title={p.title}>
							{p.title}
						</span>
						<Badge status={p.status} />
					</button>
				))}
				{!projects.loading && !projects.error && projectList.length === 0 && (
					<p className="meta-line">
						{projectFilter ? "没有匹配的项目" : "还没有项目，先创建一个。"}
					</p>
				)}
				<PageNavigation page={projects} />
			</div>
			<footer>
				<div className="sidebar-dock">
					<button
						type="button"
						aria-label="模型"
						title="模型与供应商"
						onClick={() => onOpenSettings("models")}
					>
						<ModelsIcon />
						<span className="sidebar-dock-label">模型</span>
					</button>
					<button
						type="button"
						aria-label="技能"
						title="插件提供的技能"
						onClick={() => onOpenSettings("skills")}
					>
						<SkillsIcon />
						<span className="sidebar-dock-label">技能</span>
					</button>
					<button
						type="button"
						aria-label="设置"
						title="设置"
						onClick={() => onOpenSettings("general")}
					>
						<SettingsIcon />
						<span className="sidebar-dock-label">设置</span>
					</button>
				</div>
				<div className="sidebar-dock-sep" />
				<button
					type="button"
					className="sidebar-logout"
					aria-label="退出"
					title="退出"
					onClick={onLogout}
				>
					<LogoutIcon />
				</button>
			</footer>
			<div className="separator left-separator" {...left.separatorProps} />
		</aside>
	);
}
