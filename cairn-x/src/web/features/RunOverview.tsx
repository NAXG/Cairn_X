import type { WorkbenchOverview } from "../../contracts/workbench";
import type { ExecutionSummary } from "../../contracts/transcripts";
import { usePoll } from "../api";
import { PollError } from "./PollError";
import { environmentLabels, roleName } from "../labels";
export function RunOverview({
	detail,
	onExecution,
}: {
	detail: WorkbenchOverview;
	onExecution: (e: ExecutionSummary) => void;
}) {
	const summary = usePoll<{ role: string; model: string; provider: string; created_at: string }[]>(
		`/projects/${detail.project.id}/activity-summary`,
		5000,
	);
	const environment = usePoll<{
		status: "unavailable" | "pending" | "running" | "stopped" | "unresponsive";
		last_seen_at: string | null;
	}>(`/projects/${detail.project.id}/environment`, 5000);
	const active = detail.active_executions;
	const queued = detail.counts.queued;
	const openSteps = detail.counts.open_steps;
	const failed = detail.latest_failure;
	const latestFinding = detail.latest_finding;
	const envStatus = environment.data?.status;
	const decideText = detail.project.decide
		? "规划中"
		: detail.project.status === "active"
			? detail.planning?.stalled
				? "规划受阻"
				: "等待调度"
			: "未运行";
	// 运行状态压成一条指标带；只有确有内容的清单才单独成块。
	return (
		<>
			<section className="status-strip" aria-label="运行环境">
				<span className="status-item">
					<i
						className={
							"status-dot " +
							(envStatus === "running" ? "on" : envStatus === "unresponsive" ? "warn" : "")
						}
					/>
					{envStatus ? environmentLabels[envStatus] : "加载环境状态…"}
				</span>
				<span className="status-item">
					Dispatcher
					<strong>{decideText}</strong>
					{detail.project.decide && (
						<span className="section-note">
							心跳 {new Date(detail.project.decide.last_heartbeat_at).toLocaleString()}
						</span>
					)}
				</span>
				<span className="status-item">
					执行中 <strong>{detail.counts.running}</strong>
				</span>
				<span className="status-item">
					排队执行 <strong>{queued}</strong>
				</span>
				<span className="status-item">
					待执行步骤 <strong>{openSteps}</strong>
				</span>
			</section>
			{environment.error && (
				<PollError error={environment.error} onRetry={environment.refresh} label="重试环境状态" />
			)}
			{!environment.error && environment.data && envStatus !== "unavailable" && (
				<p className="meta-line">
					步骤可复用当前环境中的文件和工具；环境回收后这些内容可能清除，重要结论请提交为 Fact 或
					Finding。
					{environment.data.last_seen_at
						? ` 最近心跳 ${new Date(environment.data.last_seen_at).toLocaleString()}。`
						: ""}
				</p>
			)}
			<div className="stats">
				{[
					["事实", detail.counts.facts],
					["目标", detail.counts.goals],
					["步骤", detail.counts.steps],
					["发现", detail.counts.findings],
				].map(([name, value]) => (
					<div className="card" key={name}>
						<small>{name}</small>
						<strong>{value}</strong>
					</div>
				))}
			</div>
			{summary.error && <PollError error={summary.error} onRetry={summary.refresh} />}
			{active.length > 0 && (
				<div className="section">
					<div className="section-head">
						<h3>正在执行</h3>
					</div>
					<div className="chips">
						{active.map((e) => (
							<button key={e.id} onClick={() => onExecution(e)}>
								{e.step_id} · {e.step_description || "执行中"}
							</button>
						))}
					</div>
				</div>
			)}
			{detail.counts.running > active.length && (
				<p className="meta-line">
					当前显示 {active.length} 个执行中的任务，其余任务可在执行记录中查看。
				</p>
			)}
			{!!summary.data?.length && (
				<div className="section">
					<div className="section-head">
						<h3>最近活动实际配置</h3>
					</div>
					{summary.data.map((s) => (
						<p className="meta-line" key={s.role}>
							{roleName(s.role)}：{s.provider} / {s.model} ·{" "}
							{new Date(s.created_at).toLocaleString()}
						</p>
					))}
				</div>
			)}
			{latestFinding && (
				<div className="section">
					<div className="section-head">
						<h3>最新发现</h3>
					</div>
					<p className="meta-line">{latestFinding.title}</p>
				</div>
			)}
			{failed && (
				<div className="section">
					<div className="section-head">
						<h3>最近失败</h3>
					</div>
					<p className="meta-line">{failed.error ?? "执行未成功完成"}</p>
					<button onClick={() => onExecution(failed)}>查看失败执行 {failed.step_id}</button>
				</div>
			)}
		</>
	);
}
