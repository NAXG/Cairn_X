import type {
	RecordPreview,
	WorkbenchOverview,
	WorkbenchRecord,
} from "../../../contracts/workbench.js";
import type { PollState } from "../../api";
import type { Nav } from "../../hooks/useWorkspaceNav";
import type { ReadPageState } from "../../hooks/useReadPage";
import type { ResizablePanelState } from "../../hooks/useResizablePanel";
import { roleName, taskStatusLabels } from "../../labels";
import { Badge } from "../Badge";
import { PageNavigation } from "../PageNavigation";
import { PollError } from "../PollError";
import { Markdown } from "../traces/Transcript";
import type { SelectedRecord } from "./types";

export function ProjectInspector({
	d,
	setInspect,
	right,
	selectedRoute,
	selectedHint,
	selectedFact,
	selectedFinding,
	selectedGoal,
	selectedStep,
	nodeRecord,
	stepRecord,
	goals,
	navigate,
}: {
	d: WorkbenchOverview;
	setInspect: (inspect: boolean) => void;
	right: ResizablePanelState;
	selectedRoute: SelectedRecord<"route"> | undefined;
	selectedHint: SelectedRecord<"hint"> | undefined;
	selectedFact: SelectedRecord<"fact"> | undefined;
	selectedFinding: SelectedRecord<"finding"> | undefined;
	selectedGoal: SelectedRecord<"goal"> | undefined;
	selectedStep: SelectedRecord<"step"> | undefined;
	nodeRecord: PollState<WorkbenchRecord>;
	stepRecord: PollState<WorkbenchRecord>;
	goals: ReadPageState<RecordPreview>;
	navigate: (patch: Partial<Nav>) => void;
}) {
	return (
		<aside ref={right.panelRef} className="inspector">
			<div className="separator right-separator" {...right.separatorProps} />
			<header>
				<h3>项目详情</h3>
				<button onClick={() => setInspect(false)}>×</button>
			</header>
			{nodeRecord.error && <PollError error={nodeRecord.error} onRetry={nodeRecord.refresh} />}
			{stepRecord.error && <PollError error={stepRecord.error} onRetry={stepRecord.refresh} />}
			{selectedRoute ? (
				<>
					<h3>路线 {selectedRoute.id}</h3>
					<Markdown text={selectedRoute.description} />
				</>
			) : selectedHint ? (
				<>
					<h3>提示 {selectedHint.id}</h3>
					<Markdown text={selectedHint.content} />
				</>
			) : selectedFact ? (
				<>
					<h3>{selectedFact.id}</h3>
					<Markdown text={selectedFact.description} />
					{selectedFact.evidence_refs.length > 0 && (
						<>
							<h4>证据</h4>
							{selectedFact.evidence_refs.map((ref, i) => (
								<button
									key={i}
									onClick={() =>
										navigate({
											tab: "traces",
											execution: ref.execution_id,
											session: "",
											event: String(ref.seq),
										})
									}
								>
									事件 {ref.execution_id}#{ref.seq} →
								</button>
							))}
						</>
					)}
				</>
			) : selectedFinding ? (
				<>
					<h3>{selectedFinding.title}</h3>
					<Markdown text={selectedFinding.description} />
					{selectedFinding.fact_ids.length > 0 && (
						<>
							<h4>关联事实</h4>
							{selectedFinding.fact_ids.map((id) => (
								<button key={id} onClick={() => navigate({ tab: "graph", node: id, step: "" })}>
									{id} ↗
								</button>
							))}
						</>
					)}
					{selectedFinding.evidence_refs.length > 0 && (
						<>
							<h4>证据</h4>
							{selectedFinding.evidence_refs.map((ref, i) => (
								<button
									key={i}
									onClick={() =>
										navigate({
											tab: "traces",
											execution: ref.execution_id,
											session: "",
											event: String(ref.seq),
										})
									}
								>
									事件 {ref.execution_id}#{ref.seq} →
								</button>
							))}
						</>
					)}
					{selectedFinding.data != null && (
						<details>
							<summary>结构化数据</summary>
							<pre>{JSON.stringify(selectedFinding.data, null, 2)}</pre>
						</details>
					)}
				</>
			) : selectedGoal ? (
				<>
					<Badge status={selectedGoal.status} />
					<Markdown text={selectedGoal.description} />
					{selectedGoal.status === "achieved" && (
						<>
							<h4>完成证据</h4>
							{selectedGoal.achieved_description && <p>{selectedGoal.achieved_description}</p>}
							{selectedGoal.evidence.map((ref, i) => (
								<button
									key={i}
									onClick={() =>
										navigate({
											tab: ref.type === "finding" ? "findings" : "graph",
											node: ref.id,
											step: "",
										})
									}
								>
									{ref.type === "finding" ? "发现" : "事实"} {ref.id} ↗
								</button>
							))}
						</>
					)}
				</>
			) : selectedStep ? (
				<>
					<h3>{selectedStep.id}</h3>
					<Badge status={selectedStep.status} />
					{selectedStep.result && (
						<p className="meta-line">
							验收结论：{taskStatusLabels[selectedStep.result.task_status]}
							{selectedStep.result.unresolved.length > 0 &&
								` · 待解决：${selectedStep.result.unresolved.join("；")}`}
						</p>
					)}
					{selectedStep.waiting_on.length > 0 && (
						<p className="muted">
							依赖步骤：{selectedStep.waiting_on.join("、")}
							{selectedStep.status === "open" && "（全部结束后才会派发）"}
						</p>
					)}
					<Markdown text={selectedStep.description} />
					{selectedStep.summary && <Markdown text={selectedStep.summary} />}
					<button
						onClick={() =>
							navigate({
								tab: "traces",
								execution: "",
								session: "",
							})
						}
					>
						查看执行尝试 →
					</button>
					<button
						onClick={() =>
							navigate({
								tab: "graph",
								node: "_step_" + selectedStep.id,
							})
						}
					>
						定位图谱 →
					</button>
					<h4>关联事实</h4>
					{[...new Set([...selectedStep.from, ...selectedStep.produced_fact_ids])].map((id) => (
						<button key={id} onClick={() => navigate({ tab: "graph", node: id })}>
							{id} ↗
						</button>
					))}
				</>
			) : (
				<>
					<div className="inspector-item">
						<small>状态</small>
						<p>
							<Badge status={d.project.status} />
						</p>
					</div>
					<div className="inspector-item">
						<small>创建时间</small>
						<p>{new Date(d.project.created_at).toLocaleString()}</p>
					</div>
					<p className="meta-line">选择图谱节点或执行步骤查看关联信息。</p>
					<h4>目标</h4>
					{goals.items.map((g) => (
						<div className="inspector-item" key={g.id}>
							<Badge status={g.status ?? "pending"} />
							<p>{g.description}</p>
							<button onClick={() => navigate({ node: g.id, step: "" })}>查看目标详情</button>
						</div>
					))}
					<PageNavigation page={goals} />
					<h4>Token 用量</h4>
					{Object.entries(d.usage).map(([key, u]) => (
						<div className="inspector-item" key={key}>
							<strong>{key === "decide" || key === "execute" ? roleName(key) : key}</strong>
							<p>
								输入 {u.input_tokens.toLocaleString()} · 输出 {u.output_tokens.toLocaleString()}
							</p>
							{(u.cache_read_tokens > 0 || u.cache_write_tokens > 0) && (
								<p className="muted">
									{u.cache_read_tokens > 0 && (
										<>
											缓存命中 {u.cache_read_tokens.toLocaleString()} · 命中率{" "}
											{Math.round(
												(u.cache_read_tokens / (u.cache_read_tokens + u.input_tokens)) * 100,
											)}
											%
										</>
									)}
									{u.cache_read_tokens > 0 && u.cache_write_tokens > 0 && " · "}
									{u.cache_write_tokens > 0 && (
										<>缓存写入 {u.cache_write_tokens.toLocaleString()}</>
									)}
								</p>
							)}
						</div>
					))}
				</>
			)}
		</aside>
	);
}
