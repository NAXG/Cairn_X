/**
 * 租约续期（dispatcher 的 decide heartbeat 与 Worker 的执行 heartbeat 共用）。
 *
 * 语义：后台定时器每隔 `intervalSeconds` 续期一次租约；首次心跳在一个
 * 间隔之后发生。401/403/404/409 立即判定失败（租约已丢失）；其他失败被
 * 容忍，直到超过宽限窗口（租约 TTL 的 2/3；未知 TTL 时为心跳间隔的 2 倍）。
 * 响应携带 cancel 标记（控制端取消请求）时同样触发失败 —— Worker 自愿
 * 终止先于容器 SIGKILL，保住优雅收尾的机会。
 *
 * 宽限窗口是一个**总预算**（从上次成功起算），由两条路径分工用尽，两者
 * 时长必须相同、且互不越界：
 * - `beat()`：心跳**有结果地失败**（持续 5xx）时，带着上游真实状态码上报；
 * - 看门狗：心跳**没有结果**（请求卡死）时兜底，只能报 statusCode=null。
 * 看门狗只在请求在途时上弦，按"剩余预算"计时。绝不能把它改成在 start()
 * 或心跳成功时上弦的一整段新预算 —— 那样它会变成"距上次成功"的硬截止，
 * 必然抢在 beat() 之前触发，把真实状态码换成 null。
 *
 * 失败时设置 `failure` 标志并触发 `onFailure`——调用方在关键节点检查
 * `failure`，并把 `onFailure` 接到中止正在运行的 agent 上。
 */

const HEARTBEAT_FAILURE_GRACE_MULTIPLIER = 2;
/** 租约确定丢失的 HTTP 状态码（版本被拒/执行被回收/身份失效）。 */
const LEASE_FAILURE_STATUSES = [401, 403, 404, 409];

/** 一次心跳的结果视图（dispatcher ApiResult 与 Worker 客户端各自适配到此）。 */
interface LeaseHeartbeat {
	statusCode: number;
	ok: boolean;
	text: string;
	/** 响应携带的租约 TTL（秒）；用于自适应心跳周期与看门狗。 */
	leaseTimeoutSeconds?: number;
	/** 响应携带的显式心跳间隔（秒）；优先于 TTL/3，用于解耦心跳频率与租约时长。 */
	heartbeatIntervalSeconds?: number;
	/** 控制端取消请求标记（仅 Worker 心跳响应携带）。 */
	cancel?: boolean;
}

export interface HeartbeatFailure {
	statusCode: number | null;
	text: string;
}

interface HeartbeatLeaseOptions {
	heartbeat: () => Promise<LeaseHeartbeat>;
	scope: string;
	worker: string;
	/** Initial renewal interval; successful heartbeat responses provide the lease TTL. */
	intervalSeconds: number;
	leaseTimeoutSeconds?: number;
	onFailure?: (failure: HeartbeatFailure) => void;
	log?: (message: string) => void;
	now?: () => number;
}

export class HeartbeatLease {
	private failureValue: HeartbeatFailure | null = null;
	private cancelled = false;
	private lastSuccessAt: number;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private watchdog: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private beating = false;
	private intervalSeconds: number;
	private leaseTimeout?: number;
	private readonly now: () => number;
	private readonly log: (message: string) => void;

	constructor(private readonly options: HeartbeatLeaseOptions) {
		this.intervalSeconds = options.intervalSeconds;
		this.leaseTimeout = options.leaseTimeoutSeconds;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.lastSuccessAt = this.now();
	}

	static forDecide(
		client: {
			heartbeatDecide: (
				p: string,
				w: string,
			) => Promise<{
				statusCode: number;
				ok: boolean;
				text: string;
				leaseTimeout?: number;
				heartbeatInterval?: number;
			}>;
		},
		projectId: string,
		worker: string,
		intervalSeconds: number,
		extra: Partial<HeartbeatLeaseOptions> = {},
	): HeartbeatLease {
		return new HeartbeatLease({
			heartbeat: async () => {
				const result = await client.heartbeatDecide(projectId, worker);
				return {
					statusCode: result.statusCode,
					ok: result.ok,
					text: result.text,
					leaseTimeoutSeconds: result.leaseTimeout,
					heartbeatIntervalSeconds: result.heartbeatInterval,
				};
			},
			scope: `project=${projectId} decide`,
			worker,
			intervalSeconds,
			...extra,
		});
	}

	/** Worker 执行租约：心跳响应携带租约 TTL 与 cancel 标记。 */
	static forExecution(
		client: {
			heartbeat: () => Promise<{
				statusCode: number;
				ok: boolean;
				text: string;
				data?:
					{ lease_timeout_s: number; cancel: boolean; heartbeat_interval_s?: number } | undefined;
			}>;
		},
		worker: string,
		intervalSeconds: number,
		extra: Partial<HeartbeatLeaseOptions> = {},
	): HeartbeatLease {
		return new HeartbeatLease({
			heartbeat: async () => {
				const result = await client.heartbeat();
				return {
					statusCode: result.statusCode,
					ok: result.ok,
					text: result.text,
					leaseTimeoutSeconds: result.data?.lease_timeout_s,
					heartbeatIntervalSeconds: result.data?.heartbeat_interval_s,
					cancel: result.data?.cancel === true,
				};
			},
			scope: `execution=${worker}`,
			worker,
			intervalSeconds,
			...extra,
		});
	}

	get failure(): HeartbeatFailure | null {
		return this.failureValue;
	}

	get isCancelled(): boolean {
		return this.cancelled;
	}

	start(): void {
		if (this.timer !== null || this.stopped) {
			return;
		}
		this.scheduleNext();
	}

	stop(): void {
		this.stopped = true;
		this.stopWatchdog();
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** 从上次成功起算的续租总预算（毫秒）。 */
	private graceMs(): number {
		const seconds =
			this.leaseTimeout === undefined
				? this.intervalSeconds * HEARTBEAT_FAILURE_GRACE_MULTIPLIER
				: (this.leaseTimeout * 2) / 3;
		return seconds * 1000;
	}

	/**
	 * 请求在途时上弦：只守"这个请求不许卡到续租预算用尽"。按**剩余**预算计时，
	 * 与 `beat()` 共用同一个总预算，所以卡死和持续失败不会各自攒出一份宽限。
	 */
	private startWatchdog(): void {
		this.stopWatchdog();
		const remainingMs = this.lastSuccessAt + this.graceMs() - this.now();
		this.watchdog = setTimeout(
			() => this.fail({ statusCode: null, text: "Lease renewal deadline exceeded" }),
			Math.max(0, remainingMs),
		);
	}

	private stopWatchdog(): void {
		if (this.watchdog !== null) clearTimeout(this.watchdog);
		this.watchdog = null;
	}

	/** Schedule the next renewal after the previous one settles. */
	private scheduleNext(): void {
		if (this.stopped || this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.beat();
		}, this.intervalSeconds * 1000);
	}

	private async beat(): Promise<void> {
		if (this.stopped || this.beating) {
			return;
		}
		this.beating = true;
		let result: LeaseHeartbeat;
		try {
			this.startWatchdog();
			result = await this.options.heartbeat();
		} catch (err) {
			result = { statusCode: 0, ok: false, text: err instanceof Error ? err.message : String(err) };
		} finally {
			// 请求已 settle：看门狗完成使命。持续失败的重试节奏由下面按
			// 剩余预算判定，看门狗不参与。
			this.stopWatchdog();
			this.beating = false;
		}
		if (this.stopped) {
			return;
		}
		if (result.ok) {
			this.lastSuccessAt = this.now();
			if (result.leaseTimeoutSeconds !== undefined && result.leaseTimeoutSeconds > 0) {
				this.leaseTimeout = result.leaseTimeoutSeconds;
			}
			if (result.heartbeatIntervalSeconds !== undefined && result.heartbeatIntervalSeconds > 0) {
				// 服务端显式下发间隔：心跳频率与租约 TTL 解耦，加大 TTL 不再拖慢续租/取消。
				this.intervalSeconds = Math.max(1, Math.floor(result.heartbeatIntervalSeconds));
			}
			this.scheduleNext();
			if (result.cancel) {
				this.cancelled = true;
				this.log(
					`lease observed cancel request scope=${this.options.scope} worker=${this.options.worker}`,
				);
				this.fail({ statusCode: 499, text: "cancel requested by controller" });
			}
			return;
		}
		if (LEASE_FAILURE_STATUSES.includes(result.statusCode)) {
			this.fail({ statusCode: result.statusCode, text: result.text });
			return;
		}
		const elapsedSeconds = (this.now() - this.lastSuccessAt) / 1000;
		const graceSeconds = this.graceMs() / 1000;
		if (elapsedSeconds < graceSeconds) {
			this.log(
				`heartbeat transient failure scope=${this.options.scope} worker=${this.options.worker} ` +
					`status=${result.statusCode} elapsed=${elapsedSeconds.toFixed(1)}s grace=${graceSeconds.toFixed(1)}s`,
			);
			this.scheduleNext();
			return;
		}
		this.fail({
			statusCode: result.statusCode === 0 ? null : result.statusCode,
			text: result.text,
		});
	}

	private fail(failure: HeartbeatFailure): void {
		this.failureValue = failure;
		this.stop();
		this.log(
			`heartbeat failed scope=${this.options.scope} worker=${this.options.worker} status=${failure.statusCode}`,
		);
		this.options.onFailure?.(failure);
	}
}
