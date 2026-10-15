import { memo, useId, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toolLinks } from "./links";
import { api } from "../../api";
import { useDisplayPreferences } from "../../hooks/useDisplayPreferences";
import { PollError } from "../PollError";
import type { TranscriptEntry, TranscriptPage } from "../../../contracts/transcripts.js";
const remarkPlugins = [remarkGfm];
/** 轮询会频繁重渲染父组件；正文不变时跳过 Markdown 重新解析。 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return text.length > 100000 ? (
		<pre>{text}</pre>
	) : (
		<ReactMarkdown remarkPlugins={remarkPlugins} skipHtml>
			{text}
		</ReactMarkdown>
	);
});
function RecordView({
	record,
	links,
	focusRecord,
}: {
	record: Record<string, unknown>;
	links: ReturnType<typeof toolLinks>;
	focusRecord: (seq: number | undefined) => void;
}) {
	const msg = (record.message ?? record) as Record<string, unknown>;
	// 「默认展开思考块」只决定首次渲染是否带 open；用户手动折叠后不再被覆盖。
	const { prefs } = useDisplayPreferences();
	if (record.type === "session") return null;
	const blocks = Array.isArray(msg.content)
		? msg.content
		: typeof msg.content === "string"
			? [{ type: "text", text: msg.content }]
			: [];
	return (
		<article className={"message " + String(msg.role ?? "event")}>
			<header>
				<strong>
					{(
						{
							user: "用户",
							assistant: "助手",
							toolResult: "工具结果",
						} as Record<string, string>
					)[String(msg.role)] ?? String(record.type ?? "事件")}
				</strong>
				<small>
					{typeof record.timestamp === "string"
						? record.timestamp
						: typeof record.timestamp === "number"
							? new Date(record.timestamp).toLocaleString()
							: ""}
				</small>
			</header>
			{!!msg.toolName && (
				<div className="badge">
					{String(msg.toolName)} {msg.isError ? "· 错误" : ""}
				</div>
			)}
			{!!msg.toolCallId && (
				<small>
					调用 ID：{String(msg.toolCallId)}{" "}
					{links.calls.has(String(msg.toolCallId)) && (
						<button onClick={() => focusRecord(links.calls.get(String(msg.toolCallId)))}>
							定位调用 ↑
						</button>
					)}
				</small>
			)}
			{blocks.map((raw, i) => {
				const b: Record<string, unknown> =
					raw && typeof raw === "object"
						? (raw as Record<string, unknown>)
						: { type: "未知内容块", value: raw };
				return b.type === "text" ? (
					<Markdown key={i} text={String(b.text ?? "")} />
				) : b.type === "thinking" ? (
					<details key={i} open={prefs.thinkingOpen || undefined}>
						<summary>思考过程</summary>
						<pre>{String(b.thinking ?? "")}</pre>
					</details>
				) : b.type === "toolCall" ? (
					<details key={i} className="tool">
						<summary>{String(b.name)} · 工具调用</summary>
						<small>
							调用 ID：{String(b.id ?? "未知")}{" "}
							{links.results.has(String(b.id)) && (
								<button onClick={() => focusRecord(links.results.get(String(b.id)))}>
									定位结果 ↓
								</button>
							)}
						</small>
						<pre>{JSON.stringify(b.arguments ?? b.input, null, 2)}</pre>
					</details>
				) : (
					<details key={i}>
						<summary>{String(b.type ?? "未知内容块")}</summary>
						<pre>{JSON.stringify(b, null, 2)}</pre>
					</details>
				);
			})}
			{!blocks.length && (
				<details>
					<summary>原始记录</summary>
					<pre>{JSON.stringify(record, null, 2)}</pre>
				</details>
			)}
		</article>
	);
}
function Entry({
	entry,
	links,
	onLoaded,
	focusRecord,
}: {
	entry: TranscriptEntry;
	links: ReturnType<typeof toolLinks>;
	onLoaded: (seq: number, record: Record<string, unknown>) => void;
	focusRecord: (seq: number | undefined) => void;
}) {
	const [record, setRecord] = useState(entry.record);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => request.current?.abort(), []);
	const contentUrl = entry.content_url;
	return record ? (
		<RecordView record={record} links={links} focusRecord={focusRecord} />
	) : !contentUrl ? (
		<p className="message" role="alert">
			完整记录地址不可用
		</p>
	) : (
		<div className="message">
			<button
				disabled={loading}
				onClick={async () => {
					setLoading(true);
					const controller = new AbortController();
					request.current = controller;
					try {
						const data = await api<Record<string, unknown> | TranscriptPage>(contentUrl, {
							signal: controller.signal,
						});
						if (controller.signal.aborted) return;
						if (!data || typeof data !== "object") throw new Error("完整记录响应无效");
						const loaded =
							"entries" in data
								? (data as TranscriptPage).entries[0]?.record
								: (data as Record<string, unknown>);
						if (loaded) {
							setRecord(loaded);
							onLoaded(entry.seq, loaded);
						}
					} catch (e) {
						if (!controller.signal.aborted) setError((e as Error).message);
					} finally {
						if (request.current === controller) request.current = null;
						setLoading(false);
					}
				}}
			>
				{loading ? "加载中…" : `加载完整记录 (${Math.ceil(entry.bytes / 1024)} KB)`}
			</button>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}
export function Transcript({ url, targetSeq }: { url: string; targetSeq?: number }) {
	const [state, setState] = useState<{
		key: string;
		entries: TranscriptEntry[];
		error: string;
		more: boolean;
		loading: boolean;
	}>({ key: url, entries: [], error: "", more: false, loading: true });
	const [version, setVersion] = useState(0);
	const [loadedRecords, setLoadedRecords] = useState<Record<number, Record<string, unknown>>>({});
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState("all");
	const [pageIndex, setPageIndex] = useState(0);
	const [follow, setFollow] = useState(false);
	const [target, setTarget] = useState<number | null>(null);
	const end = useRef<HTMLDivElement>(null);
	const focusedExternal = useRef<number | null>(null);
	const prefix = useId();
	useEffect(() => {
		let disposed = false;
		let cursor = "";
		let entries: TranscriptEntry[] = [];
		let timer: ReturnType<typeof setTimeout>;
		let controller: AbortController | null = null;
		setState({ key: url, entries: [], error: "", more: false, loading: true });
		const run = async () => {
			clearTimeout(timer);
			if (disposed || document.hidden || controller) return;
			controller = new AbortController();
			let delay = 5000;
			try {
				const parameter = url.includes("/executions/") ? "after_seq" : "cursor";
				const page = await api<TranscriptPage>(
					url + (cursor ? `?${parameter}=${encodeURIComponent(cursor)}` : ""),
					{ signal: controller.signal },
				);
				if (disposed) return;
				const seen = new Set(entries.map((e) => e.seq));
				const added = page.entries.filter((e) => !seen.has(e.seq));
				if (added.length) entries = [...entries, ...added];
				delay = page.has_more && page.next_cursor !== cursor ? 0 : 5000;
				cursor = page.next_cursor;
				// 没有新条目时保留原状态：否则每轮都会重算全文检索索引并重渲染整页记录。
				setState((s) =>
					!added.length && s.key === url && !s.error && !s.loading && s.more === page.has_more
						? s
						: { key: url, entries, error: "", more: page.has_more, loading: false },
				);
			} catch (e) {
				if (!disposed && !controller.signal.aborted)
					setState((s) => ({
						...s,
						error: (e as Error).message,
						loading: false,
					}));
			} finally {
				controller = null;
				if (!disposed) timer = setTimeout(run, delay);
			}
		};
		const visible = () => {
			if (document.hidden) {
				clearTimeout(timer);
				controller?.abort();
			} else void run();
		};
		document.addEventListener("visibilitychange", visible);
		void run();
		return () => {
			disposed = true;
			clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", visible);
		};
	}, [url, version]);
	const current = state.key === url ? state : null;
	const effectiveEntries = useMemo(
		() =>
			(current?.entries ?? []).map((e) =>
				loadedRecords[e.seq] ? { ...e, record: loadedRecords[e.seq] } : e,
			),
		[current?.entries, loadedRecords],
	);
	const links = useMemo(() => toolLinks(effectiveEntries), [effectiveEntries]);
	const needle = query.toLowerCase();
	// 序列化全部记录代价高，只在确实输入了检索词时建立索引。
	const searching = needle !== "";
	const searchText = useMemo(
		() =>
			searching
				? new Map(
						effectiveEntries.map((e) => [e.seq, JSON.stringify(e.record ?? {}).toLowerCase()]),
					)
				: null,
		[effectiveEntries, searching],
	);
	const filtered = useMemo(
		() =>
			effectiveEntries.filter((e) => {
				if (e.record?.type === "session") return false;
				const msg = (e.record?.message ?? e.record ?? {}) as Record<string, unknown>;
				const content = Array.isArray(msg.content) ? (msg.content as Array<{ type?: string }>) : [];
				const tool = msg.role === "toolResult" || content.some((b) => b?.type === "toolCall");
				const error =
					msg.isError === true || msg.stopReason === "error" || e.record?.type === "error";
				return (
					(filter === "all" || (filter === "errors" ? error : tool)) &&
					(!needle || searchText?.get(e.seq)?.includes(needle))
				);
			}),
		[effectiveEntries, needle, filter, searchText],
	);
	const pages = Math.max(1, Math.ceil(filtered.length / 100));
	const selectedPage = follow ? pages - 1 : Math.min(pageIndex, pages - 1);
	useEffect(() => {
		if (follow) end.current?.scrollIntoView({ block: "end" });
	}, [current?.entries.length, follow]);
	useEffect(() => {
		if (target === null) return;
		const record = document.getElementById(`${prefix}-record-${target}`);
		if (record) {
			record.scrollIntoView({ block: "center", behavior: "smooth" });
			setTarget(null);
		}
	}, [target, selectedPage, query, filter, prefix]);
	const focusRecord = (seq: number | undefined) => {
		if (seq === undefined) return;
		setQuery("");
		setFilter("all");
		setFollow(false);
		const index = (current?.entries ?? [])
			.filter((e) => e.record?.type !== "session")
			.findIndex((e) => e.seq === seq);
		if (index >= 0) {
			setPageIndex(Math.floor(index / 100));
			setTarget(seq);
		}
	};
	useEffect(() => {
		if (!targetSeq) {
			focusedExternal.current = null;
			return;
		}
		if (focusedExternal.current === targetSeq) return;
		if (!(current?.entries ?? []).some((e) => e.seq === targetSeq)) return;
		focusedExternal.current = targetSeq;
		focusRecord(targetSeq);
	}, [targetSeq, current?.entries]);
	return (
		<div className="transcript">
			<div className="transcript-toolbar">
				<input
					aria-label="搜索记录"
					placeholder="搜索已载入内容…"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setPageIndex(0);
						setFollow(false);
					}}
				/>
				<select
					aria-label="记录筛选"
					value={filter}
					onChange={(e) => {
						setFilter(e.target.value);
						setPageIndex(0);
						setFollow(false);
					}}
				>
					<option value="all">全部记录</option>
					<option value="errors">只看错误</option>
					<option value="tools">工具调用与结果</option>
				</select>
				<label>
					<input
						type="checkbox"
						checked={follow}
						onChange={(e) => {
							setPageIndex(selectedPage);
							setFollow(e.target.checked);
						}}
					/>
					自动跟随
				</label>
				<button
					onClick={() => {
						setQuery("");
						setFilter("all");
						setFollow(true);
					}}
				>
					跳到最新
				</button>
				<button
					disabled={selectedPage === 0}
					onClick={() => {
						setFollow(false);
						setPageIndex(selectedPage - 1);
					}}
				>
					上一页记录
				</button>
				<span>
					{selectedPage + 1} / {pages} 页 · {filtered.length} 条
				</span>
				<button
					disabled={selectedPage >= pages - 1}
					onClick={() => {
						setFollow(false);
						setPageIndex(selectedPage + 1);
					}}
				>
					下一页记录
				</button>
			</div>
			{(query || filter !== "all") && (
				<p className="muted">
					筛选已载入内容；超大记录需先加载完整内容。
					{filtered.length === 0 ? "暂无匹配记录。" : ""}
				</p>
			)}

			{(!current || current.loading) && <p>正在加载记录…</p>}
			{current?.error && (
				<PollError
					error={current.error}
					onRetry={() => setVersion((v) => v + 1)}
					label="重新加载"
				/>
			)}
			{filtered.slice(selectedPage * 100, (selectedPage + 1) * 100).map((e) => (
				<div id={`${prefix}-record-${e.seq}`} key={e.seq}>
					<Entry
						entry={e}
						links={links}
						onLoaded={(seq, record) => setLoadedRecords((all) => ({ ...all, [seq]: record }))}
						focusRecord={focusRecord}
					/>
				</div>
			))}
			{current && !current.loading && !current.entries.length && (
				<div className="empty">尚无会话记录，执行中会自动刷新。</div>
			)}
			{current?.more && <p className="muted">正在连续读取历史记录…</p>}
			<div ref={end} />
		</div>
	);
}
