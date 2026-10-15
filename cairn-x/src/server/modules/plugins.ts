import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { ConfigurationControl } from "../../control/index.js";
import { validApiToken } from "../auth.js";
import { ApiError } from "../core/base.js";
import { parseBody, parseValue } from "../http.js";
import type { AgentRole } from "../../contracts/configuration.js";

const roleSchema = z.enum(["decide", "execute"]);
const operationSchema = z.object({
	kind: z.enum(["install", "update", "remove", "enable", "disable"]),
	source: z.string().trim().min(1).max(2000).optional(),
});
const releaseSchema = z.object({
	role: roleSchema,
	installation_id: z.string().optional(),
	revision: z.number().int().positive(),
	source: z.string(),
	enabled: z.boolean(),
	created_at: z.string(),
	resources: z.object({
		extensions: z.array(z.string()),
		skills: z.array(z.string()),
	}),
	packages: z.array(z.string()),
	path: z.string(),
	install_platform: z.string().optional(),
	install_node: z.string().optional(),
	worker_image: z.string().optional(),
	retiring: z.boolean().optional(),
});

function machine(c: Context, auth: { apiToken?: string } | undefined): void {
	if (!auth?.apiToken || !validApiToken(auth, c.req.header("authorization")))
		throw new ApiError(401, "Control API token required");
}

export function pluginRoutes(control: ConfigurationControl, auth?: { apiToken?: string }): Hono {
	const app = new Hono();
	app.get("/settings/agents/:role/plugins", (c) => {
		const role = parseValue(c.req.param("role"), roleSchema) as AgentRole;
		return c.json({
			current: control.plugins.list(role) ?? null,
			operations: control.plugins.listOperations(role),
		});
	});
	app.post("/settings/agents/:role/plugins/operations", async (c) => {
		const role = parseValue(c.req.param("role"), roleSchema) as AgentRole;
		const body = await parseBody(c, operationSchema);
		const operation = control.plugins.enqueue(role, body.kind, body.source);
		return c.json(operation, 202);
	});
	app.get("/settings/agents/:role/plugins/operations/:id", (c) => {
		const role = parseValue(c.req.param("role"), roleSchema) as AgentRole;
		const operation = control.plugins.getOperation(c.req.param("id"));
		if (!operation || operation.role !== role)
			throw new ApiError(404, "Plugin operation not found");
		return c.json(operation);
	});
	app.post("/internal/plugins/operations/claim", async (c) => {
		machine(c, auth);
		const body = await parseBody(
			c,
			z.object({ role: roleSchema, worker: z.string().min(1).max(200) }),
		);
		return c.json(control.plugins.claimNext(body.role, body.worker) ?? null);
	});
	app.post("/internal/plugins/operations/:id/result", async (c) => {
		machine(c, auth);
		const body = await parseBody(
			c,
			z.object({
				ok: z.boolean(),
				message: z.string().max(10000).optional(),
				release: releaseSchema.optional(),
			}),
		);
		const operation = control.plugins.getOperation(c.req.param("id"));
		if (!operation) throw new ApiError(404, "Plugin operation not found");
		if (operation.status === "succeeded" || operation.status === "failed") return c.json(operation);
		if (operation.status !== "running")
			throw new ApiError(409, "Plugin operation has not been claimed");
		if (body.release && body.release.role !== operation.role)
			throw new ApiError(400, "Plugin release role does not match operation");
		if (body.ok && body.release) control.plugins.setCurrent(operation.role, body.release);
		else if (body.ok && operation.kind === "remove") control.plugins.removeCurrent(operation.role);
		return c.json(
			control.plugins.updateOperation(operation.id, {
				status: body.ok ? "succeeded" : "failed",
				progress: 100,
				message: body.message,
				release: body.release,
			}),
		);
	});
	return app;
}
