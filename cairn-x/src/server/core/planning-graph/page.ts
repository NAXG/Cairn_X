import { randomUUID } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import { GRAPH_PAGE_MAX_CHARS, compareScopedIds } from "../../../contracts/graph.js";
import {
	PLANNING_GRAPH_SCHEMA_VERSION,
	type GraphSection,
	type PlanningGraphPage,
} from "../../../contracts/planning-graph.js";
import type { Db, FactRow, HintRow } from "../../db.js";
import { ApiError } from "../base.js";
import {
	getDecideRead,
	latestDecideChange,
	pendingDetailedDecideChanges,
	saveDecideRead,
	type DecideChange,
} from "../decide-changes.js";
import {
	changeProjectionMaps,
	factProjection,
	hintProjection,
	readActiveRoutes,
	readPendingGoals,
	readProjectProjection,
	readSteps,
	selectRowsByIds,
} from "./projection.js";
import { sectionRows } from "./sections.js";

interface CursorState {
	snapshotSeq: number;
	/** 首次读取时固定的剩余内容；续页不能再按变化中的前沿重建数组。 */
	remaining: PlanningItem[];
	project: Record<string, unknown>;
	represented: Record<GraphSection, string[]>;
}

interface PlanningItem {
	bucket: "project" | "goal" | "step" | "route" | "change" | "fact" | "hint";
	value: unknown;
	changeSeq?: number;
	factId?: string;
}

function buildPlanningItems(
	db: Db,
	projectId: string,
	worker: string,
	baseObservedSeq: number,
	snapshotSeq: number,
): {
	items: PlanningItem[];
	represented: Record<string, Set<string>>;
	project: Record<string, unknown>;
} {
	const project = readProjectProjection(db, projectId);
	const goals = readPendingGoals(db, projectId);
	const steps = readSteps(db, projectId, "status IN ('open','claimed')");
	const changes = pendingDetailedDecideChanges(db, projectId, baseObservedSeq, snapshotSeq, worker);
	const maps = changeProjectionMaps(db, projectId, changes);
	const routes = readActiveRoutes(db, projectId, worker, [
		...new Set(
			[...maps.steps.values()].flatMap((s) => (typeof s.route_id === "string" ? [s.route_id] : [])),
		),
	]);
	const represented = Object.fromEntries(
		["facts", "goals", "steps", "hints", "findings", "routes"].map((key) => [
			key,
			new Set<string>(),
		]),
	) as Record<string, Set<string>>;
	/**
	 * 页面内每条记录只由一个承载区渲染正文：先到者（frontier，或同 subject 更早的
	 * 变更事件）渲染完整投影，后到者只留指向它的指针。
	 *
	 * 返回该记录此前由哪个承载区渲染过；undefined 表示本次由调用方渲染正文。
	 * 不变量由 tests/server/planning-graph.test.ts 的分区扫描守护。
	 */
	const claimedBy = new Map<string, string>();
	const claim = (section: GraphSection, id: string, by: string): string | undefined => {
		const key = `${section}:${id}`;
		const existing = claimedBy.get(key);
		if (existing !== undefined) return existing;
		claimedBy.set(key, by);
		represented[section].add(id);
		return undefined;
	};
	const items: PlanningItem[] = [{ bucket: "project", value: project }];
	// project.origin 就是 origin 事实的正文（样例更长：2000 字 vs 500 字）。把它登记成
	// 该记录的承载区，活跃步骤 from 里的 origin 与历史索引都不会再渲染第二份。
	claim("facts", "origin", "project");
	const persistent = db
		.prepare(
			"SELECT h.* FROM hints h JOIN persistent_hints p ON p.project_id=h.project_id AND p.hint_id=h.id WHERE h.project_id=? ORDER BY LENGTH(h.id),h.id",
		)
		.all(projectId) as HintRow[];
	for (const hint of persistent) {
		claim("hints", hint.id, "frontier");
		items.push({ bucket: "hint", value: { ...hintProjection(hint), persistent: true } });
	}
	for (const goal of goals) {
		claim("goals", String(goal.id), "frontier");
		items.push({ bucket: "goal", value: goal });
	}
	for (const step of steps) {
		claim("steps", String(step.id), "frontier");
		items.push({ bucket: "step", value: step });
	}
	// 变更行的正文由哪张表提供 —— 这份表同时决定「渲染哪条正文」和「该记录已呈现」。
	// 必须是唯一的一份：此前投影查表用一段嵌套三元（else 落到 steps），标记已呈现
	// 另用一张 CHANGE_SECTION（漏了 signal），两者漂移导致步骤完成信号在 changes
	// 与 history 各渲染一遍。satisfies 让将来新增 kind 漏配直接编译失败。
	const projections = {
		fact: { section: "facts", lookup: maps.facts },
		goal: { section: "goals", lookup: maps.goals },
		finding: { section: "findings", lookup: maps.findings },
		hint: { section: "hints", lookup: maps.hints },
		// steps 表没有触发器：步骤的完成/失败靠 signal 携带结构化 step id。
		signal: { section: "steps", lookup: maps.steps },
	} as const satisfies Record<
		DecideChange["kind"],
		{ section: GraphSection; lookup: Map<string, Record<string, unknown>> }
	>;
	// 起点描述已由 project.origin 正文承载，不必再作为一条 evidence fact 重复一遍。
	const evidenceFactIds = new Set<string>();
	for (const step of steps) for (const id of step.from as string[]) evidenceFactIds.add(id);
	for (const change of changes) {
		const source = change.subject_id ? projections[change.kind] : undefined;
		const projection = source?.lookup.get(change.subject_id!);
		// 变更记录自带投影，但同一条记录可能已由更高优先级的承载区（pending goal /
		// 活跃步骤）或同 subject 的更早变更事件渲染过正文：此时只留指针，否则同一份
		// 正文会被计入两遍预算。项目的根目标在第一次规划页必然命中这一条。
		const carried =
			source && projection ? claim(source.section, change.subject_id!, "changes") : undefined;
		if (change.kind === "finding" && projection)
			for (const id of (projection as { fact_ids?: string[] }).fact_ids ?? [])
				evidenceFactIds.add(id);
		items.push({
			bucket: "change",
			changeSeq: change.seq,
			factId: change.kind === "fact" ? (change.subject_id ?? undefined) : undefined,
			value: {
				kind: change.kind,
				operation: change.operation,
				subject_id: change.subject_id,
				detail: change.detail,
				record: projection
					? carried === undefined
						? projection
						: { id: change.subject_id, carried_by: carried }
					: change.subject_id
						? { id: change.subject_id, deleted: true }
						: null,
			},
		});
	}
	// 正文已经在 changes 里渲染过的记录不再重复进 evidence：引用闭包保证的是
	// 「需要时看得见」，而不是「再看一遍」。
	const evidenceFacts = selectRowsByIds<FactRow>(db, "facts", projectId, [...evidenceFactIds]).sort(
		(a, b) => compareScopedIds(a.id, b.id),
	);
	for (const row of evidenceFacts) {
		if (claim("facts", row.id, "evidence") !== undefined) continue;
		items.push({ bucket: "fact", value: factProjection(row), factId: row.id });
	}
	for (const route of routes) {
		claim("routes", String(route.id), "frontier");
		items.push({ bucket: "route", value: route });
	}
	return { items, represented, project };
}

function emptyPlanningPage(project: Record<string, unknown>): PlanningGraphPage {
	return {
		schema_version: PLANNING_GRAPH_SCHEMA_VERSION,
		view: "planning",
		// 顺序即装箱优先级：项目与根目标在最前，模型自上而下读就能先拿到起点描述，
		// 规划页按「project → frontier → changes → evidence → history → coverage」
		// 的顺序装箱（appendItem 赋同名键不会改变它已经占据的位置）。
		project,
		frontier: { goals: [], steps: [], routes: [] },
		changes: [],
		// Finding 与 Hint 只会以「变更」的身份进入规划页（它们都是人工/执行者新增的
		// 记录，第一次出现必然是待处理变化）；没有变化引用它们时就是历史，按 section
		// 或 record 读。这里只留引用闭包真正会填充的 evidence.facts。
		evidence: { facts: [] },
		history: {},
		// 占位保持键序：真正被截断时才在 fillHistoryIndexes 里置 true，
		// 未截断的页面在收尾时把这个占位删掉（不留 false 噪声）。
		history_truncated: false,
		coverage: { required_complete: false, next_cursor: null },
	};
}

function appendItem(page: PlanningGraphPage, item: PlanningItem): void {
	if (item.bucket === "project") page.project = item.value;
	else if (item.bucket === "goal") page.frontier.goals.push(item.value);
	else if (item.bucket === "step") page.frontier.steps.push(item.value);
	else if (item.bucket === "route") page.frontier.routes.push(item.value);
	else if (item.bucket === "change") page.changes.push(item.value);
	else if (item.bucket === "hint") (page.frontier.hints ??= []).push(item.value);
	else page.evidence.facts.push(item.value);
}

function removeItem(page: PlanningGraphPage, item: PlanningItem): void {
	if (item.bucket === "project") delete page.project;
	else if (item.bucket === "goal") page.frontier.goals.pop();
	else if (item.bucket === "step") page.frontier.steps.pop();
	else if (item.bucket === "route") page.frontier.routes.pop();
	else if (item.bucket === "change") page.changes.pop();
	else if (item.bucket === "hint") {
		page.frontier.hints?.pop();
		if (!page.frontier.hints?.length) delete page.frontier.hints;
	} else page.evidence.facts.pop();
}

/**
 * 在 [0, n] 里找最大的 k，使前 k 项放进页面后仍不超预算。页面大小随 k 单调
 * 不减，因此先倍增再折半即可：O(log n) 次整页序列化，而不是每追加一项都
 * 序列化一次（页面约 60k 字符，逐项检查会随条目数平方增长）。setPrefix(k)
 * 负责把页面调整为恰好包含前 k 项。
 */
function largestFittingPrefix(
	n: number,
	setPrefix: (k: number) => void,
	fits: () => boolean,
): number {
	let good = 0;
	let bad = n + 1;
	for (let probe = 1; probe <= n; probe *= 2) {
		setPrefix(probe);
		if (!fits()) {
			bad = probe;
			break;
		}
		good = probe;
	}
	while (bad - good > 1) {
		const mid = Math.floor((good + bad) / 2);
		setPrefix(mid);
		if (fits()) good = mid;
		else bad = mid;
	}
	setPrefix(good);
	return good;
}

/**
 * 历史索引只列出每个分区最近这几条，够让 Decide 知道「历史里还有什么」；
 * 更早的记录用 view:"section" 按需翻，不占每轮规划页的预算。
 */
const HISTORY_INDEX_LIMIT = 20;

function fillHistoryIndexes(
	db: Db,
	projectId: string,
	page: PlanningGraphPage,
	represented: Record<string, Set<string>>,
): void {
	for (const section of ["steps", "findings", "facts", "goals", "hints", "routes"] as const) {
		const candidates = sectionRows(db, projectId, section, {
			exclude: [...represented[section]],
			limit: HISTORY_INDEX_LIMIT + 1,
			descending: true,
		});
		if (candidates.length === 0) continue;
		const records = candidates.slice(0, HISTORY_INDEX_LIMIT);
		const accepted: unknown[] = [];
		page.history[section] = accepted;
		largestFittingPrefix(
			records.length,
			(k) => accepted.splice(0, accepted.length, ...records.slice(0, k)),
			() => stringifyYaml(page).length <= GRAPH_PAGE_MAX_CHARS,
		);
		if (accepted.length === 0) delete page.history[section];
		// 索引被截断（超过每分区上限，或整页预算被前面分区吃满）：模型据此知道
		// 「还有历史」，用 view:"section" 翻完整索引。
		if (accepted.length < candidates.length) page.history_truncated = true;
	}
}

export function readPlanningGraph(
	db: Db,
	projectId: string,
	worker: string,
	cursor?: string,
): PlanningGraphPage {
	const read = getDecideRead(db, projectId, worker);
	if (!read) throw new ApiError(409, "Decide read state is missing");
	let state: CursorState;
	if (cursor === undefined) {
		if (read.coverage_complete !== 1 && read.next_cursor)
			throw new ApiError(409, `Continue planning graph with cursor ${read.next_cursor}`);
		const snapshotSeq = latestDecideChange(db, projectId);
		const snapshot = buildPlanningItems(db, projectId, worker, read.observed_seq, snapshotSeq);
		state = {
			snapshotSeq,
			remaining: snapshot.items,
			project: snapshot.project,
			represented: Object.fromEntries(
				Object.entries(snapshot.represented).map(([section, ids]) => [section, [...ids]]),
			) as Record<GraphSection, string[]>,
		};
	} else {
		if (cursor !== read.next_cursor || !read.cursor_state)
			throw new ApiError(409, "Planning graph cursor is stale or does not belong to this lease");
		state = JSON.parse(read.cursor_state) as CursorState;
	}
	const items = state.remaining;
	const page = emptyPlanningPage(state.project);
	let shown = 0;
	const index = largestFittingPrefix(
		items.length,
		(k) => {
			for (; shown < k; shown++) appendItem(page, items[shown]);
			for (; shown > k; shown--) removeItem(page, items[shown - 1]);
		},
		() => stringifyYaml(page).length <= GRAPH_PAGE_MAX_CHARS,
	);
	if (index === 0 && items.length > 0)
		throw new ApiError(400, "A required planning graph item exceeds the 60000 character budget");
	const remainingChanges = items
		.slice(index)
		.filter((item) => item.bucket === "change" && item.changeSeq !== undefined);
	const observedThrough =
		remainingChanges.length > 0
			? Math.max(read.observed_seq, remainingChanges[0].changeSeq! - 1)
			: state.snapshotSeq;
	let lastFactId = read.last_fact_id;
	for (const item of items.slice(0, index)) {
		if (
			item.factId &&
			item.factId !== "origin" &&
			(lastFactId === null || compareScopedIds(item.factId, lastFactId) > 0)
		)
			lastFactId = item.factId;
	}
	const complete = index >= items.length;
	const nextCursor = complete ? null : randomUUID();
	page.coverage.required_complete = complete;
	page.coverage.next_cursor = nextCursor;
	if (complete)
		fillHistoryIndexes(
			db,
			projectId,
			page,
			Object.fromEntries(
				Object.entries(state.represented).map(([section, ids]) => [section, new Set(ids)]),
			) as Record<string, Set<string>>,
		);
	if (page.history_truncated === false) delete page.history_truncated;
	if (stringifyYaml(page).length > GRAPH_PAGE_MAX_CHARS)
		throw new ApiError(500, "Planning graph page exceeded its output budget");
	saveDecideRead(db, projectId, worker, {
		observed_seq: observedThrough,
		last_fact_id: lastFactId,
		coverage_complete: complete ? 1 : 0,
		next_cursor: nextCursor,
		cursor_state: complete
			? null
			: JSON.stringify({ ...state, remaining: items.slice(index) } satisfies CursorState),
	});
	return page;
}
