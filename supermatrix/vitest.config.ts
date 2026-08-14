import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 5000,
    hookTimeout: 5000,
    env: {
      // Keep codex run-plan tests hermetic from this machine's live sm-switch
      // route state; routeState tests pass explicit paths instead.
      SM_CODEX_ROUTE_STATE_PATH: "/nonexistent/sm-switch-route-state.json",
    },
  },
});
