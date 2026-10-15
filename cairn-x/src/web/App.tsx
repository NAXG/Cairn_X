import { PollError } from "./features/PollError";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSummary } from "../contracts/models.js";
import type {
	WorkbenchOverview,
	WorkbenchRecord,
	ExecutionDetail,
	RecordPreview,
} from "../contracts/workbench.js";
import { useReadPage } from "./hooks/useReadPage";
import type { ActivityRecord } from "../contracts/transcripts.js";
import { api, json, usePoll } from "./api";
import { useTheme } from "./hooks/useTheme";
import { applyStoredDisplayPreferences } from "./hooks/useDisplayPreferences";
import type { SettingsSection } from "./features/settings/SettingsDialog";
import { useResizablePanel } from "./hooks/useResizablePanel";
import { useAction } from "./hooks/useAction";
import { useWorkspaceNav } from "./hooks/useWorkspaceNav";
import { CreateProject } from "./features/projects/CreateProject";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { FindingsTab } from "./features/workspace/FindingsTab";
import { HintComposer } from "./features/workspace/HintComposer";
import { OverviewTab } from "./features/workspace/OverviewTab";
import { ProjectInspector } from "./features/workspace/ProjectInspector";
import { ProjectTopbar } from "./features/workspace/ProjectTopbar";
import { TracesTab } from "./features/workspace/TracesTab";
import { WorkspaceSidebar } from "./features/workspace/WorkspaceSidebar";
const Graph = lazy(() => import("./features/graph/Graph").then((m) => ({ default: m.Graph })));

export function App() {
	const { nav, navigate, openExecution } = useWorkspaceNav();
	useEffect(() => {
		// 轨迹字号与内容宽度都存成文档级 CSS 变量，首屏直接应用已保存的偏好。
		applyStoredDisplayPreferences();
	}, []);
	const [graphProject, setGraphProject] = useState("");
	useEffect(() => {
		if (nav.tab === "graph") setGraphProject(nav.project);
	}, [nav.tab, nav.project]);
	const [mobile, setMobile] = useState(false);
	const [inspect, setInspect] = useState(() => innerWidth > 800);
	const [notice, setNotice] = useState("");
	const [newOpen, setNewOpen] = useState(false);
	// null 表示未打开；字符串记录 dock 打开时要定位到哪个分区。
	const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
	const [hintDrafts, setHintDrafts] = useState<Record<string, string>>({});
	const hint = hintDrafts[nav.project] ?? "";
	const currentProject = useRef(nav.project);
	currentProject.current = nav.project;
	const { busy, run } = useAction();
	const [projectFilter, setProjectFilter] = useState("");
	const [logFilter, setLogFilter] = useState<"all" | "decide" | "execute">("all");
	const { theme } = useTheme();
	const projects = useReadPage<Omit<ProjectSummary, "finding_schema">>(
		`/projects/page?query=${encodeURIComponent(projectFilter.trim())}`,
	);
	const detail = usePoll<WorkbenchOverview>(
		nav.project ? `/projects/${nav.project}/overview` : null,
	);
	const executions = usePoll<ExecutionDetail>(
		nav.project && nav.execution
			? `/projects/${nav.project}/executions/${nav.execution}/detail`
			: null,
	);
	const activities = useReadPage<ActivityRecord>(
		nav.project && nav.tab === "traces" && !nav.execution && !nav.session
			? `/projects/${nav.project}/activities/page?kind=${logFilter}${nav.step ? `&step=${encodeURIComponent(nav.step)}` : ""}`
			: null,
		5000,
	);
	const hints = useReadPage<RecordPreview>(
		nav.project && nav.tab === "overview" ? `/projects/${nav.project}/hints/page` : null,
	);
	const findings = useReadPage<RecordPreview>(
		nav.project && nav.tab === "findings" ? `/projects/${nav.project}/findings/page` : null,
	);
	const goals = useReadPage<RecordPreview>(
		nav.project && inspect && !nav.node && !nav.step && !nav.execution
			? `/projects/${nav.project}/goals/page`
			: null,
	);
	const origin = usePoll<WorkbenchRecord>(
		nav.project && nav.tab === "overview" ? `/projects/${nav.project}/records/fact/origin` : null,
	);
	const rootGoal = usePoll<WorkbenchRecord>(
		nav.project && nav.tab === "overview" ? `/projects/${nav.project}/records/goal/goal` : null,
	);
	const nodeRecord = usePoll<WorkbenchRecord>(
		nav.project && inspect && nav.node && !nav.node.startsWith("_step_")
			? `/projects/${nav.project}/records/node/${encodeURIComponent(nav.node)}`
			: null,
	);
	const stepId = nav.execution
		? executions.data?.execution.step_id
		: nav.step || (nav.node.startsWith("_step_") ? nav.node.slice(6) : "");
	const stepRecord = usePoll<WorkbenchRecord>(
		nav.project && stepId
			? `/projects/${nav.project}/records/step/${encodeURIComponent(stepId)}`
			: null,
	);
	const getMaxWidth = useCallback(() => innerWidth * 0.4, []);
	const left = useResizablePanel({
		ariaLabel: "调整导航宽度",
		cssVariable: "--panel-width",
		defaultWidth: 248,
		getMaxWidth,
		growthDirection: "right",
		maxWidth: 440,
		minWidth: 200,
		storageKey: "cairn-sidebar-width",
	});
	const right = useResizablePanel({
		ariaLabel: "调整详情宽度",
		cssVariable: "--panel-width",
		defaultWidth: 300,
		getMaxWidth,
		growthDirection: "left",
		maxWidth: 480,
		minWidth: 250,
		storageKey: "cairn-inspector-width",
	});
	const openProject = (project: string) => {
		setNotice("");
		navigate({
			project,
			tab: "overview",
			step: "",
			execution: "",
			session: "",
			node: "",
			event: "",
		});
	};
	const d = detail.data;
	const refresh = () => {
		projects.refresh();
		detail.refresh();
		executions.refresh();
		activities.refresh();
		hints.refresh();
		findings.refresh();
		goals.refresh();
		origin.refresh();
		rootGoal.refresh();
		nodeRecord.refresh();
		stepRecord.refresh();
	};
	const action = (fn: () => Promise<unknown>, message: string) =>
		run(fn, {
			success: () => {
				if (currentProject.current === nav.project) setNotice(message);
				refresh();
			},
			failure: (reason) => {
				if (currentProject.current === nav.project) setNotice(reason);
			},
		});
	const selectNode = (kind: string, id: string) => {
		navigate({
			node: kind === "step" ? "_step_" + id : id,
			step: kind === "step" ? id : "",
			execution: "",
			session: "",
		});
		setInspect(true);
	};
	const selectedStep =
		stepRecord.data?.type === "step"
			? stepRecord.data.record
			: nodeRecord.data?.type === "step"
				? nodeRecord.data.record
				: undefined;
	const selectedFact = nodeRecord.data?.type === "fact" ? nodeRecord.data.record : undefined;
	const selectedFinding = nodeRecord.data?.type === "finding" ? nodeRecord.data.record : undefined;
	const selectedGoal = nodeRecord.data?.type === "goal" ? nodeRecord.data.record : undefined;
	const selectedRoute = nodeRecord.data?.type === "route" ? nodeRecord.data.record : undefined;
	const selectedHint = nodeRecord.data?.type === "hint" ? nodeRecord.data.record : undefined;
	return (
		<div className="workspace" data-theme={theme}>
			<WorkspaceSidebar
				mobile={mobile}
				setMobile={setMobile}
				onNewProject={() => setNewOpen(true)}
				projectFilter={projectFilter}
				setProjectFilter={setProjectFilter}
				projects={projects}
				navProject={nav.project}
				openProject={openProject}
				left={left}
				onOpenSettings={setSettingsSection}
				onLogout={() =>
					action(async () => {
						await api("/logout", { method: "POST" });
						location.assign("/");
					}, "已退出")
				}
			/>
			<main>
				<ProjectTopbar
					project={d?.project}
					busy={busy}
					navProject={nav.project}
					inspect={inspect}
					setInspect={setInspect}
					setMobile={setMobile}
					action={action}
					openProject={openProject}
				/>
				{notice && (
					<div role="status" className="notice">
						{notice}
						<button onClick={() => setNotice("")}>×</button>
					</div>
				)}
				{!nav.project ? (
					<div className="welcome">
						<span className="hero-mark">◈</span>
						<h1>让探索留下路径</h1>
						<p>选择一个项目，查看目标、事实与每一步执行。</p>
						<button className="primary" onClick={() => setNewOpen(true)}>
							创建项目
						</button>
					</div>
				) : (
					<>
						<nav className="tabs">
							{[
								["overview", "概览"],
								["graph", "图谱"],
								["traces", "执行记录"],
								["findings", "发现"],
							].map(([id, label]) => (
								<button
									key={id}
									className={nav.tab === id ? "active" : ""}
									onClick={() => {
										navigate({ tab: id });
									}}
								>
									{label}
								</button>
							))}
						</nav>
						{d?.planning?.stalled && d.project.status === "active" && (
							<div className="notice" role="alert">
								规划连续中断，自动重试与待执行步骤的派发已暂停。请检查规划模型后，在概览中触发重新规划。
							</div>
						)}
						{detail.error && <PollError error={detail.error} onRetry={detail.refresh} notice />}
						{detail.loading && !d ? (
							<div className="empty">正在加载项目…</div>
						) : d ? (
							<div className="content-shell">
								<section className={"main-content " + (nav.tab === "graph" ? "graph-content" : "")}>
									{nav.tab === "overview" && (
										<OverviewTab
											d={d}
											origin={origin}
											rootGoal={rootGoal}
											hints={hints}
											busy={busy}
											navProject={nav.project}
											action={action}
											navigate={navigate}
											setInspect={setInspect}
											openExecution={openExecution}
										/>
									)}
									{(nav.tab === "graph" || graphProject === nav.project) && (
										<div className="graph-slot" hidden={nav.tab !== "graph"}>
											<Suspense fallback={<div className="empty">加载图谱…</div>}>
												<Graph
													key={nav.project}
													projectId={nav.project}
													focus={nav.node}
													onSelect={selectNode}
													active={nav.tab === "graph"}
												/>
											</Suspense>
										</div>
									)}
									{nav.tab === "traces" && (
										<TracesTab
											nav={nav}
											navigate={navigate}
											executions={executions}
											activities={activities}
											logFilter={logFilter}
											setLogFilter={setLogFilter}
											openExecution={openExecution}
											selectedStep={selectedStep}
										/>
									)}
									{nav.tab === "findings" && (
										<FindingsTab
											navProject={nav.project}
											findings={findings}
											navigate={navigate}
											setInspect={setInspect}
										/>
									)}
								</section>
								{inspect && (
									<ProjectInspector
										d={d}
										setInspect={setInspect}
										right={right}
										selectedRoute={selectedRoute}
										selectedHint={selectedHint}
										selectedFact={selectedFact}
										selectedFinding={selectedFinding}
										selectedGoal={selectedGoal}
										selectedStep={selectedStep}
										nodeRecord={nodeRecord}
										stepRecord={stepRecord}
										goals={goals}
										navigate={navigate}
									/>
								)}
							</div>
						) : (
							<div className="empty">无法显示项目，请重试或选择其他项目。</div>
						)}
						{d && (
							<HintComposer
								value={hint}
								busy={busy}
								onChange={(value) =>
									setHintDrafts((drafts) => ({ ...drafts, [nav.project]: value }))
								}
								onSave={(content) => {
									const projectId = nav.project;
									void action(async () => {
										await api(
											`/projects/${projectId}/hints`,
											json("POST", { content, creator: "human" }),
										);
										setHintDrafts((drafts) =>
											(drafts[projectId] ?? "").trim() === content
												? { ...drafts, [projectId]: "" }
												: drafts,
										);
									}, "提示已保存，等待后续规划读取。");
								}}
							/>
						)}
					</>
				)}
			</main>
			{newOpen && (
				<CreateProject
					onClose={() => setNewOpen(false)}
					onCreated={(id) => {
						setNewOpen(false);
						projects.latest();
						refresh();
						openProject(id);
					}}
				/>
			)}
			{settingsSection && (
				<SettingsDialog initialSection={settingsSection} onClose={() => setSettingsSection(null)} />
			)}
		</div>
	);
}
