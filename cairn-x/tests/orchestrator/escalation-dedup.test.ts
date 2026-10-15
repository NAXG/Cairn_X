import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";

import { GRAPH_PAGE_MAX_CHARS } from "../../src/contracts/graph.js";
import {
	beginDecideRead,
	completeDecide,
	computeDecideTrigger,
	getCheckpoint,
	signalDecideExternal,
} from "../../src/server/core/decide.js";
import { pendingDecideSignals } from "../../src/server/core/decide-changes.js";
import { readDecideGraph } from "../../src/server/core/planning-graph.js";
import {
	addStep,
	claimExecutionWithProjectWorker,
	createProject,
	startExecutorTestServer,
} from "./helpers.js";

const EID = "10000000-0000-4000-8000-000000000001";
const MODEL = { api: "openai-completions", base_url: "http://unused", api_key: "test" } as const;

function postSignal(url: string, token: string, reason: string) {
	return fetch(`${url}/internal/executions/${EID}/signal`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ reason }),
	});
}

async function setup(dataRoot?: string) {
	const server = await startExecutorTestServer(MODEL, { dataRoot });
	const pid = await createProject(server.client);
	const stepId = await addStep(server.client, pid);
	expect((await server.client.claimStep(pid, stepId, EID)).ok).toBe(true);
	expect(
		(await server.client.createExecution({ project_id: pid, step_id: stepId, execution_id: EID }))
			.ok,
	).toBe(true);
	const { task } = await claimExecutionWithProjectWorker(server, pid, EID);
	return {
		...server,
		pid,
		stepId,
		token: task.token,
		signal: (reason: string) => postSignal(server.url, task.token, reason),
	};
}

test("escalation identity uses the full trimmed reason, not its 500-character preview", async () => {
	const s = await setup();
	const prefix = "x".repeat(1997);
	const reasons = [`${prefix}a`, `${prefix}two`, `${prefix}tri`];
	// The padded request and the two other reasons each exercise the valid 2000-character limit.
	const first = await s.signal(` ${reasons[0]} `);
	expect(first.status).toBe(201);
	expect(await first.json()).toMatchObject({ accepted: true, count: 1, limit: 3 });
	expect(await (await s.signal(reasons[0])).json()).toMatchObject({
		accepted: false,
		count: 1,
		limit: 3,
	});

	for (const [index, reason] of reasons.slice(1).entries()) {
		const accepted = await s.signal(reason);
		expect(accepted.status).toBe(201);
		expect(await accepted.json()).toMatchObject({ accepted: true, count: index + 2, limit: 3 });
		expect(await (await s.signal(reason)).json()).toMatchObject({
			accepted: false,
			count: index + 2,
			limit: 3,
		});
	}
	const rejected = await s.signal(`${prefix}new`);
	expect(rejected.status).toBe(200);
	expect(await rejected.json()).toMatchObject({ accepted: false, count: 3, limit: 3 });
	expect(
		s.db
			.prepare(
				"SELECT detail FROM decide_changes WHERE project_id = ? AND operation = 'escalate' ORDER BY seq",
			)
			.all(s.pid),
	).toEqual(reasons.map((reason) => ({ detail: `escalated:${reason}` })));
});

test("full escalation storage keeps planning previews and both checkpoint signal paths bounded", async () => {
	const s = await setup();
	const reason = `${"p".repeat(500)}${"private-tail".repeat(125)}`;
	const preview = `escalated:${reason.slice(0, 500)}`;
	expect((await s.signal(reason)).status).toBe(201);
	expect(getCheckpoint(s.db, s.pid)?.external_signal).toBe(preview);
	expect(computeDecideTrigger(s.db, s.pid, 0)?.trigger).toContain(`external_signal:${preview}`);
	expect(computeDecideTrigger(s.db, s.pid, 0)?.trigger).not.toContain("private-tail");

	beginDecideRead(s.db, s.pid, "planner");
	const page = readDecideGraph(s.db, s.pid, { worker: "planner", view: "planning" });
	expect(page.view).toBe("planning");
	if (page.view !== "planning") throw new Error("expected planning page");
	expect(page.coverage.required_complete).toBe(true);
	expect(page.changes).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ operation: "escalate", detail: preview, subject_id: s.stepId }),
		]),
	);
	expect(stringify(page).length).toBeLessThanOrEqual(GRAPH_PAGE_MAX_CHARS);
	expect(stringify(page)).not.toContain("private-tail");

	// A signal arriving after the planning snapshot survives completeDecide. Its checkpoint
	// summary must use the same budget as the immediate signalDecideExternal write.
	const lateReason = `${"q".repeat(500)}${"late-tail".repeat(150)}`;
	const latePreview = `escalated:${lateReason.slice(0, 500)}`;
	expect((await s.signal(lateReason)).status).toBe(201);
	expect(pendingDecideSignals(s.db, s.pid, 0, null).map((row) => row.detail)).toEqual([
		preview,
		latePreview,
	]);
	completeDecide(s.db, s.pid, "planner", 0, null);
	expect(getCheckpoint(s.db, s.pid)?.external_signal).toBe(latePreview);
	expect(computeDecideTrigger(s.db, s.pid, 0)?.trigger).toContain(`external_signal:${latePreview}`);
	expect(computeDecideTrigger(s.db, s.pid, 0)?.trigger).not.toContain("late-tail");
	// Presentation never rewrites the authoritative identity.
	expect(
		s.db
			.prepare(
				"SELECT detail FROM decide_changes WHERE project_id = ? AND operation = 'escalate' ORDER BY seq",
			)
			.all(s.pid),
	).toEqual([{ detail: `escalated:${reason}` }, { detail: `escalated:${lateReason}` }]);

	// A matching text prefix alone must not change an ordinary external signal's semantics.
	const ordinarySignal = `escalated:${"manual".repeat(100)}`;
	signalDecideExternal(s.db, s.pid, ordinarySignal);
	expect(getCheckpoint(s.db, s.pid)?.external_signal).toBe(ordinarySignal);
	expect(pendingDecideSignals(s.db, s.pid, 0, null).at(-1)?.detail).toBe(ordinarySignal);
});

test("reopened legacy signals match only their surviving text and still consume the limit", async () => {
	const dataRoot = mkdtempSync(path.join(tmpdir(), "cairn-escalation-legacy-"));
	try {
		const s = await setup(dataRoot);
		const short = "existing short reason";
		const truncated = "old-prefix".repeat(50);
		for (const reason of [short, truncated]) {
			signalDecideExternal(s.db, s.pid, `escalated:${reason}`, EID, s.stepId, "escalate");
		}
		await s.close();

		const reopened = await startExecutorTestServer(MODEL, { dataRoot });
		try {
			for (const reason of [short, truncated]) {
				expect(await (await postSignal(reopened.url, s.token, ` ${reason} `)).json()).toMatchObject(
					{
						accepted: false,
						count: 2,
						limit: 3,
					},
				);
			}
			// The old row cannot prove which original suffix was discarded. Do not equate
			// a newly supplied full reason with it, or replace it with invented recovered text.
			const full = `${truncated}${"new-tail".repeat(187)}`;
			expect(await (await postSignal(reopened.url, s.token, full)).json()).toMatchObject({
				accepted: true,
				count: 3,
				limit: 3,
			});
			expect(
				await (await postSignal(reopened.url, s.token, "another reason")).json(),
			).toMatchObject({
				accepted: false,
				count: 3,
				limit: 3,
			});
			expect(
				reopened.db
					.prepare(
						"SELECT detail FROM decide_changes WHERE project_id = ? AND operation = 'escalate' ORDER BY seq",
					)
					.all(s.pid),
			).toEqual([short, truncated, full].map((reason) => ({ detail: `escalated:${reason}` })));
		} finally {
			await reopened.close();
		}
	} finally {
		rmSync(dataRoot, { recursive: true, force: true });
	}
});
