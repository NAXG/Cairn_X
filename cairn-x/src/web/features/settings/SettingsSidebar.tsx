import type { AgentProfile, AgentRole } from "../../../contracts/configuration";
import type { PluginRelease } from "../../../contracts/plugins";
import { roleName } from "../../labels";
import { ProviderIcon } from "./ProviderIcon";
import type { ProviderDraft } from "./ProviderEditor";
import type { SettingsSection } from "./sections";
import { changed } from "./utils";

export function SettingsSidebar({
	section,
	role,
	setRole,
	profiles,
	savedProfiles,
	providers,
	savedProviders,
	providerId,
	setProviderId,
	pluginReleases,
	onAdd,
}: {
	section: SettingsSection;
	role: AgentRole;
	setRole: (role: AgentRole) => void;
	profiles: AgentProfile[];
	savedProfiles: AgentProfile[];
	providers: ProviderDraft[];
	savedProviders: ProviderDraft[];
	providerId: string;
	setProviderId: (id: string) => void;
	pluginReleases: Record<AgentRole, PluginRelease | null>;
	onAdd: () => void;
}) {
	return (
		<aside className="cfg-sidebar">
			<div className="cfg-list">
				{section === "agents" && <p className="cfg-group">内置</p>}
				{section === "agents" &&
					(["decide", "execute"] as const).map((r) => (
						<button
							type="button"
							key={r}
							aria-current={role === r ? "page" : undefined}
							onClick={() => {
								setRole(r);
							}}
						>
							<span className="cfg-dot" />
							{roleName(r)}
							{changed(
								profiles.find((p) => p.role === r),
								savedProfiles.find((p) => p.role === r),
							) && <small aria-hidden="true">未保存</small>}
						</button>
					))}
				{section === "plugins" && <p className="cfg-group">全局</p>}
				{section === "plugins" &&
					(["decide", "execute"] as const).map((r) => (
						<div className="cfg-provider" key={r}>
							<button
								type="button"
								aria-current={role === r ? "page" : undefined}
								onClick={() => setRole(r)}
							>
								<span className="cfg-dot" />
								{roleName(r)}
								<small>{pluginReleases[r] ? "已安装" : "未安装"}</small>
							</button>
							{role === r &&
								(pluginReleases[r]?.packages ?? []).map((pkg) => (
									<span className="cfg-package-row" key={pkg}>
										{pkg}
									</span>
								))}
						</div>
					))}
				{section === "skills" && <p className="cfg-group">按角色</p>}
				{section === "skills" &&
					(["decide", "execute"] as const).map((r) => (
						<button
							type="button"
							key={r}
							aria-current={role === r ? "page" : undefined}
							onClick={() => setRole(r)}
						>
							<span className="cfg-dot" />
							{roleName(r)}
						</button>
					))}
				{section === "models" && <p className="cfg-group">供应商</p>}
				{section === "models" &&
					providers.map((p) => {
						const active = providerId === p.id;
						return (
							<div className="cfg-provider" key={p.id}>
								<button
									type="button"
									className="cfg-provider-row"
									aria-current={active ? "page" : undefined}
									onClick={() => setProviderId(p.id)}
								>
									<ProviderIcon id={p.sdk_id || p.id} size={14} />
									<span className="cfg-provider-name">{p.name}</span>
									{changed(
										p,
										savedProviders.find((x) => x.id === p.id),
									) && <small>未保存</small>}
									<small>{p.models.length}</small>
								</button>
								{active &&
									p.models.map((m) => (
										<span className="cfg-model-row" key={m.id}>
											<span className="cfg-model-name">{m.name || m.id}</span>
											{m.reasoning && (
												<span className="cfg-model-tag" title="支持思考">
													T
												</span>
											)}
										</span>
									))}
							</div>
						);
					})}
			</div>
			{section === "models" && (
				<button type="button" className="cfg-add" onClick={onAdd}>
					＋ 添加供应商
				</button>
			)}
		</aside>
	);
}
