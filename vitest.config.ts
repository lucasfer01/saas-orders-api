import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		setupFiles: ["vitest.setup.ts"],
		clearMocks: true,
		isolate: true,
		reporters: ["default"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			all: true,
			include: ["src/**/*.ts"],
			exclude: [
				"**/*.d.ts",
				"**/*.{test,spec}.ts",
				"**/vitest.setup.ts",
			],
			reportsDirectory: "coverage",
			watermarks: {
				statements: [80, 95],
				branches: [70, 90],
				functions: [80, 95],
				lines: [80, 95],
			},
		},
	},
});
