import { cachedJSON } from "./read-cache.js";
import { useCallback, useEffect, useState } from "react";
/** 统一的响应处理：401 跳登录，非 2xx 抛出后端 detail 或状态码。 */
async function ensureOk(res: Response): Promise<void> {
	if (res.status === 401) {
		window.location.assign(import.meta.env.DEV ? "/auth" : "/");
		throw new Error("登录已过期");
	}
	if (!res.ok) {
		const data: unknown = await res.json().catch(() => null);
		const detail =
			typeof data === "object" &&
			data !== null &&
			"detail" in data &&
			typeof data.detail === "string"
				? data.detail
				: undefined;
		throw Object.assign(
			new Error(
				detail ||
					(res.status === 501
						? "此服务器未配置文件上传，请配置上传后端后重试。"
						: `请求失败 (${res.status})`),
			),
			{ status: res.status },
		);
	}
}
export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	return cachedJSON<T>(path, options, ensureOk);
}
export const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});
/** 轮询结果与上一轮内容相同就复用旧引用，避免无变化的轮询触发整棵树重渲染。 */
export const sameJson = (a: unknown, b: unknown) =>
	a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
export function usePoll<T>(url: string | null, interval = 3000) {
	const [state, setState] = useState<{
		key: string | null;
		data?: T;
		error: string;
		loading: boolean;
	}>({ key: url, error: "", loading: !!url });
	const [version, setVersion] = useState(0);
	const refresh = useCallback(() => setVersion((v) => v + 1), []);
	useEffect(() => {
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		let controller: AbortController | null = null;
		setState((s) => (s.key === url ? s : { key: url, error: "", loading: !!url }));
		const run = async () => {
			clearTimeout(timer);
			if (disposed || !url || document.hidden || controller) return;
			controller = new AbortController();
			try {
				const data = await api<T>(url, { signal: controller.signal });
				if (!disposed && !controller.signal.aborted)
					setState((s) =>
						s.key === url && !s.error && !s.loading && sameJson(s.data, data)
							? s
							: { key: url, data, error: "", loading: false },
					);
			} catch (e) {
				if (!disposed && !controller.signal.aborted)
					setState((s) => ({
						...s,
						key: url,
						error: (e as Error).message,
						...((e as { status?: number }).status === 404 ? { data: undefined } : {}),
						loading: false,
					}));
			} finally {
				controller = null;
				if (!disposed) timer = setTimeout(run, interval);
			}
		};
		const visible = () => {
			if (document.hidden) {
				clearTimeout(timer);
				controller?.abort();
			} else void run();
		};
		document.addEventListener("visibilitychange", visible);
		void run();
		return () => {
			disposed = true;
			clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", visible);
		};
	}, [url, interval, version]);
	return {
		...(state.key === url ? state : { data: undefined, error: "", loading: !!url }),
		refresh,
	};
}

export type PollState<T> = ReturnType<typeof usePoll<T>>;
