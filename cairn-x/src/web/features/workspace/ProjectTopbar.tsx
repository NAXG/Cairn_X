import type { WorkbenchOverview } from "../../../contracts/workbench.js";
import { api, json } from "../../api";
import { Badge } from "../Badge";
import type { WorkspaceAction } from "./types";

export function ProjectTopbar({
	project,
	busy,
	navProject,
	inspect,
	setInspect,
	setMobile,
	action,
	openProject,
}: {
	project: WorkbenchOverview["project"] | undefined;
	busy: boolean;
	navProject: string;
	inspect: boolean;
	setInspect: (inspect: boolean) => void;
	setMobile: (open: boolean) => void;
	action: WorkspaceAction;
	openProject: (project: string) => void;
}) {
	return (
		<header className="topbar">
			<button className="mobile-only" onClick={() => setMobile(true)}>
				☰
			</button>
			<div className="project-heading">
				<h1 className="project-title" title={project?.title}>
					{project?.title ?? "项目"}
				</h1>
			</div>
			<div className="top-actions">
				{project && (
					<>
						<Badge status={project.status} />
						{project.status !== "completed" && (
							<button
								disabled={busy}
								onClick={() =>
									action(
										() =>
											api(
												`/projects/${navProject}/status`,
												json("POST", {
													status: project.status === "active" ? "stopped" : "active",
												}),
											),
										"项目状态已更新",
									)
								}
							>
								{project.status === "active" ? "停止" : "恢复"}
							</button>
						)}
						{project.status === "active" && (
							<button
								disabled={busy}
								onClick={() => {
									if (confirm("将项目标记为已完成？"))
										void action(
											() =>
												api(
													`/projects/${navProject}/complete`,
													json("POST", {
														from: [{ type: "fact", id: "origin" }],
														description: "人工标记完成",
														actor: "human",
													}),
												),
											"项目已完成",
										);
								}}
							>
								完成
							</button>
						)}
						{project.status !== "active" && (
							<button
								disabled={busy}
								onClick={() => {
									if (confirm("删除此项目？此操作无法撤销。"))
										void action(async () => {
											await api(`/projects/${navProject}`, {
												method: "DELETE",
											});
											openProject("");
										}, "项目已删除");
								}}
							>
								删除
							</button>
						)}
					</>
				)}
				<button
					type="button"
					aria-label="详情"
					title={inspect ? "收起项目详情" : "展开项目详情"}
					aria-pressed={inspect}
					onClick={() => setInspect(!inspect)}
				>
					▤
				</button>
			</div>
		</header>
	);
}
