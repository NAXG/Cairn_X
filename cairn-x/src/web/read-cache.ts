/** Bounded conditional JSON cache. Each frontend tab owns its module instance. */
const readCache = new Map<string, { etag: string; data: unknown; size: number }>();
let cacheGeneration = 0;
export function clearReadCache() {
	readCache.clear();
	cacheGeneration++;
}
export async function cachedJSON<T>(
	path: string,
	options: RequestInit,
	ensureOk: (res: Response) => Promise<void>,
): Promise<T> {
	const reading = (options.method ?? "GET").toUpperCase() === "GET";
	if (!reading) clearReadCache();
	const generation = cacheGeneration;
	const cached = reading ? readCache.get(path) : undefined;
	const headers = new Headers(options.headers);
	if (cached) headers.set("If-None-Match", cached.etag);
	let res = await fetch(path, { ...options, headers, cache: "no-store" });
	if (res.status === 304) {
		if (cached && generation === cacheGeneration) return cached.data as T;
		headers.delete("If-None-Match");
		res = await fetch(path, { ...options, headers, cache: "no-store" });
	}
	if (res.status === 401) clearReadCache();
	if (!res.ok) readCache.delete(path);
	await ensureOk(res);
	if (res.status === 204) return null as T;
	const body = await res.text();
	const data = body.trim() === "" ? null : JSON.parse(body);
	const etag = res.headers.get("etag");
	if (
		reading &&
		etag &&
		!options.signal?.aborted &&
		generation === cacheGeneration &&
		body.length * 2 <= 32 * 1024 * 1024
	) {
		readCache.delete(path);
		readCache.set(path, { etag, data, size: body.length * 2 });
		let total = [...readCache.values()].reduce((sum, e) => sum + e.size, 0);
		while (readCache.size > 32 || total > 32 * 1024 * 1024) {
			const key = readCache.keys().next().value!;
			total -= readCache.get(key)!.size;
			readCache.delete(key);
		}
	}
	return data as T;
}
