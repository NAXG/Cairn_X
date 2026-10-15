import { useRef } from "react";
import { useModalDialog } from "../../hooks/useModalDialog";
import type { ProviderConnection } from "../../../contracts/configuration";
import { ProviderIcon } from "./ProviderIcon";

/** 服务端 /settings/provider-catalog 的条目（见 control/models.ts catalog()）。 */
export interface CatalogEntry {
	id: string;
	name: string;
	oauth: boolean;
	api_key: boolean;
	models: ProviderConnection["models"];
}

export function CatalogOverlay({
	catalog,
	query,
	setQuery,
	onPick,
	onClose,
}: {
	catalog: CatalogEntry[];
	query: string;
	setQuery: (query: string) => void;
	onPick: (item?: CatalogEntry) => void;
	onClose: () => void;
}) {
	const host = useRef<HTMLDialogElement>(null);
	useModalDialog(host, onClose);
	return (
		<dialog className="cfg-overlay" ref={host} aria-label="添加供应商">
			<div className="cfg-catalog">
				<div className="cfg-detail-heading">
					<input
						className="cfg-catalog-search"
						aria-label="搜索供应商"
						placeholder="搜索供应商…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<button type="button" className="cfg-close" aria-label="关闭添加供应商" onClick={onClose}>
						×
					</button>
				</div>
				<p className="cfg-catalog-group">自定义</p>
				<button type="button" className="cfg-custom-card" onClick={() => onPick()}>
					<span className="cfg-catalog-text">
						<span className="cfg-catalog-name">OpenAI / Anthropic compatible</span>
						<small>自定义端点格式</small>
					</span>
					<span className="cfg-catalog-plus" aria-hidden="true">
						＋
					</span>
				</button>
				<p className="cfg-catalog-group">订阅服务</p>
				<div className="cfg-catalog-grid">
					{catalog
						.filter((p) => p.oauth && p.name.toLowerCase().includes(query.toLowerCase()))
						.map((p) => (
							<button type="button" key={p.id} onClick={() => onPick(p)}>
								<span className="cfg-catalog-text">
									<span className="cfg-catalog-name">{p.name}</span>
									<small>OAuth</small>
								</span>
								<ProviderIcon id={p.id} size={20} />
							</button>
						))}
				</div>
				<p className="cfg-catalog-group">API KEY</p>
				<div className="cfg-catalog-grid">
					{catalog
						.filter((p) => p.api_key && p.name.toLowerCase().includes(query.toLowerCase()))
						.map((p) => (
							<button type="button" key={p.id} onClick={() => onPick(p)}>
								<span className="cfg-catalog-text">
									<span className="cfg-catalog-name">{p.name}</span>
									<small>{p.models.length} 个模型</small>
								</span>
								<ProviderIcon id={p.id} size={20} />
							</button>
						))}
				</div>
			</div>
		</dialog>
	);
}
