import type { TranscriptEntry } from "../../../contracts/transcripts.js";
/** Only pair explicit IDs; parallel calls with identical names remain distinct. */
export function toolLinks(entries: TranscriptEntry[]) {
	const calls = new Map<string, number>();
	const results = new Map<string, number>();
	for (const entry of entries) {
		const message = entry.record?.message as Record<string, unknown> | undefined;
		if (!message) continue;
		if (message.role === "toolResult" && typeof message.toolCallId === "string")
			results.set(message.toolCallId, entry.seq);
		if (Array.isArray(message.content))
			for (const raw of message.content) {
				if (raw && typeof raw === "object" && raw.type === "toolCall" && typeof raw.id === "string")
					calls.set(raw.id, entry.seq);
			}
	}
	return { calls, results };
}
