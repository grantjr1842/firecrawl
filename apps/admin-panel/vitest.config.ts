import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // The admin-panel is a fresh app — we don't want stale snapshots
    // from another monorepo package to leak in.
    exclude: ["node_modules", ".next", "dist"],
  },
});
