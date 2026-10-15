/**
 * 控制端 HTTP 客户端的共享请求件。
 *
 * 三个客户端（dispatcher 的 FgsClient、WorkerClient、ProjectWorkerClient）
 * 的请求路径逐行相同：鉴权头 + 可选 JSON body、JSON 解析、统一的
 * `{statusCode, ok, data, text}` 结果形状、网络错误 → statusCode 0。
 * 差异（租约响应头）由各自的包装层处理，避免三份
 * 实现各自漂移。
 */

interface HttpResult<T = unknown> {
	statusCode: number;
	ok: boolean;
	data: T | undefined;
	text: string;
	/** 响应头；网络错误时为空 Headers。 */
	headers: Headers;
}

/**
 * 发起一次请求并把响应归一化为 HttpResult。绝不抛异常：传输层错误统一
 * 映射为 `statusCode: 0, ok: false`，由调用方按既有控制流分支处理。
 */
export async function requestJson<T = unknown>(options: {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: unknown;
	timeoutMs: number;
	/** 注入 fetch 便于测试；默认全局 fetch。 */
	fetchImpl?: typeof fetch;
}): Promise<HttpResult<T>> {
	const doFetch = options.fetchImpl ?? fetch;
	let response: Response;
	let text: string;
	try {
		const headers = new Headers(options.headers);
		if (options.body !== undefined) headers.set("Content-Type", "application/json");
		response = await doFetch(options.url, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		text = await response.text();
	} catch (err) {
		return {
			statusCode: 0,
			ok: false,
			data: undefined,
			text: err instanceof Error ? err.message : String(err),
			headers: new Headers(),
		};
	}
	const isJson = (response.headers.get("content-type") ?? "")
		.toLowerCase()
		.startsWith("application/json");
	let data: T | undefined;
	if (text !== "" && isJson) {
		try {
			data = JSON.parse(text) as T;
		} catch {
			// A malformed body does not turn an HTTP response into a transport error.
		}
	}
	return { statusCode: response.status, ok: response.ok, data, text, headers: response.headers };
}
