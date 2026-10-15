/**
 * 终端输出清洗：把 PTY 的原始文本变成行式可读文本。剥掉 CSI/OSC 和短转义、
 * 处理跨块截断的转义序列、把 CR 归一成 LF；不做完整终端模拟。
 *
 * 注意：**哨兵解析仍跑在原始 buffer 上**，这里只清洗抽取出来的命令输出。
 */

const ESC = "\x1B";
const BEL = "\x07";
const ST = "\x1B\\";

interface SanitizedChunk {
	text: string;
}

/** CRLF 与独立 CR 归一成 LF；BEL 直接删除。 */
function normalizeTerminalText(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll(BEL, "");
}

export class TerminalSanitizer {
	private pending = "";
	private discardMode: "csi" | "osc" | undefined;
	private discardOscEscape = false;
	private trailingCarriageReturn = false;

	constructor(private readonly maxPendingBytes: number = 4 * 1024 * 1024) {}

	/** 消费一块解码后的终端文本，返回可打印文本与是否出现提示符标记。 */
	push(chunk: string): SanitizedChunk {
		this.pending += this.discardPrefix(chunk);
		let text = "";
		let index = 0;
		while (index < this.pending.length) {
			const escape = this.pending.indexOf(ESC, index);
			if (escape < 0) {
				text += this.pending.slice(index);
				index = this.pending.length;
				break;
			}
			text += this.pending.slice(index, escape);
			if (escape + 1 >= this.pending.length) {
				index = escape;
				break;
			}
			const kind = this.pending[escape + 1];
			if (kind === "]") {
				const bel = this.pending.indexOf(BEL, escape + 2);
				const stringTerminator = this.pending.indexOf(ST, escape + 2);
				let end = -1;
				if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2);
				else if (bel >= 0) end = bel + 1;
				else if (stringTerminator >= 0) end = stringTerminator + 2;
				if (end < 0) {
					index = escape;
					break;
				}
				index = end;
				continue;
			}
			if (kind === "[") {
				let end = escape + 2;
				let invalid = false;
				while (end < this.pending.length) {
					const code = this.pending.charCodeAt(end);
					if (code >= 64 && code <= 126) break;
					if (code < 32 || code > 63) {
						invalid = true;
						break;
					}
					end += 1;
				}
				if (invalid) {
					index = end;
					continue;
				}
				if (end >= this.pending.length) {
					index = escape;
					break;
				}
				index = end + 1;
				continue;
			}
			index = escape + 2;
		}
		this.pending = this.pending.slice(index);
		this.enforcePendingBound();
		return { text: this.normalizeText(text) };
	}

	/** PTY 结束时冲刷尾部可打印文本；不完整的转义序列被丢弃。 */
	flush(): string {
		const text = this.pending.startsWith(ESC) ? "" : this.pending;
		this.pending = "";
		this.discardMode = undefined;
		this.discardOscEscape = false;
		const normalized = this.normalizeText(text);
		if (!this.trailingCarriageReturn) return normalized;
		this.trailingCarriageReturn = false;
		return normalized + "\n";
	}

	private normalizeText(text: string): string {
		// 块尾的 CR 先挂起：下一块开头若是 LF 说明是 CRLF，否则是独立 CR。
		let complete = this.trailingCarriageReturn ? "\r" + text : text;
		this.trailingCarriageReturn = false;
		if (complete.endsWith("\r")) {
			complete = complete.slice(0, -1);
			this.trailingCarriageReturn = true;
		}
		return normalizeTerminalText(complete);
	}

	private enforcePendingBound(): void {
		if (Buffer.byteLength(this.pending, "utf8") <= this.maxPendingBytes) return;
		this.discardMode = this.pending[1] === "]" ? "osc" : "csi";
		this.pending = "";
	}

	private discardPrefix(chunk: string): string {
		if (this.discardMode === undefined) return chunk;
		if (this.discardMode === "csi") {
			for (let index = 0; index < chunk.length; index += 1) {
				const code = chunk.charCodeAt(index);
				if (code >= 64 && code <= 126) {
					this.discardMode = undefined;
					return chunk.slice(index + 1);
				}
			}
			return "";
		}
		let index = 0;
		if (this.discardOscEscape) {
			this.discardOscEscape = false;
			if (chunk.startsWith("\\")) {
				this.discardMode = undefined;
				return chunk.slice(1);
			}
		}
		while (index < chunk.length) {
			if (chunk[index] === BEL) {
				this.discardMode = undefined;
				return chunk.slice(index + 1);
			}
			if (chunk[index] === ESC) {
				if (chunk[index + 1] === "\\") {
					this.discardMode = undefined;
					return chunk.slice(index + 2);
				}
				if (index + 1 === chunk.length) this.discardOscEscape = true;
			}
			index += 1;
		}
		return "";
	}
}

/**
 * 一次性清洗：给不跨块的场景用（工具从完整缓冲里切出的命令输出）。
 * 内部仍走同一个跨块状态机，末尾 flush 一次。
 */
export function sanitizeTerminalOutput(text: string): string {
	if (text.length === 0) return text;
	const sanitizer = new TerminalSanitizer(Math.max(text.length * 2, 1024));
	const pushed = sanitizer.push(text).text;
	return pushed + sanitizer.flush();
}
