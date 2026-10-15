import { z } from "zod";

/** A missing confidence must never upgrade a claim to a direct observation. */
export const factContentSchema = z.object({
	description: z.string().trim().min(1).max(100_000),
	confidence: z.enum(["observed", "inferred"]),
});

export type FactContent = z.infer<typeof factContentSchema>;
