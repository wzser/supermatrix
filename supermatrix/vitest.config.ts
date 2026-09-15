import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The published clean-install contract is one worker with no file-level
    // parallelism. Several shell/SQLite harnesses share process and port
    // resources, so concurrent files turn a valid test into a timing race.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 5000,
    hookTimeout: 5000,
    env: {
      // Keep codex run-plan tests hermetic from this machine's live private_workflow_02795d76f57fcc9a
      // route state; routeState tests pass explicit paths instead.
      SM_CODEX_ROUTE_STATE_PATH: "/nonexistent/private_workflow_02795d76f57fcc9a-route-state.json",
    },
  },
});
