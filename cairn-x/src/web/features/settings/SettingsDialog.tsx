import { useModalDialog } from "../../hooks/useModalDialog";
import { useAction } from "../../hooks/useAction";
import { useEffect, useRef, useState } from "react";
import { api, json, usePoll } from "../../api";
import type { AgentProfile, AgentRole, RuntimeSettings } from "../../../contracts/configuration";
import type { Settings } from "../../../contracts/models";
import type { PluginRelease } from "../../../contracts/plugins";
import { roleName } from "../../labels";
import { ProviderEditor, type ProviderDraft } from "./ProviderEditor";
import { SkillsPanel } from "./SkillsPanel";
import {
	AgentsIcon,
	ModelsIcon,
	PluginsIcon,
	RuntimeIcon,
	SettingsIcon,
	SkillsIcon,
} from "../../icons";
import "./settings.css";
import { PluginPanel } from "./PluginPanel";
import { AgentSection } from "./AgentSection";
import { CatalogOverlay, type CatalogEntry } from "./CatalogOverlay";
import { GeneralSection } from "./GeneralSection";
import { RuntimeSection } from "./RuntimeSection";
import { SettingsSidebar } from "./SettingsSidebar";
import { sections, type SettingsSection } from "./sections";
import { changed, newId, preserveEdits, preserveProviderEdits } from "./utils";
export type { SettingsSection } from "./sections";
type Section = SettingsSection;
function SectionIcon({ id }: { id: Section }) {
	if (id === "general") return <SettingsIcon />;
	if (id === "models") return <ModelsIcon />;
	if (id === "skills") return <SkillsIcon />;
	if (id === "agents") return <AgentsIcon />;
	if (id === "plugins") return <PluginsIcon />;
	return <RuntimeIcon />;
}
export function SettingsDialog({
	onClose,
	initialSection = "general",
}: {
	onClose: () => void;
	initialSection?: Section;
}) {
	const [section, setSection] = useState<Section>(initialSection),
		[role, setRole] = useState<AgentRole>("decide");
	const [profiles, setProfiles] = useState<AgentProfile[]>([]),
		[savedProfiles, setSavedProfiles] = useState<AgentProfile[]>([]),
		[providers, setProviders] = useState<ProviderDraft[]>([]),
		[savedProviders, setSavedProviders] = useState<ProviderDraft[]>([]),
		[providerId, setProviderId] = useState("");
	// 「模型」下拉选“自定义模型 ID…”时，按角色保留手动输入态。
	const [customModel, setCustomModel] = useState<Record<AgentRole, boolean>>({
		decide: false,
		execute: false,
	});
	// 插件页左侧按角色展开包列表，数据由 PluginPanel 每次加载后回传。
	const [pluginReleases, setPluginReleases] = useState<Record<AgentRole, PluginRelease | null>>({
		decide: null,
		execute: null,
	});
	const [runtime, setRuntime] = useState<RuntimeSettings | null>(null),
		[savedRuntime, setSavedRuntime] = useState<RuntimeSettings | null>(null),
		[leases, setLeases] = useState<Settings | null>(null),
		[savedLeases, setSavedLeases] = useState<Settings | null>(null);
	const { busy, error, setError, run } = useAction();
	const [notice, setNotice] = useState("");
	const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null),
		[query, setQuery] = useState(""),
		[closing, setClosing] = useState(false);
	const host = useRef<HTMLDialogElement>(null);
	const confirmation = useRef<HTMLDialogElement>(null);
	const dirty =
		JSON.stringify(profiles) !== JSON.stringify(savedProfiles) ||
		JSON.stringify(providers) !== JSON.stringify(savedProviders) ||
		JSON.stringify(runtime) !== JSON.stringify(savedRuntime) ||
		JSON.stringify(leases) !== JSON.stringify(savedLeases);
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	const [loadVersion, setLoadVersion] = useState(0);
	const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
	const loadedSettings = useRef(new Set<string>());
	const [loadedKeys, setLoadedKeys] = useState<string[]>([]);
	const catalogPoll = usePoll<CatalogEntry[]>("/settings/provider-catalog", 60000);
	useEffect(() => {
		const controller = new AbortController();
		const load = async <T,>(key: string, url: string, apply: (value: T) => void) => {
			if (loadedSettings.current.has(key)) return;
			setLoadErrors((all) => ({ ...all, [key]: "" }));
			try {
				const value = await api<T>(url, { signal: controller.signal });
				if (controller.signal.aborted) return;
				apply(value);
				loadedSettings.current.add(key);
				setLoadedKeys([...loadedSettings.current]);
			} catch (e) {
				if (!controller.signal.aborted)
					setLoadErrors((all) => ({ ...all, [key]: (e as Error).message }));
			}
		};
		void Promise.all([
			load<AgentProfile[]>("agents", "/settings/agents", (a) => {
				setProfiles(a);
				setSavedProfiles(a);
			}),
			load<ProviderDraft[]>("models", "/settings/providers", (p) => {
				setProviders(p);
				setSavedProviders(p);
				setProviderId(p[0]?.id ?? "");
			}),
			load<RuntimeSettings>("runtime", "/settings/runtime", (r) => {
				setRuntime(r);
				setSavedRuntime(r);
			}),
			load<Settings>("leases", "/settings", (l) => {
				setLeases(l);
				setSavedLeases(l);
			}),
		]);
		return () => controller.abort();
	}, [loadVersion]);
	useModalDialog(host, () => {
		if (dirtyRef.current) setClosing(true);
		else onClose();
	});
	useModalDialog(confirmation, () => setClosing(false), closing);
	useEffect(() => {
		const before = (e: BeforeUnloadEvent) => {
			if (dirtyRef.current) e.preventDefault();
		};
		window.addEventListener("beforeunload", before);
		return () => window.removeEventListener("beforeunload", before);
	}, []);

	const action = (fn: () => Promise<unknown>) => run(fn, { clear: () => setNotice("") });
	const profile = profiles.find((p) => p.role === role);
	const decideProfile = profiles.find((p) => p.role === "decide");
	const executeProfile = profiles.find((p) => p.role === "execute");
	const provider = providers.find((p) => p.id === providerId);
	const budgetView = (p: AgentProfile | undefined) =>
		p && {
			run_seconds: p.run_seconds,
			harvest_seconds: p.harvest_seconds,
		};
	const budgetDirty = profiles.some((p) =>
		changed(budgetView(p), budgetView(savedProfiles.find((s) => s.role === p.role))),
	);
	const unsavedNames = [
		...profiles
			.filter((p) =>
				changed(
					p,
					savedProfiles.find((x) => x.role === p.role),
				),
			)
			.map((p) => roleName(p.role)),
		...providers
			.filter((p) =>
				changed(
					p,
					savedProviders.find((x) => x.id === p.id),
				),
			)
			.map((p) => p.name),
		...(changed(runtime, savedRuntime) || changed(leases, savedLeases) || budgetDirty
			? ["运行参数"]
			: []),
	];
	const sectionDirty = (id: Section) =>
		id === "agents"
			? changed(profiles, savedProfiles)
			: id === "models"
				? changed(providers, savedProviders)
				: id === "runtime"
					? changed(runtime, savedRuntime) || changed(leases, savedLeases) || budgetDirty
					: false;
	const currentDirty =
		section === "agents"
			? !!profile &&
				changed(
					profile,
					savedProfiles.find((p) => p.role === role),
				)
			: section === "models"
				? !!provider &&
					changed(
						provider,
						savedProviders.find((p) => p.id === providerId),
					)
				: sectionDirty(section);
	const saveLabel =
		section === "agents"
			? `保存 ${roleName(role)} 配置`
			: section === "models"
				? "保存当前供应商"
				: "保存运行参数";
	const footerHint =
		section === "agents"
			? "Dispatcher 与 Execute 配置独立保存"
			: section === "models"
				? "供应商配置全局共享"
				: section === "runtime"
					? "运行时限对下一次活动生效；调度参数由调度器同步"
					: section === "plugins"
						? "插件变更对新建活动生效，运行中的活动继续使用原版本"
						: section === "skills"
							? "技能由插件提供，本页只读；安装与启停请到插件页"
							: "显示偏好保存后立即生效";
	const changeRoleProfile = (targetRole: AgentRole, p: Partial<AgentProfile>) =>
		setProfiles((all) => all.map((a) => (a.role === targetRole ? { ...a, ...p } : a)));
	const changeProfile = (p: Partial<AgentProfile>) => changeRoleProfile(role, p);
	const changeProvider = (p: ProviderDraft) =>
		setProviders((all) => all.map((a) => (a.id === p.id ? p : a)));
	const removeProvider = async () => {
		const current = providers.find((p) => p.id === providerId);
		if (!current) throw Error("没有选中的供应商");
		if (current.revision === 0) {
			const rest = providers.filter((p) => p.id !== current.id);
			setProviders(rest);
			// 取消未保存草稿后仍保留一个有效选择，避免左侧明明有供应商、右侧却
			// 落入空状态，迫使用户再点一次列表项。
			setProviderId(rest[0]?.id ?? "");
			return;
		}
		await api("/settings/providers/" + current.id, { method: "DELETE" });
		setProviders((a) => a.filter((p) => p.id !== current.id));
		setSavedProviders((a) => a.filter((p) => p.id !== current.id));
		const rest = providers.filter((p) => p.id !== current.id);
		setProviderId(rest[0]?.id ?? "");
		setNotice("供应商已删除");
	};
	const saveProvider = async () => {
		const current = providers.find((p) => p.id === providerId);
		if (!current) throw Error("没有可保存的供应商");
		const result = await api<ProviderDraft>(
			"/settings/providers/" + current.id,
			json("PUT", current),
		);
		setProviders((a) =>
			a.map((p) => (p.id === result.id ? preserveProviderEdits(result, current, p) : p)),
		);
		setSavedProviders((a) =>
			a.some((p) => p.id === result.id)
				? a.map((p) => (p.id === result.id ? result : p))
				: [...a, result],
		);
		setNotice("供应商已保存");
		return result;
	};
	async function reloadProviders() {
		const fresh = await api<ProviderDraft[]>("/settings/providers");
		const baseline = savedProviders.find((p) => p.id === providerId);
		setProviders((all) =>
			all.map((p) => {
				const updated = fresh.find((x) => x.id === p.id);
				return p.id === providerId && updated && baseline
					? preserveProviderEdits(updated, baseline, p)
					: p;
			}),
		);
		setSavedProviders((all) =>
			all.map((p) => (p.id === providerId ? (fresh.find((x) => x.id === providerId) ?? p) : p)),
		);
	}
	async function save() {
		await action(async () => {
			if (section === "agents" && profile) {
				const submitted = profile;
				const result = await api<AgentProfile>("/settings/agents/" + role, json("PUT", submitted));
				setProfiles((a) =>
					a.map((p) => (p.role === role ? preserveEdits(result, submitted, p) : p)),
				);
				setSavedProfiles((a) => a.map((p) => (p.role === role ? result : p)));
				// 手动输入的模型会被服务端登记进供应商目录（revision 变化），同步本地状态
				const fresh = await api<ProviderDraft[]>("/settings/providers");
				const baseline = savedProviders.find((p) => p.id === submitted.provider_id);
				const updated = fresh.find((p) => p.id === submitted.provider_id);
				if (updated) {
					setProviders((all) =>
						all.map((p) =>
							p.id === updated.id && baseline ? preserveProviderEdits(updated, baseline, p) : p,
						),
					);
					setSavedProviders((all) => all.map((p) => (p.id === updated.id ? updated : p)));
				}
				setNotice("已保存，下一次活动使用新配置");
			} else if (section === "models" && provider) {
				await saveProvider();
			} else if (section === "runtime" && runtime && leases) {
				for (const current of profiles) {
					const saved = savedProfiles.find((p) => p.role === current.role);
					if (!saved || !changed(budgetView(current), budgetView(saved))) continue;
					const budget = budgetView(current)!;
					const result = await api<AgentProfile>(
						`/settings/agents/${current.role}/budget`,
						json("PATCH", { revision: saved.revision, ...budget }),
					);
					setSavedProfiles((all) => all.map((p) => (p.role === result.role ? result : p)));
					setProfiles((all) =>
						all.map((p) =>
							p.role === result.role
								? {
										...p,
										revision: result.revision,
										...preserveEdits(budgetView(result)!, budget, budgetView(p)!),
									}
								: p,
						),
					);
				}
				if (changed(runtime, savedRuntime)) {
					const submitted = runtime;
					const result = await api<RuntimeSettings>("/settings/runtime", json("PUT", submitted));
					setRuntime((current) => (current ? preserveEdits(result, submitted, current) : result));
					setSavedRuntime(result);
				}
				if (changed(leases, savedLeases)) {
					const submitted = leases;
					const l = await api<Settings>("/settings", json("PATCH", submitted));
					setLeases((current) => (current ? preserveEdits(l, submitted, current) : l));
					setSavedLeases(l);
				}
				setNotice("运行参数已保存，新运行时限从下一次活动开始生效");
			}
		});
	}
	function reset() {
		if (section === "agents") {
			setProfiles((all) =>
				all.map((p) => (p.role === role ? savedProfiles.find((s) => s.role === role)! : p)),
			);
		}
		if (section === "models") {
			if (!savedProviders.some((p) => p.id === providerId))
				setProviderId(providers.find((p) => p.id !== providerId)?.id ?? "");
			setProviders((all) =>
				all.flatMap((p) =>
					p.id !== providerId
						? [p]
						: savedProviders.find((s) => s.id === providerId)
							? [savedProviders.find((s) => s.id === providerId)!]
							: [],
				),
			);
		}
		if (section === "runtime") {
			setRuntime(savedRuntime);
			setLeases(savedLeases);
			setProfiles((all) =>
				all.map((p) => {
					const saved = savedProfiles.find((s) => s.role === p.role);
					return saved ? { ...p, ...budgetView(saved) } : p;
				}),
			);
		}
	}
	// 目录已由 catalogPoll 定期拉取；只有尚未拿到时才单独请求。
	const openCatalog = () =>
		catalogPoll.data
			? setCatalog(catalogPoll.data)
			: action(async () => setCatalog(await api<CatalogEntry[]>("/settings/provider-catalog")));
	function addProvider(item?: CatalogEntry) {
		const id = newId();
		const p: ProviderDraft = {
			id,
			revision: 0,
			name: item?.name ?? "自定义供应商",
			kind: item ? "builtin" : "custom",
			sdk_id: item?.id ?? id,
			base_url: "",
			api: "openai-completions",
			headers: {},
			models: item?.models ?? [],
			credential_id: "",
		};
		setProviders((a) => [...a, p]);
		setProviderId(id);
		setCatalog(null);
		setSection("models");
	}
	return (
		<dialog className="cfg-backdrop" ref={host} aria-label="运行设置">
			<div className="cfg-window">
				<header className="cfg-header">
					<strong>设置</strong>
					<nav aria-label="设置分类">
						{sections.map(([id, label]) => (
							<button
								type="button"
								key={id}
								aria-current={section === id ? "page" : undefined}
								onClick={() => {
									setSection(id);
									setError("");
									setNotice("");
								}}
							>
								<SectionIcon id={id} />
								{label}
								{sectionDirty(id) && <span aria-hidden="true"> ·</span>}
							</button>
						))}
					</nav>
					<select
						className="cfg-mobile-picker"
						aria-label="设置分类"
						value={section}
						onChange={(e) => setSection(e.target.value as Section)}
					>
						{sections.map(([id, label]) => (
							<option key={id} value={id}>
								{label}
							</option>
						))}
					</select>
					<button
						type="button"
						className="cfg-close"
						aria-label="关闭设置"
						onClick={() => (dirty ? setClosing(true) : onClose())}
					>
						×
					</button>
				</header>
				<div className="cfg-body">
					{["agents", "models", "plugins", "skills"].includes(section) && (
						<SettingsSidebar
							section={section}
							role={role}
							setRole={setRole}
							profiles={profiles}
							savedProfiles={savedProfiles}
							providers={providers}
							savedProviders={savedProviders}
							providerId={providerId}
							setProviderId={setProviderId}
							pluginReleases={pluginReleases}
							onAdd={openCatalog}
						/>
					)}
					<main className="cfg-content">
						{Object.entries(loadErrors)
							.filter(([, message]) => message)
							.map(([key, message]) => (
								<p role="alert" key={key}>
									{
										(
											{
												agents: "Agents",
												models: "供应商",
												runtime: "运行参数",
												leases: "活动租约",
											} as Record<string, string>
										)[key]
									}
									加载失败：{message}{" "}
									<button onClick={() => setLoadVersion((v) => v + 1)}>重试加载</button>
								</p>
							))}
						{["agents", "models", "runtime"].includes(section) &&
							!loadedKeys.includes(section) &&
							!loadErrors[section] && <p>加载设置…</p>}
						{section === "agents" && profile && (
							<AgentSection
								role={role}
								profile={profile}
								savedProviders={savedProviders}
								customModel={customModel}
								setCustomModel={setCustomModel}
								changeProfile={changeProfile}
								onRestoreDefaultPrompt={() =>
									action(async () =>
										changeProfile({
											prompt: (
												await api<{ prompt: string }>(`/settings/agents/${role}/default-prompt`)
											).prompt,
										}),
									)
								}
							/>
						)}
						{section === "models" &&
							(provider ? (
								<ProviderEditor
									key={provider.id}
									value={provider}
									oauthSupported={
										catalogPoll.data
											? !!catalogPoll.data.find((p) => p.id === provider.sdk_id)?.oauth
											: undefined
									}
									capabilityError={catalogPoll.error}
									onRetryCapability={catalogPoll.refresh}
									hasUnsaved={
										JSON.stringify(provider) !==
										JSON.stringify(savedProviders.find((p) => p.id === provider.id))
									}
									onChange={changeProvider}
									onReload={reloadProviders}
									onSave={saveProvider}
									onRemove={() => action(removeProvider)}
								/>
							) : (
								<div className="cfg-empty">
									<h2>模型与账号</h2>
									<p>添加订阅账号或自定义模型连接。</p>
									<button type="button" onClick={openCatalog}>
										添加供应商
									</button>
								</div>
							))}
						{section === "runtime" && runtime && leases && (
							<RuntimeSection
								runtime={runtime}
								leases={leases}
								setRuntime={setRuntime}
								setLeases={setLeases}
								decideProfile={decideProfile}
								executeProfile={executeProfile}
								changeRoleProfile={changeRoleProfile}
							/>
						)}
						{section === "plugins" && (
							<PluginPanel
								role={role}
								onCurrent={(r, release) => setPluginReleases((all) => ({ ...all, [r]: release }))}
							/>
						)}
						{section === "skills" && <SkillsPanel role={role} />}
						{section === "general" && <GeneralSection />}
					</main>
				</div>
				<footer className="cfg-footer">
					<div aria-live="polite">
						{error ? (
							<span className="cfg-error" role="alert">
								{error}
							</span>
						) : (
							<span>{notice || footerHint}</span>
						)}
						{dirty && <p>未保存：{unsavedNames.join("、")}</p>}
					</div>
					{["agents", "models", "runtime"].includes(section) && (
						<div className="cfg-inline">
							<button type="button" disabled={busy} onClick={reset}>
								取消修改
							</button>
							<button
								type="button"
								className="cfg-primary"
								disabled={busy || !currentDirty || (section === "runtime" && (!runtime || !leases))}
								onClick={save}
							>
								{busy ? "保存中…" : saveLabel}
							</button>
						</div>
					)}
				</footer>
				{closing && (
					<dialog
						className="cfg-overlay"
						ref={confirmation}
						role="alertdialog"
						aria-label="未保存的修改"
					>
						<div>
							<h3>有未保存的修改</h3>
							<p>关闭后将丢弃草稿。</p>
							<button type="button" onClick={() => setClosing(false)}>
								继续编辑
							</button>
							<button type="button" onClick={onClose}>
								放弃修改并关闭
							</button>
						</div>
					</dialog>
				)}
				{catalog && (
					<CatalogOverlay
						catalog={catalog}
						query={query}
						setQuery={setQuery}
						onPick={addProvider}
						onClose={() => setCatalog(null)}
					/>
				)}
			</div>
		</dialog>
	);
}
