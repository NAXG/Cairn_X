import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validApiToken, type AuthConfig } from "../../src/server/auth.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";
import { onTestFinished } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";

import { createApp } from "../../src/server/app.js";
import { openDatabase } from "../../src/server/db.js";

const AUTH = { user: "admin", password: "s3cret" };

function createAuthedServer(auth: AuthConfig | null = AUTH) {
	const dir = mkdtempSync(path.join(tmpdir(), "cairn-x-auth-"));
	const db = openDatabase(path.join(dir, "cairn.db"));
	const app = createApp(db, auth ?? undefined);
	onTestFinished(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return app;
}

test("logout without authentication is an idempotent success", async () => {
	const app = createAuthedServer(null);
	for (let i = 0; i < 2; i++) {
		const response = await app.request("/logout", { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	}
});

function runCli(args: string[], env: Record<string, string> = {}) {
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const cleanEnv = { ...process.env };
	delete cleanEnv.CAIRN_WEB_PASSWORD;
	delete cleanEnv.CAIRN_API_TOKEN;
	return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
		cwd: root,
		env: { ...cleanEnv, ...env },
		encoding: "utf8",
		timeout: 15_000,
	});
}

test.each(["flag", "env"])(
	"serve rejects insecure credentials from %s before creating a DB",
	(source) => {
		const dir = mkdtempSync(path.join(tmpdir(), "cairn-cli-auth-"));
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const dbPath = path.join(dir, "new", "db");
		for (const [flag, env] of [
			["--web-password", "CAIRN_WEB_PASSWORD"],
			["--api-token", "CAIRN_API_TOKEN"],
		]) {
			const result = runCli(
				["serve", "--db-path", dbPath, ...(source === "flag" ? [flag, "cairn-change-me"] : [])],
				{
					CAIRN_WEB_PASSWORD: "unique-test-password",
					...(source === "env" ? { [env]: "cairn-change-me" } : {}),
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`${env}: insecure default credential`);
			expect(existsSync(dbPath)).toBe(false);
		}
	},
	30_000,
);

test.each([
	["dispatch"],
	["benchmark"],
	[
		"regression",
		"run",
		"--experiment",
		"test",
		"--case",
		"test",
		"--server",
		"http://127.0.0.1:1",
		"--target",
		"test",
	],
])(
	"CLI %s rejects the insecure machine token from flags and env",
	(...command) => {
		for (const source of ["flag", "env"]) {
			const result = runCli(
				[...command, ...(source === "flag" ? ["--api-token", "cairn-change-me"] : [])],
				source === "env" ? { CAIRN_API_TOKEN: "cairn-change-me" } : {},
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("CAIRN_API_TOKEN: insecure default credential");
		}
	},
	30_000,
);

test.each([undefined, "", "   "])(
	"serve still requires a nonblank web password (%s)",
	(password) => {
		const result = runCli(
			["serve"],
			password === undefined ? {} : { CAIRN_WEB_PASSWORD: password },
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Web console password required");
	},
	20_000,
);

test("CLI flags override env and an omitted machine token remains optional", () => {
	for (const args of [[], ["--api-token", "unique-test-token"]]) {
		// Missing config is an intentional stopping point before any network access.
		const result = runCli(
			["dispatch", "--config", "/nonexistent/cairn-auth-test.yaml", ...args],
			args.length ? { CAIRN_API_TOKEN: "cairn-change-me" } : {},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("cannot read config file");
		expect(result.stderr).not.toContain("insecure default credential");
	}
}, 30_000);

function sessionCookie(res: Response): string {
	const set = res.headers.get("set-cookie") ?? "";
	const match = set.match(/cairn_session=[^;]+/);
	expect(match, "expected a session cookie").toBeTruthy();
	return match![0];
}

test("unauthenticated: GET / serves login page, APIs return 401", async () => {
	const app = createAuthedServer();

	const home = await app.request("/");
	expect(home.status).toBe(200);
	expect(await home.text()).toContain("登录控制台");

	const api = await app.request("/projects/page");
	expect(api.status).toBe(401);

	const settings = await app.request("/settings");
	expect(settings.status).toBe(401);

	const assets = await app.request("/static/favicon.svg");
	expect(assets.status).toBe(200);

	// 存活探针免鉴权（compose healthcheck 依赖），但不暴露项目数据。
	const health = await app.request("/healthz");
	expect(health.status).toBe(200);
	expect(await health.json()).toEqual({ status: "ok" });
});

test("login with wrong credentials returns 401 and no cookie", async () => {
	const app = createAuthedServer();

	const res = await app.request("/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "admin", password: "wrong" }),
	});
	expect(res.status).toBe(401);
	expect(res.headers.get("set-cookie") ?? "").not.toContain("cairn_session=");
});

test("login sets a session cookie which unlocks the console and APIs", async () => {
	const app = createAuthedServer();

	const login = await app.request("/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: AUTH.user, password: AUTH.password }),
	});
	expect(login.status).toBe(200);
	const cookie = sessionCookie(login);

	const home = await app.request("/", { headers: { cookie } });
	expect(home.status).toBe(200);
	expect(await home.text()).toContain('id="root"');

	const api = await app.request("/projects/page", { headers: { cookie } });
	expect(api.status).toBe(200);

	const logout = await app.request("/logout", { method: "POST", headers: { cookie } });
	expect(logout.status).toBe(200);

	const after = await app.request("/projects/page", { headers: { cookie } });
	expect(after.status).toBe(401);
});

test.each([undefined, "", "   "])(
	"missing/blank apiToken (%s) disables Bearer auth without a password fallback",
	async (apiToken) => {
		const auth = { ...AUTH, apiToken };
		const app = createAuthedServer(auth);
		for (const header of [undefined, "Bearer ", "Bearer wrong", "Bearer s3cret", "Bearer    "]) {
			expect(validApiToken(auth, header)).toBe(false);
			const res = await app.request("/projects/page", {
				headers: header === undefined ? {} : { authorization: header },
			});
			expect(res.status).toBe(401);
		}
	},
);

test("explicit no-auth app remains available for development and tests", async () => {
	const app = createAuthedServer(null);
	expect((await app.request("/projects/page")).status).toBe(200);
	expect((await app.request("/settings")).status).toBe(200);
});

test("only an explicit apiToken unlocks APIs for machine clients", async () => {
	const app = createAuthedServer({ ...AUTH, apiToken: "tok123" });
	for (const header of [undefined, "Bearer ", "Bearer wrong", "Basic tok123", "bearer tok123"]) {
		expect(validApiToken({ ...AUTH, apiToken: "tok123" }, header)).toBe(false);
	}

	expect(
		(await app.request("/projects/page", { headers: { authorization: "Bearer s3cret" } })).status,
	).toBe(401);
	expect(
		(await app.request("/projects/page", { headers: { authorization: "Bearer tok123" } })).status,
	).toBe(200);
});

test("login is rate limited after repeated failures", async () => {
	const app = createAuthedServer();
	const attempt = () =>
		app.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "wrong" }),
		});
	for (let i = 0; i < 10; i++) {
		expect((await attempt()).status).toBe(401);
	}
	expect((await attempt()).status).toBe(429);
	// 连正确口令也在窗口内被拒。
	const ok = await app.request("/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "admin", password: "s3cret" }),
	});
	expect(ok.status).toBe(429);
});

test("rotating x-forwarded-for cannot bypass login rate limiting", async () => {
	const app = createAuthedServer();
	const attempt = (forwarded: string) =>
		app.request("/login", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-forwarded-for": forwarded },
			body: JSON.stringify({ username: "admin", password: "wrong" }),
		});
	// 限流键来自 socket 地址（测试里无 env，统一落到 direct），转发头不参与：
	// 客户端轮换 x-forwarded-for 仍然共享同一个失败计数。
	for (let i = 0; i < 10; i++) {
		expect((await attempt(`10.0.0.${i}`)).status).toBe(401);
	}
	expect((await attempt("10.0.0.99")).status).toBe(429);
});

test("login rate limiting keys on the real socket address (node adapter)", async () => {
	const app = createAuthedServer();
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => server.on("listening", resolve));
	onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = (server.address() as AddressInfo).port;
	const attempt = () =>
		fetch(`http://127.0.0.1:${port}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-forwarded-for": String(Math.random()) },
			body: JSON.stringify({ username: "admin", password: "wrong" }),
		});
	for (let i = 0; i < 10; i++) {
		expect((await attempt()).status).toBe(401);
	}
	expect((await attempt()).status).toBe(429);
});

test("session cookie carries Secure behind an HTTPS reverse proxy", async () => {
	const app = createAuthedServer();
	const res = await app.request("http://internal/login", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-forwarded-proto": "https" },
		body: JSON.stringify({ username: "admin", password: "s3cret" }),
	});
	expect(res.status).toBe(200);
	expect(res.headers.get("set-cookie") ?? "").toContain("Secure");
});
