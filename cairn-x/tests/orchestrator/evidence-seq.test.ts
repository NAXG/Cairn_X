/**
 * 证据 seq 直供机制。
 *
 * 模型提交 fact/finding 需要引用已持久化事件的 (execution_id, seq)。此前它无法
 * 直接读到这两个值，只能先 search_execution_events 再 get_execution_trace 反查，
 * 每个 step 都多付两次 LLM 往返。这里锁定三件事：
 *
 * - 首条用户消息给出 execution_id（吊在末尾，不破坏跨步公共前缀）；
 * - 工具结果本体末尾带上它自己的事件 seq；
 * - EventPump 的取号与实际分配严格一致（否则标出来的 seq 是错的）。
 */
import { expect, test } from "vitest";

import { annotateEventSeq } from "../../src/control/session.js";
import { EventPump } from "../../src/worker/agent.js";
import type { WorkerClient } from "../../src/worker/client.js";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as never;

function pumpWith(stub: Partial<WorkerClient> = {}): EventPump {
	return new EventPump(stub as unknown as WorkerClient, silentLogger);
}

test("annotateEventSeq appends the marker to the last text part", () => {
	const message = {
		role: "toolResult",
		content: [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		],
	};
	annotateEventSeq(message, 12);
	expect(message.content[0].text).toBe("first");
	expect(message.content[1].text).toBe("second\n[event seq=12]");
});

test("annotateEventSeq handles string content and leaves non-text payloads intact", () => {
	const asString = { content: "boom" };
	annotateEventSeq(asString, 3);
	expect(asString.content).toBe("boom\n[event seq=3]");

	// 末段不是文本（例如图片）就不硬塞标记：序号出现在图片字节里毫无意义。
	const noText = { content: [{ type: "image", data: "..." }] };
	annotateEventSeq(noText, 4);
	expect(noText.content).toEqual([{ type: "image", data: "..." }]);

	const empty = { content: [] };
	annotateEventSeq(empty, 5);
	expect(empty.content).toEqual([]);
});

test("peekNextSeq matches the seq the pump is about to assign", async () => {
	const seen: number[] = [];
	const pump = pumpWith({
		sendEvents: async (events) => {
			seen.push(...events.map((e) => e.seq));
			return {
				statusCode: 200,
				ok: true,
				data: { session_seq: events.at(-1)?.seq ?? 0, applied: events.length },
				text: "",
			} as never;
		},
	});
	// 取号在 sink 之前，且两者必须一致 —— 标注错了比不标更糟。
	const before = pump.peekNextSeq();
	pump.sink("a");
	const afterFirst = pump.peekNextSeq();
	pump.sink("b");
	await pump.stop();

	expect(before).toBe(1);
	expect(afterFirst).toBe(2);
	expect(seen).toEqual([1, 2]);
});
