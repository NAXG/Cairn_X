/**
 * Worker 本地世界工具：read / bash / edit / write 直接操作容器内 /workspace。
 * read/edit/write 用 pi 原生实现；bash 可选原生一次性工具或常驻 shell，
 * 都不经任何 docker 通道。
 *
 * 输出体积由 pi 原生工具自己兜底：bash 保留末尾 2000 行 / 50KB 并把完整输出
 * 落到临时文件（提示里带路径），read 保留开头并提示用 offset/limit 继续读。
 * 这里不叠第二层截断。
 *
 * 收割阶段的"关闭世界动作"不在这里实现：它由会话层的 beforeToolCall 闸门
 * 统一处理（见 control/session.ts 与 worker/agent.ts 的 makeHarvestGate），
 * 这样拦截发生在框架层，被拦的调用根本不会进入工具实现。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createCodingTools } from "@earendil-works/pi-coding-agent";

import {
	bashTimeoutPolicyText,
	createPersistentBashTool,
	formatCommandDuration,
	type PersistentBashHandle,
} from "./persistentbash.js";

const DEFAULT_BASH_TIMEOUT_SECONDS = 300;
/**
 * 给 bash 注入超时。
 *
 * PI 的 bash 工具把 timeout 设为**可选且无默认值**（见 pi-coding-agent
 * core/tools/bash.js 的 "optional, no default timeout"）。模型不传就无限等，
 * 一条全端口扫描能跑 20+ 分钟，把 agent loop 卡死在工具边界上；而 1/3、2/3 的
 * 进度提醒与软预算 requestStop 都只在**回合边界**生效 —— 于是软收尾永不触发，
 * 只能等控制端硬 deadline 杀容器，已确认未提交的事实全部丢失。
 *
 * 注入后单条命令必然返回，回合边界重新可达；模型显式传入的 timeout 原样使用，
 * 长作业需要模型自己分批或后台化。
 */
export function withBashTimeout(tool: AgentTool, defaultSeconds: number): AgentTool {
	return {
		...tool,
		// 策略文本与 persistent bash 共用同一份措辞（persistentbash.ts），改一处即同步。
		description: tool.description + bashTimeoutPolicyText(defaultSeconds),
		execute: async (toolCallId, params, signal, onUpdate) => {
			const requested = (params as { timeout?: unknown } | undefined)?.timeout;
			const seconds =
				typeof requested === "number" && Number.isFinite(requested) && requested > 0
					? requested
					: defaultSeconds;
			const startedAt = Date.now();
			const result = await tool.execute(
				toolCallId,
				{ ...(params as Record<string, unknown>), timeout: seconds },
				signal,
				onUpdate,
			);
			return annotateCommandDuration(result, Date.now() - startedAt);
		},
	};
}

/**
 * 把命令耗时补进工具结果。
 *
 * PI 自带的 bash 工具不报耗时，代价对模型完全不可见：它只能凭感觉选字典与扫描
 * 范围。persistent 模式在 persistentbash.ts 里自己拼这个标记，这里补上 one-shot
 * 那半，两种模式给模型的信号保持一致。
 */
function annotateCommandDuration<T>(result: T, durationMs: number): T {
	if (typeof result !== "object" || result === null) return result;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return result;
	const last = content.at(-1) as { type?: string; text?: string } | undefined;
	if (last?.type !== "text" || typeof last.text !== "string") return result;
	last.text += "\n[Command finished in " + formatCommandDuration(durationMs) + "]";
	return result;
}

interface LocalWorldToolsOptions {
	workspaceDir: string;
	bashTimeoutSeconds?: number;
	/** 需要装配的世界工具名（read/bash/edit/write 的子集）；缺省装配全部。 */
	toolNames?: string[];
	/** bash 槽位：one-shot = PI 一次性 bash -c；persistent = 常驻 shell。 */
	bashMode?: "one-shot" | "persistent";
	/** 覆盖持久 bash 的工具说明。 */
	bashDescription?: string;
}

interface LocalWorldTools {
	tools: AgentTool[];
	dispose: () => Promise<void>;
}

/** 构建本地世界工具集（read/bash/edit/write，作用域 workspaceDir）。 */
export async function createLocalWorldTools(
	options: LocalWorldToolsOptions,
): Promise<LocalWorldTools> {
	const seconds = options.bashTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS;
	const available = new Map(
		createCodingTools(options.workspaceDir).map((tool) => [tool.name, tool]),
	);
	const names = [...new Set(options.toolNames ?? [...available.keys()])];
	const tools: AgentTool[] = [];
	let persistent: PersistentBashHandle | undefined;
	for (const name of names) {
		if (name === "bash" && options.bashMode === "persistent") {
			persistent = createPersistentBashTool({
				workspaceDir: options.workspaceDir,
				timeoutMs: seconds * 1000,
				description: options.bashDescription,
			});
			tools.push(persistent.tool);
			continue;
		}
		const tool = available.get(name);
		if (tool === undefined) continue;
		tools.push(name === "bash" ? withBashTimeout(tool, seconds) : tool);
	}
	return {
		tools,
		dispose: async () => {
			await persistent?.dispose();
		},
	};
}
