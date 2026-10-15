import { useEffect, useRef, useState } from "react";
import { api, json } from "../../api";
import type { AgentRole } from "../../../contracts/configuration";
import type { PluginOperation, PluginRelease } from "../../../contracts/plugins";
import { roleName } from "../../labels";
import { Toggle } from "./Fields";

interface PluginResponse {
	current: PluginRelease | null;
	operations: PluginOperation[];
}

const kindLabels: Record<PluginOperation["kind"], string> = {
	install: "安装",
	update: "更新",
	remove: "卸载",
	enable: "启用",
	disable: "停用",
};

const statusLabels: Record<PluginOperation["status"], string> = {
	queued: "排队中",
	running: "进行中",
	succeeded: "已完成",
	failed: "失败",
};

export function PluginPanel({
	role,
	onCurrent,
}: {
	role: AgentRole;
	/** 把当前版本回传给设置外壳，让左侧列表能按包分组展示。 */
	onCurrent?: (role: AgentRole, release: PluginRelease | null) => void;
}) {
	const [source, setSource] = useState("");
	const [data, setData] = useState<{ role: AgentRole; value: PluginResponse } | null>(null);
	const [error, setError] = useState<{ role: AgentRole; message: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const report = useRef(onCurrent);
	const activeRole = useRef(role);
	const requestVersion = useRef(0);
	const requestController = useRef<AbortController | null>(null);
	const disposed = useRef(false);
	/** 没有排队或进行中的操作时放慢轮询。 */
	const idle = useRef(false);
	report.current = onCurrent;
	activeRole.current = role;
	const load = async (force = false) => {
		if (disposed.current || activeRole.current !== role) return;
		if (requestController.current && !force) return;
		const roleAtStart = role;
		const version = ++requestVersion.current;
		requestController.current?.abort();
		const controller = new AbortController();
		requestController.current = controller;
		try {
			const fresh = await api<PluginResponse>(`/settings/agents/${roleAtStart}/plugins`, {
				signal: controller.signal,
			});
			if (
				disposed.current ||
				controller.signal.aborted ||
				version !== requestVersion.current ||
				roleAtStart !== activeRole.current
			)
				return;
			idle.current = !fresh.operations.some(
				(operation) => operation.status === "queued" || operation.status === "running",
			);
			setData({ role: roleAtStart, value: fresh });
			report.current?.(roleAtStart, fresh.current);
			setError(null);
		} catch (e) {
			if (
				disposed.current ||
				controller.signal.aborted ||
				version !== requestVersion.current ||
				roleAtStart !== activeRole.current
			)
				return;
			setError({ role: roleAtStart, message: e instanceof Error ? e.message : String(e) });
		} finally {
			if (requestController.current === controller) requestController.current = null;
		}
	};
	useEffect(() => {
		setBusy(false);
		idle.current = false;
		let stopped = false;
		let timer: number | undefined;
		const tick = async () => {
			if (!document.hidden) await load();
			if (!stopped) timer = window.setTimeout(tick, idle.current ? 10000 : 2000);
		};
		const onVisible = () => {
			if (!document.hidden) void load();
		};
		document.addEventListener("visibilitychange", onVisible);
		void tick();
		return () => {
			stopped = true;
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
			requestVersion.current += 1;
			requestController.current?.abort();
			requestController.current = null;
		};
	}, [role]);
	useEffect(() => {
		return () => {
			disposed.current = true;
			requestVersion.current += 1;
			requestController.current?.abort();
			requestController.current = null;
		};
	}, []);
	const operate = async (kind: PluginOperation["kind"], value?: string) => {
		const roleAtStart = role;
		setBusy(true);
		try {
			await api(
				`/settings/agents/${role}/plugins/operations`,
				json("POST", { kind, ...(value ? { source: value } : {}) }),
			);
			if (!disposed.current && activeRole.current === roleAtStart) {
				setSource("");
				await load(true);
			}
		} catch (e) {
			if (!disposed.current && activeRole.current === roleAtStart)
				setError({ role: roleAtStart, message: e instanceof Error ? e.message : String(e) });
		} finally {
			if (!disposed.current && activeRole.current === roleAtStart) setBusy(false);
		}
	};
	const visibleData = data?.role === role ? data.value : null;
	const visibleError = error?.role === role ? error.message : "";
	const current = visibleData?.current ?? null;
	const removing = current?.retiring === true;
	const operations = visibleData?.operations ?? [];
	const pending = operations.filter(
		(operation) => operation.status === "queued" || operation.status === "running",
	);
	const failed = operations.filter((operation) => operation.status === "failed");
	return (
		<div className="cfg-stack">
			<div className="cfg-detail-heading">
				<div className="cfg-detail-title">
					<h2>{roleName(role)} 插件</h2>
					<div className="cfg-chips">
						<span className="cfg-chip">
							{removing ? "卸载中" : current ? (current.enabled ? "已启用" : "已禁用") : "未安装"}
						</span>
						{current && <span className="cfg-chip">{current.source || "PI 插件集合"}</span>}
					</div>
				</div>
				<div className="cfg-inline">
					<button
						type="button"
						disabled={busy || !current || removing}
						onClick={() => void operate("update", current?.source)}
					>
						更新
					</button>
					<button
						type="button"
						className="cfg-danger"
						disabled={busy || !current || removing}
						onClick={() => void operate("remove", current?.source)}
					>
						移除
					</button>
					<Toggle
						label="启用包"
						checked={!!current?.enabled}
						disabled={busy || !current || removing}
						onChange={(on) => void operate(on ? "enable" : "disable")}
					/>
				</div>
			</div>
			<small>按角色独立安装，只对新建活动生效；运行中的活动继续使用原版本。</small>
			{!current && <p className="meta-line">尚未安装 {roleName(role)} 插件。</p>}
			<div className="cfg-kv">
				<div>
					<span>状态</span>
					<p>
						{removing ? "卸载中" : current ? (current.enabled ? "已启用" : "已禁用") : "未安装"}
					</p>
				</div>
				<div>
					<span>来源</span>
					<p>{current?.source || "—"}</p>
				</div>
				<div>
					<span>资源</span>
					<p>
						{current
							? `${current.resources.extensions.length} 个扩展 · ${current.resources.skills.length} 个技能`
							: "—"}
					</p>
				</div>
				<div>
					<span>包含的包</span>
					<p>{current?.packages.length ? current.packages.join("、") : "—"}</p>
				</div>
				{current && (
					<>
						<div>
							<span>安装路径</span>
							<p>{current.path}</p>
						</div>
						<div>
							<span>安装平台</span>
							<p>{current.install_platform || "—"}</p>
						</div>
						<div>
							<span>Node</span>
							<p>{current.install_node || "—"}</p>
						</div>
						{current.worker_image && (
							<div>
								<span>Worker 镜像</span>
								<p>{current.worker_image}</p>
							</div>
						)}
					</>
				)}
			</div>
			<div className="cfg-section">
				<h3>安装来源</h3>
				<div className="cfg-inline">
					<input
						aria-label="PI 插件来源"
						placeholder="npm:包名@版本、git:地址或本地路径"
						value={source}
						onChange={(e) => setSource(e.target.value)}
					/>
					<button
						type="button"
						disabled={busy || removing || source.trim() === ""}
						onClick={() => void operate("install", source.trim())}
					>
						安装
					</button>
				</div>
				<small>
					本地路径相对部署端 /data/plugin-sources/{role}/；插件依赖在目标运行环境中安装。
				</small>
			</div>
			{pending.length > 0 && (
				<div className="cfg-section">
					<h3>进行中</h3>
					{pending.map((operation) => (
						<div className="plugin-row" key={operation.id}>
							<div className="plugin-row-head">
								<strong>{kindLabels[operation.kind]}</strong>
								<span className="badge">{statusLabels[operation.status]}</span>
								<span className="section-note">{operation.progress ?? 0}%</span>
							</div>
							{operation.message && <small className="section-note">{operation.message}</small>}
							<progress
								className="plugin-progress"
								aria-label={`${kindLabels[operation.kind]}进度`}
								value={operation.progress ?? 0}
								max={100}
							/>
						</div>
					))}
				</div>
			)}
			{failed.length > 0 && (
				<div className="cfg-section">
					<h3>最近失败</h3>
					{failed.map((operation) => (
						<div className="plugin-row" key={operation.id}>
							<div className="plugin-row-head">
								<strong>{kindLabels[operation.kind]}</strong>
								<span className="badge">{statusLabels[operation.status]}</span>
								{operation.source && <span className="section-note">{operation.source}</span>}
							</div>
							{/* 失败原因只在需要时按需展开，不把摘要或堆栈直接铺在页面上。 */}
							{operation.message && (
								<details className="plugin-error-detail">
									<summary>查看原始输出</summary>
									<pre>{operation.message}</pre>
								</details>
							)}
						</div>
					))}
				</div>
			)}
			{visibleError && (
				<p className="cfg-error" role="alert">
					{visibleError}
				</p>
			)}
			<div className="cfg-statusbar">
				<span>
					{current
						? `${current.resources.extensions.length} 扩展 · ${current.resources.skills.length} 技能`
						: `${roleName(role)} 未安装插件`}
				</span>
				<button type="button" disabled={busy} onClick={() => void load()}>
					刷新
				</button>
			</div>
		</div>
	);
}
