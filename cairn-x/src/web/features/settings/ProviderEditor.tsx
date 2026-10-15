import { useEffect, useRef, useState } from "react";
import { api, json } from "../../api";
import { useAction } from "../../hooks/useAction";
import { MODEL_DEFAULTS, type ProviderConnection } from "../../../contracts/configuration";
import { Field, NumberField, Toggle } from "./Fields";
import { ThinkingLevelMapEditor } from "./ThinkingLevelMapEditor";
export type ProviderDraft = ProviderConnection & { api_key?: string; clear_key?: boolean };

/** /settings/login-attempts/:id/events 推送的事件（服务端 AuthEvent + 输入/终态扩展）。 */
type LoginPrompt = {
	type: string;
	message?: string;
	options?: Array<{ id: string; label?: string }>;
};
type LoginEvent = {
	type: string;
	url?: string;
	instructions?: string;
	verificationUri?: string;
	userCode?: string;
	message?: string;
	token?: string;
	prompt?: LoginPrompt;
	answered?: boolean;
};

/** 授权地址来自 provider，属不可信输入：只接受 http(s)，其余一律无效。 */
function httpAuthHref(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const url = new URL(raw);
		return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}
export function ProviderEditor({
	value,
	onChange,
	onReload,
	onSave,
	onRemove,
	hasUnsaved,
	oauthSupported,
	capabilityError,
	onRetryCapability,
}: {
	value: ProviderDraft;
	onChange: (v: ProviderDraft) => void;
	onReload: () => Promise<void>;
	onSave: () => Promise<ProviderDraft>;
	onRemove: () => Promise<void>;
	hasUnsaved: boolean;
	oauthSupported?: boolean;
	capabilityError: string;
	onRetryCapability: () => void;
}) {
	const { busy, error, setError, run: action } = useAction();
	const [result, setResult] = useState(""),
		// 外层按供应商 id 设置 key，切换供应商会重新挂载，初值即可。
		[selectedIndex, setSelectedIndex] = useState<number | null>(value.models.length ? 0 : null),
		[showKey, setShowKey] = useState(false),
		[login, setLogin] = useState(""),
		[events, setEvents] = useState<LoginEvent[]>([]),
		[answer, setAnswer] = useState("");
	const source = useRef<EventSource | null>(null);
	const loginRef = useRef("");
	const mounted = useRef(true);
	const authWindow = useRef<Window | null>(null);
	const keepResult = useRef(false);
	const [authStatus, setAuthStatus] = useState("");
	useEffect(() => {
		// 「发现并导入模型」会在 patch 后写入提示，跳过这次清空。
		if (keepResult.current) {
			keepResult.current = false;
			return;
		}
		setResult("");
	}, [value.base_url, value.api, value.api_key, value.models]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			source.current?.close();
			authWindow.current?.close();
			if (loginRef.current)
				void api("/settings/login-attempts/" + loginRef.current, { method: "DELETE" }).catch(
					() => {},
				);
		};
	}, []);
	const patch = (p: Partial<ProviderDraft>) => onChange({ ...value, ...p });
	const begin = () => {
		authWindow.current = window.open("about:blank", "_blank");
		if (authWindow.current) {
			authWindow.current.opener = null;
			authWindow.current.document.title = "等待订阅授权";
			authWindow.current.document.body.textContent =
				"正在连接授权服务，请稍候。若连接失败，请返回 Cairn 查看提示。";
		}
		setAuthStatus(
			authWindow.current
				? "授权窗口已打开，正在获取授权地址…"
				: "浏览器未打开授权窗口，获取地址后请点击下方授权链接。",
		);
		void action(async () => {
			try {
				const saved = await onSave();
				if (!mounted.current) return;
				const a = await api<{ id: string }>(
					`/settings/providers/${saved.id}/login`,
					json("POST", {}),
				);
				if (!mounted.current) {
					void api("/settings/login-attempts/" + a.id, { method: "DELETE" }).catch(() => {});
					return;
				}
				setLogin(a.id);
				loginRef.current = a.id;
				setEvents([]);
				source.current?.close();
				const es = new EventSource(`/settings/login-attempts/${a.id}/events`);
				source.current = es;
				es.onmessage = (e) => {
					let event: LoginEvent;
					try {
						event = JSON.parse(e.data);
					} catch {
						// 单个畸形帧不得抛出未捕获异常并让流永不关闭。
						setError("授权事件格式无效，请取消后重试");
						return;
					}
					setEvents((current) => [...current, event]);
					if (event.type === "auth_url" || event.type === "device_code") {
						try {
							const url = new URL(event.url ?? event.verificationUri ?? "");
							if (!["https:", "http:"].includes(url.protocol)) throw new Error("授权地址协议无效");
							if (authWindow.current && !authWindow.current.closed)
								authWindow.current.location.replace(url.href);
							setAuthStatus("等待完成授权；若窗口未跳转，请使用下方授权链接。");
						} catch (e) {
							setError((e as Error).message);
						}
					}
					if (["success", "error", "cancelled"].includes(event.type)) {
						es.close();
						setLogin("");
						loginRef.current = "";
						setAuthStatus(event.type === "success" ? "授权已完成" : "授权已结束，可重新登录");
						authWindow.current?.close();
						if (event.type === "success") void onReload().catch((e) => setError(e.message));
					}
				};
				es.onerror = () => {
					es.close();
					// 只报错不清状态会让登录按钮永远停在“等待授权完成…”，且服务端
					// 尝试泄漏；这里必须一并复位并释放该次登录尝试。
					const attempt = loginRef.current;
					setLogin("");
					loginRef.current = "";
					setAuthStatus("");
					if (attempt)
						void api("/settings/login-attempts/" + attempt, { method: "DELETE" }).catch(() => {});
					setError("授权连接已断开，请取消后重试");
				};
			} catch (e) {
				authWindow.current?.close();
				setAuthStatus("启动授权失败，请重试");
				throw e;
			}
		});
	};
	const input = [...events].reverse().find((e) => e.type === "input" && !e.answered);
	const selectedModel = selectedIndex === null ? undefined : value.models[selectedIndex];
	return (
		<div className="cfg-stack">
			<div className="cfg-detail-heading">
				<div className="cfg-eyebrow-block">
					<span className="cfg-eyebrow">Provider</span>
					<h2>{value.name}</h2>
					<small>
						{value.name} · {value.kind === "custom" ? "自定义连接" : "内置供应商"} ·{" "}
						{value.configured ? (value.oauth ? "订阅账号已登录" : "密钥已设置") : "尚未认证"}
					</small>
				</div>
				<button
					type="button"
					className="cfg-danger"
					disabled={busy || !!login}
					onClick={() => {
						if (
							window.confirm(
								"删除供应商「" +
									value.name +
									"」？若仍被 Agent 绑定会拒绝，请先在「子代理」里解绑或改绑。",
							)
						)
							void action(onRemove);
					}}
				>
					删除
				</button>
			</div>
			<Field label="显示名称">
				<input value={value.name} onChange={(e) => patch({ name: e.target.value })} />
			</Field>
			{value.kind === "custom" && (
				<>
					<Field label="Base URL">
						<input
							value={value.base_url}
							placeholder="https://api.example.com/v1"
							onChange={(e) => patch({ base_url: e.target.value })}
						/>
					</Field>
					<Field label="API 协议">
						<select value={value.api} onChange={(e) => patch({ api: e.target.value })}>
							{["openai-completions", "openai-responses", "anthropic-messages"].map((a) => (
								<option key={a}>{a}</option>
							))}
						</select>
					</Field>
				</>
			)}
			{/* 明文切换按钮不能放进 <label>：那样会把按钮也变成输入框的标签内容。 */}
			<div className="cfg-field">
				<span>API Key</span>
				<div className="cfg-input-row">
					<input
						aria-label="API Key"
						type={showKey ? "text" : "password"}
						autoComplete="new-password"
						value={value.api_key ?? ""}
						placeholder={value.configured ? "留空沿用现有凭据" : "输入 API Key"}
						onChange={(e) => patch({ api_key: e.target.value, clear_key: false })}
					/>
					<button
						type="button"
						className="cfg-icon-button"
						aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
						title={showKey ? "隐藏 API Key" : "显示 API Key"}
						aria-pressed={showKey}
						onClick={() => setShowKey((v) => !v)}
					>
						{showKey ? "隐藏" : "显示"}
					</button>
				</div>
			</div>
			<Toggle
				label="清除已保存凭据（保存后生效）"
				checked={!!value.clear_key}
				onChange={(v) => patch({ clear_key: v, api_key: "" })}
			/>
			{value.kind === "custom" && (
				<details>
					<summary>自定义请求头</summary>
					{Object.entries(value.headers).map(([k, v]) => (
						<div className="cfg-inline" key={k}>
							<code>{k}</code>
							<input
								aria-label={k}
								value={v}
								onChange={(e) => patch({ headers: { ...value.headers, [k]: e.target.value } })}
							/>
							<button
								type="button"
								onClick={() => {
									const h = { ...value.headers };
									delete h[k];
									patch({ headers: h });
								}}
							>
								移除
							</button>
						</div>
					))}
					<button
						type="button"
						onClick={() => {
							const name = window.prompt("请求头名称");
							if (name) patch({ headers: { ...value.headers, [name]: "" } });
						}}
					>
						添加请求头
					</button>
				</details>
			)}
			{value.kind === "builtin" && oauthSupported && (
				<div className="cfg-section">
					<h3>订阅账号</h3>
					<div className="cfg-inline">
						<button type="button" disabled={busy || !!login} onClick={begin}>
							{busy ? "正在连接授权服务…" : login ? "等待授权完成…" : "使用订阅账号登录"}
						</button>
						<button
							type="button"
							disabled={busy || !value.configured}
							onClick={() =>
								action(async () => {
									await api(`/settings/providers/${value.id}/logout`, json("POST", {}));
									await onReload();
								})
							}
						>
							退出账号
						</button>
					</div>
				</div>
			)}
			{value.kind === "builtin" && oauthSupported === undefined && (
				<p>
					{capabilityError ? (
						<>
							授权能力加载失败：{capabilityError}{" "}
							<button onClick={onRetryCapability}>重试授权能力</button>
						</>
					) : (
						"正在检查供应商授权方式…"
					)}
				</p>
			)}
			{authStatus && <p role="status">{authStatus}</p>}
			{!!(events.length || login) && (
				<div className="cfg-login" aria-live="polite">
					{events.map((event, i) => (
						<div key={i}>
							{event.type === "auth_url" ? (
								<>
									{httpAuthHref(event.url) ? (
										<a href={httpAuthHref(event.url)} target="_blank" rel="noreferrer">
											打开授权页面 ↗
										</a>
									) : (
										<span>授权地址无效，请取消后重试。</span>
									)}
									<p>{event.instructions}</p>
								</>
							) : event.type === "device_code" ? (
								<>
									{httpAuthHref(event.verificationUri) ? (
										<a href={httpAuthHref(event.verificationUri)} target="_blank" rel="noreferrer">
											打开设备授权页面 ↗
										</a>
									) : (
										<span>授权地址无效，请取消后重试。</span>
									)}
									<p>
										验证码：<code>{event.userCode}</code>
									</p>
								</>
							) : event.type === "success" ? (
								<p>登录成功</p>
							) : event.type === "error" ? (
								<p role="alert">{event.message}</p>
							) : event.type === "progress" ? (
								<p>{event.message}</p>
							) : null}
						</div>
					))}
					{login && input && (
						<>
							<Field label={input.prompt?.message ?? "授权码或回调地址"}>
								{input.prompt?.type === "select" ? (
									<select value={answer} onChange={(e) => setAnswer(e.target.value)}>
										<option value="">请选择</option>
										{input.prompt?.options?.map((o) => (
											<option key={o.id} value={o.id}>
												{o.label ?? o.id}
											</option>
										))}
									</select>
								) : (
									<input value={answer} onChange={(e) => setAnswer(e.target.value)} />
								)}
							</Field>
							<button
								disabled={!answer}
								type="button"
								onClick={() =>
									action(async () => {
										await api(
											`/settings/login-attempts/${login}/input`,
											json("POST", { token: input.token, value: answer }),
										);
										setEvents((es) => es.map((e) => (e === input ? { ...e, answered: true } : e)));
										setAnswer("");
									})
								}
							>
								提交授权信息
							</button>
						</>
					)}
					{login && (
						<button
							type="button"
							onClick={() =>
								action(async () => {
									await api("/settings/login-attempts/" + login, { method: "DELETE" });
									source.current?.close();
									authWindow.current?.close();
									setAuthStatus("已取消登录");
									setError("");
									setEvents([]);
									setLogin("");
									loginRef.current = "";
								})
							}
						>
							取消登录
						</button>
					)}
				</div>
			)}
			<div className="cfg-section">
				<div className="cfg-detail-heading">
					<h3>模型目录</h3>
					<button
						type="button"
						disabled={busy || !value.revision || hasUnsaved}
						title={hasUnsaved ? "请先保存供应商配置" : undefined}
						onClick={() =>
							action(async () => {
								const discovered = await api<ProviderConnection["models"]>(
									`/settings/providers/${value.id}/discover`,
									json("POST", {}),
								);
								keepResult.current = true;
								patch({
									models: [
										...value.models,
										...discovered.filter((m) => !value.models.some((x) => x.id === m.id)),
									],
								});
								setResult("模型已导入草稿，请保存");
							})
						}
					>
						{value.kind === "builtin" ? "导入已缓存模型" : "发现并导入模型"}
					</button>
				</div>
				{value.kind === "builtin" && (
					<small>
						内置供应商会在服务启动后及后台定期更新目录；刷新失败时继续使用上次成功的目录。重新打开设置即可看到新模型。
					</small>
				)}
				<div className="cfg-inline">
					<select
						aria-label="编辑模型"
						value={selectedIndex ?? ""}
						onChange={(e) =>
							setSelectedIndex(e.target.value === "" ? null : Number(e.target.value))
						}
					>
						<option value="">选择模型</option>
						{value.models.map((m, index) => (
							<option key={index} value={index}>
								{m.id || "未命名模型"}
							</option>
						))}
					</select>
					<button
						type="button"
						onClick={() => {
							const occupied = new Set(value.models.map((m) => m.id));
							let number = value.models.length + 1;
							while (occupied.has(`new-model-${number}`)) number++;
							const id = `new-model-${number}`;
							patch({
								models: [
									...value.models,
									{
										id,
										name: id,
										contextWindow: MODEL_DEFAULTS.context_window,
										maxTokens: MODEL_DEFAULTS.max_output_tokens,
										reasoning: false,
									},
								],
							});
							setSelectedIndex(value.models.length);
						}}
					>
						添加模型
					</button>
				</div>
				{selectedModel &&
					selectedIndex !== null &&
					[selectedModel].map((model) => {
						const change = (p: Partial<typeof model>) => {
							patch({
								models: value.models.map((m, index) =>
									index === selectedIndex ? { ...m, ...p } : m,
								),
							});
						};
						return (
							<div className="cfg-grid" key="editor">
								<Field label="模型 ID">
									<input value={model.id} onChange={(e) => change({ id: e.target.value })} />
								</Field>
								<Field label="显示名称">
									<input value={model.name} onChange={(e) => change({ name: e.target.value })} />
								</Field>
								<NumberField
									label="上下文窗口"
									value={model.contextWindow}
									onChange={(v) => change({ contextWindow: v })}
								/>
								<NumberField
									label="最大输出"
									value={model.maxTokens}
									onChange={(v) => change({ maxTokens: v })}
								/>
								<Toggle
									label="支持思考"
									checked={model.reasoning}
									onChange={(v) => change({ reasoning: v })}
								/>
								<button
									type="button"
									onClick={() => {
										patch({ models: value.models.filter((_, index) => index !== selectedIndex) });
										setSelectedIndex(null);
									}}
								>
									移除模型
								</button>
								{model.reasoning && (
									<ThinkingLevelMapEditor
										value={model.thinkingLevelMap}
										onChange={(thinkingLevelMap) => change({ thinkingLevelMap })}
									/>
								)}
							</div>
						);
					})}
				<button
					type="button"
					disabled={busy || !selectedModel?.id || !value.revision || hasUnsaved}
					onClick={() =>
						action(async () => {
							const r = await api<{ model: string; elapsed_ms: number }>(
								`/settings/providers/${value.id}/test`,
								json("POST", { model_id: selectedModel?.id }),
							);
							setResult(`已保存配置测试通过 · ${r.model} · ${r.elapsed_ms} ms`);
						})
					}
				>
					测试已保存模型
				</button>
			</div>
			{result && (
				<p className="cfg-notice" role="status">
					{result}
				</p>
			)}
			{error && (
				<p role="alert" className="cfg-error">
					{error}
				</p>
			)}
		</div>
	);
}
