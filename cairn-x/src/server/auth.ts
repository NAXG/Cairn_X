import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

export interface AuthConfig {
	user: string;
	password: string;
	/** 机器客户端（dispatcher）使用的独立 Bearer token。不配置则禁用 Bearer 认证。 */
	apiToken?: string;
}

export const SESSION_COOKIE = "cairn_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SessionStore = Map<string, number>;

export function createSessionStore(): SessionStore {
	return new Map();
}

function safeEqual(a: string, b: string): boolean {
	const ba = createHash("sha256").update(a).digest();
	const bb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ba, bb);
}

export function checkCredentials(config: AuthConfig, user: string, password: string): boolean {
	const userMatches = safeEqual(config.user, user);
	const passwordMatches = safeEqual(config.password, password);
	return userMatches && passwordMatches;
}

export function issueSession(sessions: SessionStore): string {
	const token = randomBytes(32).toString("hex");
	sessions.set(token, Date.now() + SESSION_TTL_MS);
	return token;
}

function validSession(sessions: SessionStore, token: string | undefined): boolean {
	if (!token) {
		return false;
	}
	const expires = sessions.get(token);
	if (expires === undefined) {
		return false;
	}
	if (expires < Date.now()) {
		sessions.delete(token);
		return false;
	}
	return true;
}

export function dropSession(sessions: SessionStore, token: string | undefined): void {
	if (token) {
		sessions.delete(token);
	}
}

/** 删除已过期的 session，防止长期运行时 store 无限增长。 */
export function pruneExpiredSessions(sessions: SessionStore): void {
	const now = Date.now();
	for (const [token, expires] of sessions) {
		if (expires < now) {
			sessions.delete(token);
		}
	}
}

function isApiPath(path: string): boolean {
	return !path.startsWith("/static/") && path !== "/" && path !== "/login";
}

export function validApiToken(
	config: Pick<AuthConfig, "apiToken">,
	header: string | undefined,
): boolean {
	if (!config.apiToken?.trim() || !header?.startsWith("Bearer ")) {
		return false;
	}
	return safeEqual(config.apiToken.trim(), header.slice("Bearer ".length));
}

export function authMiddleware(sessions: SessionStore, config: AuthConfig): MiddlewareHandler {
	return async (c, next) => {
		const path = c.req.path;
		// /healthz 是免鉴权探针：只返回存活状态，不暴露项目数据。
		if (path === "/login" || path === "/healthz" || path.startsWith("/static/")) {
			return next();
		}
		// Worker 控制面路由自行鉴权（短期执行令牌），不走全局 Bearer。
		if (path.startsWith("/internal/")) {
			return next();
		}
		const token = getCookie(c, SESSION_COOKIE);
		if (validSession(sessions, token) || validApiToken(config, c.req.header("authorization"))) {
			return next();
		}
		if (isApiPath(path)) {
			return c.json({ detail: "Unauthorized" }, 401);
		}
		return next();
	};
}

export function isAuthenticated(c: Context, sessions: SessionStore): boolean {
	return validSession(sessions, getCookie(c, SESSION_COOKIE));
}

export function setSessionCookie(c: Context, token: string): void {
	// HTTPS 部署（含 TLS 终结反代）时加 secure，避免 cookie 明文回传。
	const secure =
		new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "Lax",
		secure,
		path: "/",
		maxAge: SESSION_TTL_MS / 1000,
	});
}

export function clearSessionCookie(c: Context): void {
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
