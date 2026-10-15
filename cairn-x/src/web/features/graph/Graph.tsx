import { useTheme } from "../../hooks/useTheme";
import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import dagre from "cytoscape-dagre";
import type { ProjectGraph, GraphLineage, GoalEvidence } from "../../../contracts/graph.js";
import { api, sameJson } from "../../api";
import { graphNodeTypeLabels } from "../../labels";
import { reconcileGraph } from "./reconcile";
import { NODE_SIZES, buildGraphElements, resolveGraphFocus } from "./elements";
cytoscape.use(dagre);
export function Graph({
	projectId,
	focus,
	onSelect,
	active,
}: {
	active: boolean;
	projectId: string;
	focus: string;
	onSelect: (kind: string, id: string) => void;
}) {
	// 图节点颜色在样式表之外单独设置，必须跟随实际主题重算：mist 与 light
	// 解析出的明暗相同，只用 theme 作依赖会漏掉两者之间的切换。
	const { theme, applied } = useTheme();
	const container = useRef<HTMLDivElement>(null);
	const graph = useRef<Core | null>(null);
	const select = useRef(onSelect);
	select.current = onSelect;
	const lastFocused = useRef("");
	const lastSelectedFocus = useRef("");
	const [compact, setCompact] = useState(true);
	const [isolated, setIsolated] = useState(false);
	const [showRoutes, setShowRoutes] = useState(false);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [frame, setFrame] = useState<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const [snapshot, setSnapshot] = useState<ProjectGraph | null>(null);
	const [speed, setSpeed] = useState(1);
	const [live, setLive] = useState<ProjectGraph | null>(null);
	const [error, setError] = useState("");
	const [selectedId, setSelectedId] = useState("");
	const [scope, setScope] = useState<"all" | "up" | "down" | "evidence">("all");
	const [local, setLocal] = useState<{
		key: string;
		graph?: GraphLineage;
		error?: string;
		evidence?: GoalEvidence;
	}>({ key: "" });
	const pid = projectId;
	const current = live?.project_id === pid ? live : null;
	const source = snapshot?.project_id === pid ? snapshot : current;
	const selected = source?.nodes.find((n) => n.id === selectedId);
	const key = `${pid}/${selectedId}/${scope}`;
	const localGraph = local.key === key ? local.graph : undefined;
	const displayed = scope === "all" || frame !== null ? source : localGraph;
	const times = useMemo(
		() =>
			[
				...new Set(
					(source?.nodes ?? [])
						.flatMap((n) => [n.created_at, n.concluded_at, n.achieved_at])
						.filter((s): s is string => !!s)
						.map(Date.parse),
				),
			]
				.filter(Number.isFinite)
				.sort((a, b) => a - b),
		[source],
	);
	const frameTime = frame === null ? null : (times[Math.min(frame, times.length - 1)] ?? null);
	const graphElements = useMemo(
		() =>
			displayed
				? buildGraphElements(
						displayed,
						{
							compact: scope === "all" ? compact : false,
							isolated,
							expanded,
							showRoutes,
							overview: scope === "all",
						},
						frameTime,
					)
				: [],
		[displayed, compact, isolated, expanded, showRoutes, scope, frameTime],
	);
	const shownNodes = graphElements.filter((element) => !element.data.source).length;
	const shownEdges = graphElements.length - shownNodes;

	// 图谱必须在项目运行期间持续刷新：一次性拉取会让运行中新建的
	// fact/step/finding 在切走标签页之前永远不出现。复用轮询语义
	// （在途互斥 + 隐藏时暂停）。
	useEffect(() => {
		if (!active) return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		let controller: AbortController | null = null;
		const run = async () => {
			clearTimeout(timer);
			if (disposed || document.hidden || controller !== null) return;
			const requestController = new AbortController();
			controller = requestController;
			try {
				const data = await api<ProjectGraph>(`/projects/${encodeURIComponent(pid)}/graph/canvas`, {
					signal: requestController.signal,
				});
				if (!disposed && !requestController.signal.aborted) {
					// 内容未变时保留原引用，避免每轮都重建元素并全量 reconcile 画布。
					setLive((previous) => (sameJson(previous, data) ? previous : data));
					setError("");
				}
			} catch (e) {
				if (!disposed && !requestController.signal.aborted) setError((e as Error).message);
			} finally {
				if (controller === requestController) {
					controller = null;
					if (!disposed && !document.hidden) timer = setTimeout(run, 3000);
				}
			}
		};
		const onVisible = () => {
			if (document.hidden) {
				clearTimeout(timer);
				controller?.abort();
				controller = null;
			} else void run();
		};
		document.addEventListener("visibilitychange", onVisible);
		void run();
		return () => {
			disposed = true;
			clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [active, pid]);
	const selectedType = selected?.type;
	const selectedRefId = selected?.ref_id;
	useEffect(() => {
		if (!active || !current || !selectedType || !selectedRefId || scope === "all" || frame !== null)
			return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		let controller: AbortController | null = null;
		const base = `/projects/${encodeURIComponent(pid)}`;
		const url =
			scope === "evidence"
				? `${base}/goals/${encodeURIComponent(selectedRefId)}/evidence`
				: `${base}/graph/lineage/${selectedType}/${encodeURIComponent(selectedRefId)}?direction=${scope}`;
		const run = async () => {
			clearTimeout(timer);
			if (disposed || document.hidden || controller) return;
			const requestController = new AbortController();
			controller = requestController;
			try {
				const data = await api<GraphLineage | GoalEvidence>(url, {
					signal: requestController.signal,
				});
				if (disposed || requestController.signal.aborted) return;
				const next =
					"lineage" in data ? { key, graph: data.lineage, evidence: data } : { key, graph: data };
				setLocal((previous) => (sameJson(previous, next) ? previous : next));
			} catch (e) {
				if (!disposed && !requestController.signal.aborted)
					setLocal({ key, error: e instanceof Error ? e.message : String(e) });
			} finally {
				if (controller === requestController) {
					controller = null;
					if (!disposed && !document.hidden) timer = setTimeout(run, 3000);
				}
			}
		};
		const onVisible = () => {
			if (document.hidden) {
				clearTimeout(timer);
				controller?.abort();
				controller = null;
			} else void run();
		};
		document.addEventListener("visibilitychange", onVisible);
		void run();
		return () => {
			disposed = true;
			clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [active, pid, key, selectedType, selectedRefId, scope, frame, !!current]);

	useEffect(() => {
		const cy = cytoscape({
			container: container.current!,
			elements: [],
			style: [
				{
					selector: "node",
					style: {
						label: "data(label)",
						shape: "round-rectangle",
						width: NODE_SIZES.fact.width,
						height: NODE_SIZES.fact.height,
						"border-width": 1,
						"font-size": 11,
						"font-weight": 500,
						"line-height": 1.35,
						"text-wrap": "wrap",
						"text-valign": "center",
					},
				},
				{
					selector: "node.step",
					style: {
						shape: "round-hexagon",
						width: NODE_SIZES.step.width,
						height: NODE_SIZES.step.height,
					},
				},
				{
					selector: "node.finding",
					style: {
						"border-width": 2,
						shape: "round-diamond",
						width: NODE_SIZES.finding.width,
						height: NODE_SIZES.finding.height,
					},
				},
				{
					selector: "node.goal-root",
					style: { width: NODE_SIZES["goal-root"].width, height: NODE_SIZES["goal-root"].height },
				},
				{ selector: "node.execution", style: { "border-style": "dashed" } },
				{ selector: "node.ph-claimed", style: { "border-width": 3 } },
				{
					selector: "node.goal-achieved, node.concluded",
					style: { "border-width": 2 },
				},
				{
					selector: "node.fact-group",
					style: {
						height: NODE_SIZES["fact-group"].height,
						width: NODE_SIZES["fact-group"].width,
						"font-size": 10,
					},
				},
				{
					selector: "edge",
					style: {
						width: 1.5,
						"target-arrow-shape": "triangle",
						"curve-style": "bezier",
						label: "data(label)",
						"font-size": 9,
						"text-rotation": "autorotate",
						"text-background-opacity": 0.85,
						"text-background-padding": "2px",
					},
				},
				{ selector: "edge.subgoal", style: { "line-style": "dashed" } },
				{ selector: ".focused", style: { "border-width": 4 } },
			],
		});
		graph.current = cy;
		cy.on("tap", "node", (e) => {
			const d = e.target.data();
			if (d.kind === "fact-group") setExpanded((s) => ({ ...s, [d.refId]: !s[d.refId] }));
			else {
				setSelectedId(d.id);
				setScope("all");
				if (["fact", "step", "goal", "finding"].includes(d.kind)) select.current(d.kind, d.refId);
			}
		});
		const resize = new ResizeObserver(() => {
			if (
				container.current &&
				container.current.clientWidth > 0 &&
				container.current.clientHeight > 0
			)
				cy.resize();
		});
		resize.observe(container.current!);
		return () => {
			resize.disconnect();
			cy.destroy();
			graph.current = null;
		};
	}, [pid]);
	useEffect(() => {
		const cy = graph.current;
		if (!cy) return;
		const css = getComputedStyle(document.documentElement);
		const color = (name: string) => css.getPropertyValue(name).trim();
		cy.style()
			.selector("node")
			.style({
				"background-color": color("--graph-fact-bg"),
				"border-color": color("--graph-fact-border"),
				color: color("--text"),
			})
			.selector("node.goal")
			.style({
				"background-color": color("--graph-goal-bg"),
				"border-color": color("--graph-goal-border"),
				color: color("--graph-goal-text"),
			})
			.selector("node.step, node.fact-group")
			.style({
				"background-color": color("--graph-step-bg"),
				"border-color": color("--graph-step-border"),
			})
			.selector("node.finding")
			.style({
				"background-color": color("--graph-finding-bg"),
				"border-color": color("--graph-finding-border"),
				color: color("--graph-finding-text"),
			})
			.selector("node.ph-claimed")
			.style({ "border-color": color("--warning") })
			.selector("node.goal-achieved, node.concluded")
			.style({ "border-color": color("--accent") })
			// Root goal must be applied after the generic goal selector. Otherwise the
			// generic white goal background overrides it while its white text remains,
			// yielding the blank node seen in the canvas.
			.selector("node.origin, node.goal-root")
			.style({
				"background-color": color("--graph-root-bg"),
				"border-color": color("--graph-root-bg"),
				color: color("--graph-root-text"),
			})
			.selector("edge")
			.style({
				"line-color": color("--muted"),
				"target-arrow-color": color("--muted"),
				color: color("--muted"),
				"text-background-color": color("--side"),
			})
			.selector(".focused")
			.style({ "border-color": color("--warning") })
			.update();
	}, [theme, applied, pid]);
	useEffect(() => {
		if (!current || !focus) return;
		const node = resolveGraphFocus(current, focus);
		if (!node) return;
		// 图谱每轮轮询都会带来新的 current；同一个 focus 只自动展开一次，
		// 否则用户手动收起事实组或取消「显示孤立事实」会在下一轮被改回去。
		if (lastSelectedFocus.current === `${pid}/${focus}`) return;
		lastSelectedFocus.current = `${pid}/${focus}`;
		setSelectedId(node.id);
		setScope("all");
		if (node.type === "fact") {
			const producers = current.edges.filter(
				(e) => e.relation === "produces" && e.target === node.id && e.source.startsWith("step:"),
			);
			const producerKeys = producers.flatMap((e) => {
				const producer = current.nodes.find((n) => n.id === e.source);
				return producer ? [producer.ref_id] : [];
			});
			setExpanded((previous) => {
				const keys = [...producerKeys];
				if (!keys.length && node.ref_id !== "origin") keys.push("__unscoped_facts__");
				return keys.every((k) => previous[k])
					? previous
					: { ...previous, ...Object.fromEntries(keys.map((k) => [k, true])) };
			});
			if (!producerKeys.length && node.ref_id !== "origin") setIsolated(true);
		}
	}, [focus, current]);
	useEffect(() => {
		const cy = graph.current;
		if (!cy || !active || !displayed) return;
		reconcileGraph(cy, graphElements);
	}, [active, graphElements, displayed]);
	useEffect(() => {
		const cy = graph.current;
		if (!cy || !active || !displayed) return;
		cy.elements().removeClass("focused");
		const node = source && focus ? resolveGraphFocus(source, focus) : undefined;
		const el = cy.getElementById(selectedId || node?.id || "");
		el.addClass("focused");
		if (node && el.length && lastFocused.current !== `${pid}/${focus}`) {
			lastFocused.current = `${pid}/${focus}`;
			cy.animate({ center: { eles: el }, duration: 200 });
		}
	}, [active, displayed, source, focus, selectedId, pid, graphElements]);
	useEffect(() => {
		if (!playing || !active) return;
		const timer = setTimeout(
			() =>
				setFrame((f) => {
					const next = (f ?? 0) + 1;
					if (next >= times.length) {
						setPlaying(false);
						return Math.max(0, times.length - 1);
					}
					return next;
				}),
			1100 / speed,
		);
		return () => clearTimeout(timer);
	}, [playing, frame, speed, times.length, active]);
	return (
		<div className="graph-wrap">
			<div className="graph-toolbar graph-toolbar-primary">
				<div className="graph-controls">
					<label title="默认将所有非起点事实折叠到产生它们的步骤下；取消勾选可展开全部事实。">
						<input
							type="checkbox"
							checked={compact}
							onChange={(e) => setCompact(e.target.checked)}
						/>
						折叠全部事实
					</label>
					<label title="默认隐藏没有被任何关系引用的事实；开启后将它们也放进图中。">
						<input
							type="checkbox"
							checked={isolated}
							onChange={(e) => setIsolated(e.target.checked)}
						/>
						显示孤立事实
					</label>
					<label title="路线是步骤到目标的重复规划路径；默认隐藏以保持主线清晰。">
						<input
							type="checkbox"
							checked={showRoutes}
							onChange={(e) => setShowRoutes(e.target.checked)}
						/>
						显示路线
					</label>
				</div>
				<div className="graph-actions" aria-label="画布控制">
					<button onClick={() => graph.current?.zoom(graph.current.zoom() * 1.15)}>放大</button>
					<button onClick={() => graph.current?.zoom(graph.current.zoom() / 1.15)}>缩小</button>
					<button onClick={() => graph.current?.fit(undefined, 40)}>适应画布</button>
					<button
						onClick={() =>
							graph.current
								?.layout({
									name: "dagre",
									rankDir: "LR",
									nodeSep: 35,
									rankSep: 100,
								} as cytoscape.LayoutOptions)
								.run()
						}
					>
						重新布局
					</button>
					<button
						disabled={!current || !times.length}
						onClick={() => {
							setScope("all");
							setSnapshot(current);
							setFrame(0);
							setPlaying(true);
						}}
					>
						回放
					</button>
				</div>
				{current && (
					<div
						className="graph-summary"
						aria-label="图谱概览"
						title={`全量：${current.stats.nodes} 节点 / ${current.stats.edges} 关系`}
					>
						<span>{shownNodes} 节点</span>
						<span>{shownEdges} 关系</span>
					</div>
				)}
				<div className="graph-legend" aria-label="节点图例">
					<span className="legend-origin">起点 / 根目标</span>
					<span className="legend-goal">目标</span>
					<span className="legend-step">步骤</span>
					<span className="legend-finding">发现</span>
				</div>
			</div>
			{error && <p role="alert">图谱加载失败：{error}</p>}
			{selected && frame === null && (
				<div className="graph-toolbar" aria-label="节点血缘">
					<span>
						{graphNodeTypeLabels[selected.type] ?? selected.type} · {selected.ref_id}
					</span>
					<button aria-pressed={scope === "up"} onClick={() => setScope("up")}>
						上游血缘
					</button>
					<button aria-pressed={scope === "down"} onClick={() => setScope("down")}>
						下游影响
					</button>
					{selected.type === "goal" && (
						<button aria-pressed={scope === "evidence"} onClick={() => setScope("evidence")}>
							目标证据
						</button>
					)}
					<button aria-pressed={scope === "all"} onClick={() => setScope("all")}>
						完整图
					</button>
				</div>
			)}
			{scope !== "all" && frame === null && (
				<div role="status" className="graph-status">
					{local.key === key && local.error ? (
						`血缘查询失败：${local.error}`
					) : !localGraph ? (
						"正在查询血缘…"
					) : (
						<>
							{scope === "up" ? "上游血缘" : scope === "down" ? "下游影响" : "目标证据"}：
							{localGraph.stats.nodes} 个节点 / {localGraph.stats.edges} 条关系
							{localGraph.truncated && "（已截断，不代表完整链路）"}
							{scope === "evidence" && local.evidence && (
								<p>
									完成理由：{local.evidence.goal.achieved_description ?? "尚无完成证明"}；直接证据：
									{local.evidence.evidence.map((n) => n.ref_id).join("、") || "无"}
								</p>
							)}
						</>
					)}
				</div>
			)}
			<div ref={container} className="graph-canvas" />
			{frame !== null && (
				<div className="replay">
					<button onClick={() => setPlaying(!playing)}>{playing ? "暂停" : "播放"}</button>
					<input
						aria-label="回放位置"
						type="range"
						min="0"
						max={Math.max(0, times.length - 1)}
						value={frame}
						onChange={(e) => setFrame(Number(e.target.value))}
					/>
					<select
						aria-label="回放速度"
						value={speed}
						onChange={(e) => setSpeed(Number(e.target.value))}
					>
						{[0.5, 1, 2, 4].map((n) => (
							<option key={n}>{n}</option>
						))}
					</select>
					<button
						onClick={() => {
							setFrame(null);
							setSnapshot(null);
							setPlaying(false);
						}}
					>
						结束回放
					</button>
					<small>根据记录时间重建；领取与放弃的历史状态可能不完整。</small>
				</div>
			)}
		</div>
	);
}
