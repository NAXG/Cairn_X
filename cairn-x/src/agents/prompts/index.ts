/**
 * Decide / Execute 活动的 prompt 加载与渲染。
 *
 * 模板是带有 `{placeholder}` 占位符的 markdown 文件，由 renderPrompt 填充。
 * 任何未提供值的占位符都会让渲染直接报错，
 * 这样变量改名后就不会出现只填了一半的 prompt 被发出。
 *
 * 模板只承载角色职责、工作流程与证据原则，不重复工具参数说明。
 * Execute 首条用户消息包含当前 Step、直接引用的 facts 与项目 Finding 契约；
 * Decide 的逐次消息包含项目名与触发原因。系统提示词因此成为跨步骤逐字节
 * 稳定的前缀，可以命中供应商的前缀缓存。
 *
 * execute 模板（execute.md）唯一保留的占位符是 `{container_semantics}`：
 * 由项目 Worker 覆写为项目常驻容器说明；控制端预览/校验时以空段落渲染。
 */

import { readFileSync } from "node:fs";

type PromptName = "decide" | "execute";

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

export function loadPrompt(name: PromptName): string {
	const file = new URL(`./${name}.md`, import.meta.url);
	return readFileSync(file, "utf-8");
}

export function renderPrompt(template: string, vars: Record<string, string | number>): string {
	const missing = new Set<string>();
	const rendered = template.replace(PLACEHOLDER, (match, name: string) => {
		const value = vars[name];
		if (value === undefined) {
			missing.add(name);
			return match;
		}
		return String(value);
	});
	if (missing.size > 0) {
		throw new Error(`unresolved prompt placeholder(s): ${[...missing].join(", ")}`);
	}
	return rendered;
}
