import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["vitest.setup.ts"],
    clearMocks: true,
    isolate: true,
    reporters: ["default"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
