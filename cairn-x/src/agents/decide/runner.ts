import { createConfiguredSession } from "../../control/session.js";
import path from "node:path";
import { readFile, access, realpath } from "node:fs/promises";
import { createReadTool } from "@earendil-works/pi-coding-agent";
/**
 * Decide runner：图谱管理活动。
 *
 * 每次触发都会构建一个全新的 Agent（干净上下文，两次运行之间无记忆）。
 * 工具集中只包含图谱工具——绝不包含世界工具（沙箱红线）。Decide 的输出
 * 是通过其工具完成的图谱变更，因此一次成功运行无需 conclude 步骤：
 * 结果为 "success" 仅表示本次运行正常收尾。
 *
 * 模型流量走配置化的活动通道（/internal/activities/*）：控制面下发快照
 * 与短期令牌，配置不可用即失败，不做任何静态配置降级。
 */

import { HeartbeatLease } from "../../shared/heartbeat.js";
import { consoleLogger, type Logger } from "../../shared/logger.js";
import { type DecideContext } from "../../scheduler/types.js";
import { type Outcome } from "../../contracts/activity.js";
import { decideTools } from "../../orchestrator/tools/graph.js";
import { sessionFileName } from "../../contracts/transcripts.js";
import { runAgent } from "../runtime/runner.js";

const SETTLE_GRACE_SECONDS = 60;

export interface RunnerDeps {
	client: import("../../orchestrator/client.js").FgsClient;
	logger?: Logger;
	/** 会话 JSONL 文件的根目录；默认为 datas/cairn-x。 */
	dataRoot?: string;
}

export type DecideRunner = (ctx: DecideContext, signal: AbortSignal) => Promise<Outcome>;

export function createDecideRunner(deps: RunnerDeps): DecideRunner {
	return async (ctx, signal) => {
		const log = deps.logger ?? consoleLogger;
		const projectId = ctx.projectId;
		if (signal.aborted) return "cancelled";
		const renewed = await ctx.client.heartbeatDecide(projectId, ctx.worker);
		if (!renewed.ok) return "failed";
		const leaseController = new AbortController();
		const runSignal = AbortSignal.any([signal, leaseController.signal]);
		const lease = HeartbeatLease.forDecide(
			ctx.client,
			projectId,
			ctx.worker,
			renewed.heartbeatInterval ?? (renewed.leaseTimeout ?? 5) / 3,
			{
				leaseTimeoutSeconds: renewed.leaseTimeout ?? 5,
				onFailure: () => leaseController.abort("lease lost"),
				log: (message) => log.debug(message),
			},
		);
		lease.start();
		let run: Awaited<ReturnType<typeof createConfiguredSession>> | undefined;
		/** 本次运行的会话轨迹文件名：用量上报的幂等键，也是控制端补账的凭据。 */
		let transcriptFile: string | null = null;
		try {
			runSignal.throwIfAborted();

			const configured = await ctx.client.beginConfiguredDecide(projectId, ctx.worker);
			if (!configured.ok || !configured.data) {
				throw new Error(`Agent configuration unavailable: ${configured.statusCode}`);
			}
			const profile = configured.data.snapshot.profile;
			const configuredTimeout = profile.run_seconds;
			transcriptFile = sessionFileName(configured.data.snapshot.id);
			const decideToolsForSession = decideTools(ctx.client, projectId, { worker: ctx.worker });
			const pluginDirectory = configured.data.snapshot.plugins
				? path.join(
						deps.dataRoot ?? process.cwd(),
						"plugins",
						"decide",
						"releases",
						String(configured.data.snapshot.plugins.revision),
					)
				: undefined;
			if (pluginDirectory && (configured.data.snapshot.plugins?.resources.skills.length ?? 0) > 0) {
				const root = await realpath(pluginDirectory);
				const contained = async (file: string) => {
					const resolved = await realpath(file);
					if (!resolved.startsWith(root + path.sep))
						throw new Error("Skill path outside plugin release");
					return resolved;
				};
				decideToolsForSession.push(
					createReadTool(pluginDirectory, {
						operations: {
							readFile: async (file) => {
								return readFile(await contained(file));
							},
							access: async (file) => {
								await access(await contained(file));
							},
						},
					}),
				);
			}
			run = await createConfiguredSession({
				snapshot: configured.data.snapshot,
				token: configured.data.token,
				controlUrl: ctx.client.baseUrl,
				workspace: deps.dataRoot ?? process.cwd(),
				dataRoot: deps.dataRoot ?? process.cwd(),
				pluginDirectory,
				variables: {},
				tools: decideToolsForSession,
				logger: log,
			});

			const result = await runAgent({
				run,
				signal: runSignal,
				// 系统提示词跨项目逐字节相同（可命中前缀缓存）；项目名与触发原因进消息，
				// 其余权威状态（origin/goal/步骤清单）一律由 get_graph 提供，不再在消息里重复。
				initialMessage:
					`项目：${ctx.projectTitle}\n` +
					`调度触发（仅提示，不代表当前状态）：${ctx.trigger}（规划版本 v${ctx.planningVersion}）。\n` +
					"调用 get_graph 读取最新图谱，评估现有步骤并按规划流程决定是否调整。",
				timeoutMs: configuredTimeout * 1000,
				graceMs: SETTLE_GRACE_SECONDS * 1000,
				logger: log,
			});
			if (lease.failure) {
				// 项目在本次 Decide 运行期间被达成/停止时，服务端会回收 decide 租约
				// （心跳因 checkProjectActive 返回 403）。这是正常收尾，不是规划失败；
				// 只有项目仍在 active 时才按真正的租约丢失处理。
				try {
					const current = await ctx.client.getSchedulingProjectState(projectId);
					if (current.status !== "active") return "success";
				} catch (err) {
					log.warn(
						`decide lease failed and project status is unavailable: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
				return "failed";
			}
			return result.outcome;
		} finally {
			lease.stop();
			if (run) {
				try {
					const usage = run.usage();
					const flushed = await ctx.client.recordUsage(projectId, {
						activity: usage.activity,
						step_id: usage.step_id ?? null,
						// 轨迹逐条落盘、内存合计只在此刻上报一次：带上文件名后控制端既能
						// 把这笔上报做成幂等，也能在请求失败时按文件从轨迹补回同一笔。
						source_file: transcriptFile,
						model: usage.model,
						input_tokens: usage.input_tokens,
						output_tokens: usage.output_tokens,
						cache_read_tokens: usage.cache_read_tokens,
						cache_write_tokens: usage.cache_write_tokens,
					});
					if (!flushed.ok) {
						log.warn(
							`usage flush failed project=${projectId} activity=${usage.activity} status=${flushed.statusCode} ` +
								`body=${flushed.text.slice(0, 200)}`,
						);
					}
				} catch (err) {
					log.warn(
						`usage flush failed project=${projectId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				} finally {
					run.dispose();
				}
			}
		}
	};
}
