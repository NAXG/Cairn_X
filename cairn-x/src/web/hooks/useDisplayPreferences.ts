import { useCallback, useSyncExternalStore } from "react";

/** 轨迹相关显示偏好：只影响当前浏览器，不写入服务端。 */
const TRACE_FONT_KEY = "cairn-trace-font";
const TRACE_WIDTH_KEY = "cairn-trace-width";
const TRACE_THINKING_KEY = "cairn-trace-thinking-open";

export const TRACE_FONT_DEFAULT = 14;
export const TRACE_FONT_RANGE = { min: 12, max: 20, step: 1 } as const;
export const TRACE_WIDTH_DEFAULT = 820;
export const TRACE_WIDTH_RANGE = { min: 480, max: 1200, step: 20 } as const;

type DisplayPreferences = {
	traceFont: number;
	traceWidth: number;
	thinkingOpen: boolean;
};

const listeners = new Set<() => void>();
let cache: DisplayPreferences | null = null;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		const value = Number(raw);
		return Number.isFinite(value) ? clamp(value, min, max) : fallback;
	} catch {
		return fallback;
	}
}

function readBoolean(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return raw === "true" || raw === "1";
	} catch {
		return fallback;
	}
}

/** 把偏好写进文档级 CSS 变量；轨迹列表和消息正文都读这两个变量。 */
function applyToDocument(prefs: DisplayPreferences): void {
	const root = document.documentElement.style;
	root.setProperty("--cairn-trace-font", prefs.traceFont + "px");
	root.setProperty("--transcript-max-width", prefs.traceWidth + "px");
}

function emit(): void {
	listeners.forEach((cb) => cb());
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function read(): DisplayPreferences {
	if (cache) return cache;
	cache = {
		traceFont: readNumber(
			TRACE_FONT_KEY,
			TRACE_FONT_DEFAULT,
			TRACE_FONT_RANGE.min,
			TRACE_FONT_RANGE.max,
		),
		traceWidth: readNumber(
			TRACE_WIDTH_KEY,
			TRACE_WIDTH_DEFAULT,
			TRACE_WIDTH_RANGE.min,
			TRACE_WIDTH_RANGE.max,
		),
		thinkingOpen: readBoolean(TRACE_THINKING_KEY, false),
	};
	return cache;
}

function write(key: string, value: number | boolean): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// 隐私模式或配额不足时仅本次会话生效。
	}
}

function update(key: string, value: number | boolean, patch: Partial<DisplayPreferences>): void {
	const next = { ...read(), ...patch };
	cache = next;
	write(key, value);
	applyToDocument(next);
	emit();
}

/** 首屏调用一次：把已保存的偏好写进 CSS 变量，避免默认宽度闪一下。 */
export function applyStoredDisplayPreferences(): void {
	applyToDocument(read());
}

export function useDisplayPreferences() {
	const prefs = useSyncExternalStore(subscribe, read);
	const setTraceFont = useCallback((value: number) => {
		const traceFont = clamp(Math.round(value), TRACE_FONT_RANGE.min, TRACE_FONT_RANGE.max);
		update(TRACE_FONT_KEY, traceFont, { traceFont });
	}, []);
	const setTraceWidth = useCallback((value: number) => {
		const traceWidth = clamp(Math.round(value), TRACE_WIDTH_RANGE.min, TRACE_WIDTH_RANGE.max);
		update(TRACE_WIDTH_KEY, traceWidth, { traceWidth });
	}, []);
	const setThinkingOpen = useCallback((value: boolean) => {
		update(TRACE_THINKING_KEY, value, { thinkingOpen: value });
	}, []);
	return {
		prefs,
		setTraceFont,
		setTraceWidth,
		setThinkingOpen,
		resetTraceFont: () => setTraceFont(TRACE_FONT_DEFAULT),
		resetTraceWidth: () => setTraceWidth(TRACE_WIDTH_DEFAULT),
	};
}
