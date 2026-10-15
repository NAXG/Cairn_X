export function canonicalMutation(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalMutation).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([key, item]) => key !== "request_id" && item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalMutation(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
