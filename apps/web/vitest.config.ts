import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)), "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: { include: ["**/*.test.ts", "**/*.test.tsx"], exclude: ["node_modules", ".next"], passWithNoTests: false, testTimeout: 30_000, hookTimeout: 120_000, setupFiles: ["./test/setup.ts"] },
});
