import { registerTestDatabase } from "../support/project-state.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Hono } from "hono";
import { onTestFinished } from "vitest";

import { createApp } from "../../src/server/app.js";
import { openDatabase, type Db } from "../../src/server/db.js";

export interface TestServer {
	app: Hono;
	db: Db;
}

export interface TestResponse extends Response {
	json(): Promise<any>;
}

/** `dataRoot` 缺省时用默认数据目录（仓库内的 datas/cairn-x，通常没有 sessions）。 */
export function createTestServer(options: { dataRoot?: string } = {}): TestServer {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-server-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const app = registerTestDatabase(createApp(db, undefined, undefined, options.dataRoot), db);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { app, db };
}

async function request(
	app: Hono,
	method: string,
	url: string,
	body?: unknown,
): Promise<TestResponse> {
	return (await app.request(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	})) as TestResponse;
}

export function get(app: Hono, url: string): Promise<TestResponse> {
	return request(app, "GET", url);
}

export function post(app: Hono, url: string, body?: unknown): Promise<TestResponse> {
	return request(app, "POST", url, body);
}

/**
 * 为「只想读规划图」的测试取一个 Decide 租约。
 *
 * claim 需要真实触发条件；已有 open/claimed 步骤而尚无 checkpoint 的项目
 * 只会写静默基线并返回 409。先发一个信号保证触发存在，再认领。
 */
export async function claimDecideForRead(
	app: Hono,
	projectId: string,
	worker: string,
): Promise<void> {
	await post(app, `/projects/${projectId}/decide/signal`, { signal: "read-graph" });
	const claim = await post(app, `/projects/${projectId}/decide/claim`, { worker });
	if (!claim.ok) throw new Error(`decide claim failed: ${claim.status} ${await claim.text()}`);
}

/** Read every required Decide planning page for the current lease. */
export async function readPlanningGraph(app: Hono, projectId: string, worker: string) {
	const pages: any[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 1000; page++) {
		const response = await post(app, `/projects/${projectId}/decide/graph`, {
			worker,
			view: "planning",
			...(cursor === undefined ? {} : { cursor }),
		});
		if (!response.ok)
			throw new Error(`planning graph failed: ${response.status} ${await response.text()}`);
		const body = await response.json();
		pages.push(body);
		cursor = body.coverage.next_cursor ?? undefined;
		if (body.coverage.required_complete) return pages;
	}
	throw new Error("planning graph pagination did not converge");
}

export function patch(app: Hono, url: string, body?: unknown): Promise<TestResponse> {
	return request(app, "PATCH", url, body);
}

export function del(app: Hono, url: string): Promise<TestResponse> {
	return request(app, "DELETE", url + (url.includes("/goals/") ? "?actor=human" : ""));
}

export async function createProject(
	app: Hono,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const res = await post(app, "/projects", {
		title: "test",
		origin: "starting point",
		goal: "finish",
		hints: [{ content: "initial clue", creator: "human" }],
		...extra,
	});
	if (res.status !== 201) {
		throw new Error(`createProject failed: ${res.status} ${await res.text()}`);
	}
	const detail = (await res.json()) as { project: { id: string } };
	return detail.project.id;
}

export function backdateStepHeartbeat(
	db: Db,
	projectId: string,
	stepId: string,
	timestamp: string,
): void {
	db.prepare(
		"UPDATE steps SET lease_expires_at = NULL, last_heartbeat_at = ? WHERE id = ? AND project_id = ?",
	).run(timestamp, stepId, projectId);
}

export function backdateDecideHeartbeat(db: Db, projectId: string, timestamp: string): void {
	db.prepare(
		"UPDATE projects SET decide_expires_at = NULL, decide_last_heartbeat_at = ? WHERE id = ?",
	).run(timestamp, projectId);
}

export function secondsAgo(n: number): string {
	return new Date(Date.now() - n * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
