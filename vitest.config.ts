import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // studio/ is a separate pnpm workspace with its own gates (npm run studio:test).
    exclude: [...configDefaults.exclude, "studio/**"],
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, "src")}/` },
      { find: "server-only", replacement: path.resolve(__dirname, "src/test/server-only-stub.ts") },
    ],
  },
});
