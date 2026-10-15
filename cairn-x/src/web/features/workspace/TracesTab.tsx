import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ActivityRecord, ExecutionSummary } from "../../../contracts/transcripts.js";
import type { ExecutionDetail } from "../../../contracts/workbench.js";
import { api, type PollState } from "../../api";
import type { Nav } from "../../hooks/useWorkspaceNav";
import type { ReadPageState } from "../../hooks/useReadPage";
import { executionBadge } from "../../labels";
import { Badge } from "../Badge";
import { PageNavigation } from "../PageNavigation";
import { PollError } from "../PollError";
import { ActivityConfiguration } from "../settings/ActivityConfiguration";
import { Markdown, Transcript } from "../traces/Transcript";
import type { SelectedRecord } from "./types";

type EventSearchHit = {
	execution_id: string;
	step_id: string;
	seq: number;
	field: string;
	excerpt: string;
};

type LogRow = {
	key: string;
	kind: "execute" | "decide";
	label: string;
	status?: string;
	statusLabel?: string;
	at: string;
	duration?: string;
	file?: string;
	entries?: number;
	retry?: boolean;
	interrupted?: boolean;
	executionId?: string;
};

/** 会话文件的 mtime 是 UTC ISO；直接切片会显示成 UTC，这里按本地时区格式化为 MM-DD HH:mm。 */
function formatLocalDateTime(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function TracesTab({
	nav,
	navigate,
	executions,
	activities,
	logFilter,
	setLogFilter,
	openExecution,
	selectedStep,
}: {
	nav: Nav;
	navigate: (patch: Partial<Nav>) => void;
	executions: PollState<ExecutionDetail>;
	activities: ReadPageState<ActivityRecord>;
	logFilter: "all" | "decide" | "execute";
	setLogFilter: (filter: "all" | "decide" | "execute") => void;
	openExecution: (execution: ExecutionSummary) => void;
	selectedStep: SelectedRecord<"step"> | undefined;
}) {
	const [searchDraft, setSearchDraft] = useState("");
	const [eventSearch, setEventSearch] = useState<{
		project: string;
		query: string;
		hits: EventSearchHit[];
		nextCursor: string | null;
		loading: boolean;
		error: string;
	} | null>(null);
	const searchRequest = useRef(0);
	const eventSearchAbort = useRef<AbortController | null>(null);
	useEffect(() => () => eventSearchAbort.current?.abort(), []);
	const loadEventSearch = async (query: string, cursor: string | null = null) => {
		const pid = nav.project;
		if (!pid || !query) return;
		const request = ++searchRequest.current;
		// 旧请求必须取消：挂住的请求会让 loading 永远为 true（转圈不停）。
		eventSearchAbort.current?.abort();
		const controller = new AbortController();
		eventSearchAbort.current = controller;
		setEventSearch((previous) => ({
			project: pid,
			query,
			hits: cursor && previous?.project === pid && previous.query === query ? previous.hits : [],
			nextCursor: cursor,
			loading: true,
			error: "",
		}));
		const params = new URLSearchParams({ q: query });
		if (cursor) params.set("cursor", cursor);
		try {
			const res = await api<{ hits: EventSearchHit[]; next_cursor: string | null }>(
				`/projects/${pid}/events/search?${params}`,
				{ signal: controller.signal },
			);
			if (controller.signal.aborted || request !== searchRequest.current) return;
			setEventSearch(
				(previous) =>
					previous && {
						...previous,
						hits: [...previous.hits, ...res.hits],
						nextCursor: res.next_cursor,
						loading: false,
					},
			);
		} catch (err) {
			if (controller.signal.aborted || request !== searchRequest.current) return;
			setEventSearch(
				(previous) =>
					previous && {
						...previous,
						loading: false,
						error: err instanceof Error ? err.message : String(err),
					},
			);
		}
	};
	const runEventSearch = (e: FormEvent) => {
		e.preventDefault();
		void loadEventSearch(searchDraft.trim());
	};
	const executionDuration = (e: ExecutionSummary) => {
		const seconds = Math.max(
			0,
			Math.round(
				((e.finished_at ? Date.parse(e.finished_at) : Date.now()) -
					Date.parse(e.started_at ?? e.created_at)) /
					1000,
			),
		);
		return Number.isFinite(seconds)
			? `${Math.floor(seconds / 60)}分${seconds % 60}秒${e.finished_at ? "" : "（进行中）"}`
			: "耗时未知";
	};
	const selectedExecution = executions.data?.execution;
	// 文件与执行的关联由服务端负责，这里只负责显示。
	const logRows: LogRow[] = activities.items
		.filter((row) => !nav.step || row.kind !== "execute" || row.execution?.step_id === nav.step)
		.filter((row) => logFilter === "all" || row.kind === logFilter)
		.map((row) => ({
			key: row.key,
			kind: row.kind,
			label: row.execution
				? `${row.execution.step_id} · 尝试 ${row.execution.attempt}`
				: row.kind === "decide"
					? ""
					: "未关联执行",
			status: row.execution ? executionBadge(row.execution).status : undefined,
			statusLabel: row.execution ? executionBadge(row.execution).label : undefined,
			at: row.at,
			duration: row.execution ? executionDuration(row.execution) : undefined,
			file: row.session?.file,
			entries: row.session?.entries,
			retry: row.session?.retry,
			interrupted: row.session?.interrupted,
			executionId: row.execution?.id,
		}));
	// 全部记录都在页内打开：执行记录走数据库事件，只有会话文件的旧记录走会话文件。
	const openLogRow = (row: LogRow) => {
		if (row.executionId) {
			navigate({ tab: "traces", execution: row.executionId, session: "", node: "" });
			return;
		}
		if (row.file) navigate({ tab: "traces", execution: "", session: row.file, node: "" });
	};
	const traceUrl = nav.execution
		? `/projects/${nav.project}/executions/${nav.execution}/messages`
		: nav.session
			? `/projects/${nav.project}/sessions/${encodeURIComponent(nav.session)}/messages`
			: "";
	const eventSeq = Number(nav.event);
	const targetSeq =
		nav.execution && Number.isSafeInteger(eventSeq) && eventSeq > 0 ? eventSeq : undefined;
	/** 原始导出降级为次要入口：只有明确点击才打开新标签。 */
	const exportUrl = nav.execution
		? `/projects/${nav.project}/executions/${nav.execution}/export?inline=1`
		: nav.session
			? `/projects/${nav.project}/sessions/${encodeURIComponent(nav.session)}/export?inline=1`
			: "";
	return (
		<div className="page">
			<h2>
				{selectedStep ? selectedStep.description : nav.session ? "规划 / 历史记录" : "执行记录"}
			</h2>
			<div className="execution-navigation" aria-label="执行导航">
				{(nav.execution || nav.session || nav.step) && (
					<button
						onClick={() => {
							setLogFilter("all");
							navigate({ execution: "", session: "", step: "", node: "" });
						}}
					>
						返回全部执行
					</button>
				)}
				{nav.step && (
					<span>
						当前步骤：{nav.step}{" "}
						<button onClick={() => navigate({ step: "", execution: "", session: "", node: "" })}>
							清除筛选
						</button>
					</span>
				)}
				{selectedExecution && (
					<>
						<button
							disabled={!executions.data?.previous}
							onClick={() => {
								if (executions.data?.previous) openExecution(executions.data.previous);
							}}
						>
							上一条执行
						</button>
						<button
							disabled={!executions.data?.next}
							onClick={() => {
								if (executions.data?.next) openExecution(executions.data.next);
							}}
						>
							下一条执行
						</button>
					</>
				)}
			</div>
			<div className="execution-toolbar">
				<form onSubmit={runEventSearch} className="execution-navigation">
					<input
						aria-label="检索执行记录"
						placeholder="检索全部执行记录（关键词，AND）"
						value={searchDraft}
						onChange={(e) => setSearchDraft(e.target.value)}
					/>
					<button type="submit">检索</button>
				</form>
				<div className="log-filter" role="group" aria-label="记录类型">
					{(
						[
							["all", "全部"],
							["decide", "规划"],
							["execute", "执行"],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							aria-pressed={logFilter === id}
							onClick={() => setLogFilter(id)}
						>
							{label}
						</button>
					))}
				</div>
			</div>
			{eventSearch && eventSearch.project === nav.project && (
				<div className="card">
					<div>
						<strong>检索「{eventSearch.query}」</strong>
						{"　"}
						{eventSearch.error ? (
							<span role="alert">{eventSearch.error}</span>
						) : (
							<span className="meta">
								{eventSearch.hits.length} 条命中
								{eventSearch.loading
									? "（检索中…）"
									: eventSearch.nextCursor
										? "（还有记录待检索）"
										: ""}
							</span>
						)}
						{"　"}
						{eventSearch.nextCursor && (
							<button
								disabled={eventSearch.loading}
								onClick={() => void loadEventSearch(eventSearch.query, eventSearch.nextCursor)}
							>
								继续检索
							</button>
						)}
						<button
							onClick={() => {
								searchRequest.current += 1;
								eventSearchAbort.current?.abort();
								setEventSearch(null);
							}}
						>
							关闭
						</button>
					</div>
					{eventSearch.hits.map((hit) => (
						<div key={`${hit.execution_id}:${hit.seq}`} className="graph-detail-row">
							<button
								onClick={() =>
									navigate({
										step: hit.step_id,
										execution: hit.execution_id,
										session: "",
										node: "",
										event: String(hit.seq),
									})
								}
							>
								步骤 {hit.step_id} · 事件 #{hit.seq} · {hit.field}
							</button>
							<div className="meta">{hit.excerpt}</div>
						</div>
					))}
				</div>
			)}
			{executions.error && <PollError error={executions.error} onRetry={executions.refresh} />}
			{activities.error && <PollError error={activities.error} onRetry={activities.refresh} />}
			{nav.execution && (
				<ActivityConfiguration
					key={nav.execution}
					projectId={nav.project}
					activityId={nav.execution}
				/>
			)}
			{traceUrl ? (
				<>
					{selectedExecution && (
						<div className="card">
							<div className="section-head">
								<div>
									<strong>
										{selectedExecution.step_id} · 尝试 {selectedExecution.attempt}
									</strong>{" "}
									<Badge status={selectedExecution.status} />
									<small> {selectedExecution.id}</small>
								</div>
								{exportUrl && (
									<button
										type="button"
										onClick={() => window.open(exportUrl, "_blank", "noopener")}
									>
										导出原始 HTML
									</button>
								)}
							</div>
							{selectedExecution.error && <p role="alert">{selectedExecution.error}</p>}
							{selectedExecution.summary && <Markdown text={selectedExecution.summary} />}
						</div>
					)}
					{!selectedExecution && exportUrl && (
						<div className="execution-navigation">
							<button type="button" onClick={() => window.open(exportUrl, "_blank", "noopener")}>
								导出原始 HTML
							</button>
						</div>
					)}
					<Transcript key={traceUrl} url={traceUrl} targetSeq={targetSeq} />
				</>
			) : (
				<>
					{logRows.map((row) => (
						<button
							type="button"
							className={row.kind === "execute" ? "execution-row" : "session-row"}
							key={row.key}
							disabled={!row.file && !row.executionId}
							onClick={() => openLogRow(row)}
							title="在页内查看完整轨迹"
						>
							<strong>
								{row.kind === "decide"
									? `规划${row.retry ? " · 重试" : ""}${row.interrupted ? " · 已中断" : ""}`
									: "执行 · " + row.label}
							</strong>
							{row.status && <Badge status={row.status} label={row.statusLabel} />}
							<small>
								{formatLocalDateTime(row.at)}
								{row.duration ? ` · ${row.duration}` : ""}
								{row.entries !== undefined ? ` · ${row.entries} 条记录` : ""}
							</small>
						</button>
					))}
					<PageNavigation page={activities} />
					{logRows.length === 0 && (
						<p className="meta-line">{activities.loading ? "加载执行记录…" : "暂无执行记录"}</p>
					)}
				</>
			)}
		</div>
	);
}
