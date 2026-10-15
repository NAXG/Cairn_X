/** ISO-8601 秒级 UTC 时间戳（去掉毫秒），全库统一的时间表示。 */
export function utcnow(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
