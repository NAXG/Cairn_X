import type { Context } from "hono";
import type { z } from "zod";

import { ApiError } from "./core/base.js";

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		throw new ApiError(400, "Request body must be valid JSON");
	}
	return parseValue(raw, schema);
}

export function parseValue<S extends z.ZodType>(raw: unknown, schema: S): z.output<S> {
	const result = schema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue?.path.map(String).join(".") ?? "";
		const message = issue?.message ?? "Invalid request body";
		throw new ApiError(400, path ? `${path}: ${message}` : message);
	}
	return result.data as z.output<S>;
}
