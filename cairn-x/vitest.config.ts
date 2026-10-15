import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Each worker loads the PI runtime and starts control servers. Bound their
		// concurrency to keep cancellation/lease tests stable on developer machines.
		maxWorkers: 4,
	},
});
