import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command }) => ({
	root: "src/web",
	base: command === "build" ? "/static/web/" : "/",
	plugins: [
		react(),
		{
			name: "third-party-notices",
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "THIRD_PARTY_NOTICES.txt",
					source: readFileSync("src/web/THIRD_PARTY_NOTICES.md", "utf8"),
				});
			},
		},
	],
	build: { outDir: "../../dist-web", emptyOutDir: true },
	server: {
		proxy: {
			"/auth": { target: "http://127.0.0.1:8000", rewrite: () => "/" },
			...Object.fromEntries(
				["/projects", "/settings", "/login", "/logout", "/static/favicon.svg"].map((p) => [
					p,
					"http://127.0.0.1:8000",
				]),
			),
		},
	},
}));
