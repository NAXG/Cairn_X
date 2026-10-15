import { workbenchRoutes } from "./modules/workbench.js";
import { schedulingRoutes } from "./modules/scheduling.js";
import { createConfigurationControl, type ConfigurationControl } from "../control/index.js";
import { configurationRoutes } from "../control/routes.js";
import { activityRoutes } from "../control/activity-routes.js";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
	authMiddleware,
	checkCredentials,
	clearSessionCookie,
	createSessionStore,
	isAuthenticated,
	issueSession,
	setSessionCookie,
	SESSION_COOKIE,
	dropSession,
	pruneExpiredSessions,
	type AuthConfig,
} from "./auth.js";
import { transcriptRoutes } from "./modules/transcripts.js";
import type { Db } from "./db.js";
import { LOGIN_HTML } from "./login.js";
import { decideRoutes } from "./modules/decide.js";
import { digestRoutes } from "./modules/digest.js";
import { executionRoutes, type ExecutionRoutesDeps } from "./modules/executions.js";
import { factRoutes } from "./modules/facts.js";
import { findingRoutes } from "./modules/findings.js";
import { goalRoutes } from "./modules/goals.js";
import { graphRoutes } from "./modules/graph.js";
import { eventSearchRoutes } from "./modules/event-search.js";
import { hintRoutes } from "./modules/hints.js";
import { projectRoutes } from "./modules/projects.js";
import { routeRoutes } from "./modules/routes.js";
import { settingsRoutes } from "./modules/settings.js";
import { sessionExportRoutes } from "./modules/session-export.js";
import { sessionRoutes } from "./modules/sessions.js";
import { stepRoutes } from "./modules/steps.js";
import { uploadRoutes, type UploadDeps } from "./modules/uploads.js";
import { removeUploads } from "../environments/uploads.js";
import { usageRoutes } from "./modules/usage.js";
import { pluginRoutes } from "./modules/plugins.js";
import { skillRoutes } from "./modules/skills.js";
import { ApiError } from "./core/base.js";
import { consoleLogger } from "../shared/logger.js";

const STATIC_DIR = path.resolve(fileURLToPath(new URL("./static/", import.meta.url)));
const WEB_STATIC_DIR = path.resolve(fileURLToPath(new URL("../../dist-web/", import.meta.url)));

async function readStaticAsset(root: string, relative: string): Promise<Buffer> {
	const candidate = path.resolve(root, relative);
	if (!candidate.startsWith(root + path.sep)) throw new Error("Static asset is outside its root");
	const [resolvedRoot, resolvedCandidate] = await Promise.all([
		realpath(root),
		realpath(candidate),
	]);
	if (!resolvedCandidate.startsWith(resolvedRoot + path.sep))
		throw new Error("Static asset is outside its root");
	return readFile(resolvedCandidate);
}
const STATIC_TYPES: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".html": "text/html; charset=utf-8",
	".png": "image/png",
};

interface ExecutorControlDeps {
	executions: ExecutionRoutesDeps;
	configuration: ConfigurationControl;
}

export function createApp(
	db: Db,
	auth?: AuthConfig,
	uploads?: UploadDeps,
	dataRoot?: string,
	executor?: ExecutorControlDeps,
): Hono {
	const app = new Hono();
	// 基础安全响应头（nosniff / frame-options / referrer-policy 等）。
	// 登录页含内联脚本，因此不在这里启用 CSP；需要时按 nonce/hash 单独加。
	// X-Frame-Options 取 DENY，避免覆盖会话导出接口自己的 DENY。
	app.use("*", secureHeaders({ xFrameOptions: "DENY" }));
	// JSON API 的请求体上限：防止未鉴权的大 body 把 c.req.json() 拖进内存（zod 的
	// .max() 在解析之后才生效）。附件上传走自己的流式限额（500MB），这里豁免。
	app.use("*", async (c, next) => {
		if (c.req.method === "POST" && /^\/projects\/[^/]+\/uploads$/.test(c.req.path)) return next();
		return bodyLimit({
			maxSize: 64 * 1024 * 1024,
			onError: () => c.json({ detail: "Request body too large" }, 413),
		})(c, next);
	});
	// 数据目录：会话轨迹与配置文件的统一根（测试可注入临时目录）。
	const root = dataRoot ?? path.resolve("datas/cairn-x");
	const uploadBackend = uploads ?? { root };

	app.onError((err, c) => {
		if (err instanceof ApiError) {
			return c.json({ detail: err.message }, err.status as ContentfulStatusCode);
		}
		consoleLogger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		return c.json({ detail: "Internal Server Error" }, 500);
	});
	app.notFound((c) => c.json({ detail: "Not Found" }, 404));

	// 免鉴权存活/就绪探针：只做数据库可读检查，不返回项目数据。
	// compose healthcheck 与运维探活使用（见 docker-compose.yaml）。
	app.get("/healthz", (c) => {
		try {
			db.prepare("SELECT 1 AS ok").get();
		} catch {
			return c.json({ status: "error" }, 503);
		}
		return c.json({ status: "ok" });
	});

	const sessions = createSessionStore();
	// 定期清理过期 session（惰性删除只覆盖被再次访问的 token）。
	const sessionPruneTimer = setInterval(() => pruneExpiredSessions(sessions), 10 * 60_000);
	sessionPruneTimer.unref?.();

	if (auth) {
		app.use("*", authMiddleware(sessions, auth));
		// 登录失败限流：固定窗口计数，防口令爆破。
		const LOGIN_WINDOW_MS = 5 * 60_000;
		const LOGIN_MAX_FAILURES = 10;
		const LOGIN_MAX_TRACKED_CLIENTS = 1024;
		const loginFailures = new Map<string, { count: number; resetAt: number }>();
		// 客户端标识只取 socket 地址：x-forwarded-for 完全由客户端提供，
		// 轮换该头即可绕过限流。没有可信代理配置项，因此不读取转发头
		// （反代部署下所有客户端共享代理地址，属保守取舍）。
		const clientKey = (c: Context): string => {
			const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
			return env?.incoming?.socket?.remoteAddress ?? "direct";
		};
		// 惰性删除只覆盖再次命中的 key；容量超限时全表清理过期项，
		// 仍满则淘汰最旧项，保证 Map 有界且不整体重置计数。
		const pruneLoginFailures = (now: number): void => {
			for (const [key, state] of loginFailures) {
				if (state.resetAt <= now) loginFailures.delete(key);
			}
			while (loginFailures.size >= LOGIN_MAX_TRACKED_CLIENTS) {
				const oldest = loginFailures.keys().next().value;
				if (oldest === undefined) break;
				loginFailures.delete(oldest);
			}
		};
		app.post("/login", async (c) => {
			const key = clientKey(c);
			const now = Date.now();
			const state = loginFailures.get(key);
			if (state !== undefined && state.resetAt <= now) {
				loginFailures.delete(key);
			}
			const current = loginFailures.get(key);
			if (current !== undefined && current.count >= LOGIN_MAX_FAILURES) {
				return c.json({ detail: "Too many login attempts, try again later" }, 429);
			}
			let body: { username?: string; password?: string };
			try {
				body = await c.req.json();
			} catch {
				return c.json({ detail: "Invalid JSON body" }, 400);
			}
			if (!checkCredentials(auth, body.username ?? "", body.password ?? "")) {
				if (loginFailures.size >= LOGIN_MAX_TRACKED_CLIENTS) {
					pruneLoginFailures(now);
				}
				const entry = loginFailures.get(key) ?? { count: 0, resetAt: now + LOGIN_WINDOW_MS };
				entry.count += 1;
				loginFailures.set(key, entry);
				return c.json({ detail: "Invalid username or password" }, 401);
			}
			loginFailures.delete(key);
			const token = issueSession(sessions);
			setSessionCookie(c, token);
			return c.json({ ok: true });
		});
	}
	app.post("/logout", (c) => {
		dropSession(sessions, getCookie(c, SESSION_COOKIE));
		clearSessionCookie(c);
		return c.json({ ok: true });
	});

	app.get("/static/*", async (c) => {
		// 解码后只使用文件系统路径解析，避免 URL 再次解释编码的点段。
		const raw = c.req.path.slice("/static/".length);
		let rel: string;
		try {
			rel = decodeURIComponent(raw);
		} catch {
			return c.json({ detail: "Not Found" }, 404);
		}
		const isSafe = (p: string) =>
			p.length > 0 &&
			!p.includes("\\") &&
			!p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");

		if (rel.startsWith("web/")) {
			const asset = rel.slice(4);
			if (!isSafe(asset)) return c.notFound();
			try {
				const buffer = await readStaticAsset(WEB_STATIC_DIR, asset);
				const type = STATIC_TYPES[path.extname(asset)] ?? "application/octet-stream";
				return c.body(new Uint8Array(buffer), 200, {
					"Content-Type": type,
					"Cache-Control": asset.startsWith("assets/")
						? "public, max-age=31536000, immutable"
						: "no-cache",
				});
			} catch {
				return c.notFound();
			}
		}
		if (!isSafe(rel)) {
			return c.json({ detail: "Not Found" }, 404);
		}
		const ext = rel.slice(rel.lastIndexOf("."));
		const type = STATIC_TYPES[ext];
		if (!type) {
			return c.json({ detail: "Not Found" }, 404);
		}
		try {
			const buf = await readStaticAsset(STATIC_DIR, rel);
			return c.body(new Uint8Array(buf), 200, {
				"Content-Type": type,
				"Cache-Control": "public, max-age=3600",
			});
		} catch {
			return c.json({ detail: "Not Found" }, 404);
		}
	});

	app.get("/", async (c) => {
		if (auth && !isAuthenticated(c, sessions)) {
			return c.html(LOGIN_HTML);
		}
		{
			try {
				c.header("Cache-Control", "no-store");
				return c.html(
					await readFile(new URL("../../dist-web/index.html", import.meta.url), "utf8"),
				);
			} catch {
				return c.text("Web build missing. Run npm run build:web.", 503);
			}
		}
	});

	app.route("/", transcriptRoutes(db, root));
	app.route("/", sessionExportRoutes(db, root));
	const configuration = executor?.configuration ?? createConfigurationControl(db, root);
	app.route("/", configurationRoutes(configuration.store, configuration.models));
	app.route("/", pluginRoutes(configuration, auth));
	app.route("/", skillRoutes(configuration));
	// Executor Worker 控制面：自行鉴权（短期执行令牌 / 机器 token）。
	// 活动路由（/internal/activities/*）随执行控制面一起注册。
	if (executor) {
		app.route("/", activityRoutes(configuration, auth));
	}
	app.route("/", settingsRoutes(db));
	app.route("/", schedulingRoutes(db, auth));
	app.route("/", workbenchRoutes(db));
	app.route(
		"/",
		projectRoutes(db, async (pid: string) => removeUploads(uploadBackend.root, pid), root),
	);
	app.route("/", hintRoutes(db));
	app.route("/", factRoutes(db));
	app.route("/", stepRoutes(db));
	app.route("/", goalRoutes(db));
	app.route("/", routeRoutes(db));
	app.route("/", graphRoutes(db));
	app.route("/", eventSearchRoutes(db));
	app.route("/", findingRoutes(db));
	app.route("/", decideRoutes(db, root));
	app.route("/", usageRoutes(db));
	app.route("/", digestRoutes(db));
	app.route("/", uploadRoutes(db, uploadBackend));
	app.route("/", sessionRoutes(db, root));
	if (executor) {
		app.route("/", executionRoutes(executor.executions));
	}

	return app;
}
