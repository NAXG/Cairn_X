/**
 * 供应商图标：图标 sprite 取自 pi-web 的 provider-icons.svg（图标来自 @lobehub/icons，
 * MIT，见 THIRD_PARTY_NOTICES.md）；未收录的供应商退回首字母色块。
 */
const PROVIDER_ICONS: Record<string, { symbol: string; color: boolean }> = {
	anthropic: { symbol: "anthropic", color: false },
	openai: { symbol: "openai", color: false },
	"openai-codex": { symbol: "openai", color: false },
	google: { symbol: "google", color: true },
	"google-vertex": { symbol: "google", color: true },
	"ant-ling": { symbol: "antgroup", color: true },
	deepseek: { symbol: "deepseek", color: true },
	groq: { symbol: "groq", color: false },
	mistral: { symbol: "mistral", color: true },
	moonshotai: { symbol: "moonshot", color: false },
	"moonshotai-cn": { symbol: "moonshot", color: false },
	moonshot: { symbol: "moonshot", color: false },
	minimax: { symbol: "minimax", color: true },
	"minimax-cn": { symbol: "minimax", color: true },
	fireworks: { symbol: "fireworks", color: true },
	huggingface: { symbol: "huggingface", color: true },
	cerebras: { symbol: "cerebras", color: true },
	openrouter: { symbol: "openrouter", color: false },
	xai: { symbol: "xai", color: false },
	"cloudflare-ai-gateway": { symbol: "cloudflare", color: true },
	"cloudflare-workers-ai": { symbol: "cloudflare", color: true },
	"vercel-ai-gateway": { symbol: "vercel", color: false },
	"github-copilot": { symbol: "githubcopilot", color: false },
	"amazon-bedrock": { symbol: "aws", color: true },
	"azure-openai-responses": { symbol: "azure", color: true },
	"kimi-coding": { symbol: "kimi", color: true },
	nvidia: { symbol: "nvidia", color: true },
	opencode: { symbol: "opencode", color: false },
	"opencode-go": { symbol: "opencode", color: false },
	qwen: { symbol: "qwen", color: true },
	xiaomi: { symbol: "xiaomimimo", color: false },
	"xiaomi-token-plan-ams": { symbol: "xiaomimimo", color: false },
	"xiaomi-token-plan-cn": { symbol: "xiaomimimo", color: false },
	"xiaomi-token-plan-sgp": { symbol: "xiaomimimo", color: false },
	zai: { symbol: "zai", color: false },
	"zai-coding-cn": { symbol: "zai", color: false },
	zhipu: { symbol: "zhipu", color: true },
	cohere: { symbol: "cohere", color: true },
	perplexity: { symbol: "perplexity", color: true },
	together: { symbol: "together", color: true },
	grok: { symbol: "grok", color: false },
};

/** 构建产物在 /static/web/ 下，开发服务器在根路径下，两者都要能取到 sprite。 */
const SPRITE_URL = import.meta.env.BASE_URL + "provider-icons.svg";

export function ProviderIcon({ id, size = 14 }: { id: string; size?: number }) {
	const icon = Object.hasOwn(PROVIDER_ICONS, id) ? PROVIDER_ICONS[id] : undefined;
	if (icon) {
		return (
			<svg
				aria-hidden="true"
				focusable="false"
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill={icon.color ? undefined : "currentColor"}
				style={{ color: "var(--muted)", flexShrink: 0 }}
			>
				<use href={`${SPRITE_URL}#${icon.symbol}`} />
			</svg>
		);
	}
	const label =
		id
			.split(/[-_]/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0])
			.join("")
			.toUpperCase() || "?";
	return (
		<span
			aria-hidden="true"
			className="cfg-provider-fallback"
			data-size={size}
			style={{ width: size, height: size }}
		>
			{label}
		</span>
	);
}
