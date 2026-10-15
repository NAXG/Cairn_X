import type { ExecutionSummary } from "../../../contracts/transcripts.js";
import type {
	RecordPreview,
	WorkbenchOverview,
	WorkbenchRecord,
} from "../../../contracts/workbench.js";
import { api, type PollState } from "../../api";
import type { Nav } from "../../hooks/useWorkspaceNav";
import type { ReadPageState } from "../../hooks/useReadPage";
import { PageNavigation } from "../PageNavigation";
import { PollError } from "../PollError";
import { RunOverview } from "../RunOverview";
import { Timeline } from "../Timeline";
import { Markdown } from "../traces/Transcript";
import type { WorkspaceAction } from "./types";

export function OverviewTab({
	d,
	origin,
	rootGoal,
	hints,
	busy,
	navProject,
	action,
	navigate,
	setInspect,
	openExecution,
}: {
	d: WorkbenchOverview;
	origin: PollState<WorkbenchRecord>;
	rootGoal: PollState<WorkbenchRecord>;
	hints: ReadPageState<RecordPreview>;
	busy: boolean;
	navProject: string;
	action: WorkspaceAction;
	navigate: (patch: Partial<Nav>) => void;
	setInspect: (inspect: boolean) => void;
	openExecution: (execution: ExecutionSummary) => void;
}) {
	return (
		<div className="page">
			<h2>探索概览</h2>
			<RunOverview detail={d} onExecution={openExecution} />
			<div className="section">
				<div className="section-head">
					<h3>起点与目标</h3>
				</div>
				<section className="card">
					<h4>起点</h4>
					<Markdown text={origin.data?.type === "fact" ? origin.data.record.description : ""} />
					<h4>总目标</h4>
					<Markdown text={rootGoal.data?.type === "goal" ? rootGoal.data.record.description : ""} />
				</section>
			</div>
			<div className="section">
				<div className="section-head">
					<h3>规划</h3>
				</div>
				{!d.planning && <p className="meta-line">尚无规划记录</p>}
				<button
					disabled={busy || d.project.status !== "active"}
					onClick={() =>
						void action(async () => {
							await api(`/projects/${navProject}/decide/signal`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ signal: "manual" }),
							});
						}, "已请求重新规划")
					}
				>
					触发重新规划
				</button>
			</div>
			<div className="section">
				<div className="section-head">
					<h3>时间线</h3>
				</div>
				<Timeline
					projectId={navProject}
					onRecord={(_type, id) => {
						navigate({ node: id, step: "" });
						setInspect(true);
					}}
					onStep={(id) =>
						navigate({
							tab: "graph",
							step: id,
							node: "_step_" + id,
						})
					}
				/>
			</div>
			<div className="section">
				<div className="section-head">
					<h3>补充提示</h3>
					{d.counts.hints > 0 && <span className="section-note">{d.counts.hints} 条</span>}
				</div>
				{hints.items.length ? (
					hints.items.map((h) => (
						<div className="card" key={h.id}>
							<small>
								{h.creator} · {h.created_at}
							</small>
							<Markdown text={h.content ?? ""} />
							{h.truncated && (
								<button
									onClick={() => {
										navigate({ node: h.id, step: "" });
										setInspect(true);
									}}
								>
									查看完整提示
								</button>
							)}
						</div>
					))
				) : (
					<p className="meta-line">还没有补充提示。</p>
				)}
				{hints.error && <PollError error={hints.error} onRetry={hints.refresh} />}
				<PageNavigation page={hints} />
			</div>
		</div>
	);
}
