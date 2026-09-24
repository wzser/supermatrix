import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildCodexForkBootstrapArgs,
  buildCodexForkBootstrapPrompt,
  extractCodexForkChildIdFromJsonLine,
} from "../../../src/adapters/backend-codex/forkBootstrap.ts";
import { asAbsolutePath } from "../../../src/domain/ids.ts";
import {
  resetCodexModelCatalogForTests,
  setCodexEffectiveDefaultModel,
  setCodexModelCatalog,
} from "../../../src/ports/CodexModelCatalog.ts";

describe("codex fork bootstrap", () => {
  afterEach(() => {
    resetCodexModelCatalogForTests();
  });

  test("builds exec resume json args instead of top-level codex fork", () => {
    const evidence: unknown[] = [];
    const args = buildCodexForkBootstrapArgs({
      sourceBackendSessionId: "source-1",
      sessionName: "test4",
      branchName: "plan-a",
      workdir: asAbsolutePath("/tmp/ws/test4"),
      model: "gpt-5.5",
      effort: "max",
      onEffortNormalized: (entry) => evidence.push(entry),
    });

    expect(args.slice(0, 4)).toEqual(["exec", "resume", "source-1", "--json"]);
    expect(args).not.toContain("fork");
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.5");
    // gpt-5.5 is a legacy model: max/ultra clamp down to xhigh at the CLI boundary.
    expect(args).toContain("model_reasoning_effort=xhigh");
    expect(args).not.toContain("model_reasoning_effort=max");
    expect(evidence).toEqual([{
      kind: "codex_effort_normalized",
      model: "gpt-5.5",
      persistedEffort: "max",
      cliEffort: "xhigh",
    }]);
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toContain("fork_context true");
  });

  test("pins model=null to the verified effective default for fork bootstrap", () => {
    setCodexModelCatalog(["first", "verified"], "test");
    setCodexEffectiveDefaultModel("verified");
    const args = buildCodexForkBootstrapArgs({
      sourceBackendSessionId: "source-1",
      sessionName: "test4",
      branchName: "plan-a",
      workdir: asAbsolutePath("/tmp/ws/test4"),
      model: null,
      effort: null,
    });

    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("verified");
    expect(args.at(-2)).toBe("--");
  });

  test("bootstrap prompt asks for one full-history child and no file inspection", () => {
    const prompt = buildCodexForkBootstrapPrompt({
      sessionName: "test4",
      branchName: "plan-a",
    });

    expect(prompt).toContain("spawn one full-history forked sub-agent");
    expect(prompt).toContain("fork_context true");
    expect(prompt).toContain("Reply with exactly BRANCH_READY");
    expect(prompt).toContain("Do not inspect files or make changes");
    expect(prompt).toContain("CHILD_ID=<id> RESULT=<child result>");
  });

  describe("sm-switch route-state resolution", () => {
    const ORIGINAL_ROUTE_STATE_PATH = process.env["SM_CODEX_ROUTE_STATE_PATH"];
    let routeDir: string;

    beforeEach(() => {
      routeDir = mkdtempSync(join(tmpdir(), "sm-route-fork-"));
    });

    afterEach(() => {
      rmSync(routeDir, { recursive: true, force: true });
      if (ORIGINAL_ROUTE_STATE_PATH === undefined) {
        delete process.env["SM_CODEX_ROUTE_STATE_PATH"];
      } else {
        process.env["SM_CODEX_ROUTE_STATE_PATH"] = ORIGINAL_ROUTE_STATE_PATH;
      }
    });

    function activateDeepseekRoute(overrides: Record<string, unknown> = {}): void {
      const path = join(routeDir, "route-state.json");
      writeFileSync(path, JSON.stringify({
        contractVersion: "sm-switch.route-state/v1",
        backend: "codex",
        route: "deepseek",
        defaultModel: "deepseek-v4-flash",
        servedModels: ["deepseek-v4-flash"],
        activatedAt: "2026-08-06T12:00:00+08:00",
        proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
        ...overrides,
      }));
      process.env["SM_CODEX_ROUTE_STATE_PATH"] = path;
    }

    function forkArgs(model: string | null, effort: string | null): string[] {
      return buildCodexForkBootstrapArgs({
        sourceBackendSessionId: "source-1",
        sessionName: "test4",
        branchName: "plan-a",
        workdir: asAbsolutePath("/tmp/ws/test4"),
        model,
        effort,
      });
    }

    test("deepseek route pins the fork --model to the served defaultModel", () => {
      activateDeepseekRoute();
      const args = forkArgs("gpt-5.6-sol", "high");
      expect(args[args.indexOf("--model") + 1]).toBe("deepseek-v4-flash");
      expect(args).toContain("model_reasoning_effort=high");
    });

    test("deepseek route pins a null (default-pinned) fork model too", () => {
      setCodexModelCatalog(["gpt-5.6-sol", "gpt-5.5"], "test");
      setCodexEffectiveDefaultModel("gpt-5.6-sol");
      activateDeepseekRoute();
      const args = forkArgs(null, null);
      expect(args[args.indexOf("--model") + 1]).toBe("deepseek-v4-flash");
    });

    test("deepseek route keeps a requested model already in servedModels", () => {
      activateDeepseekRoute({ servedModels: ["deepseek-v4-flash", "deepseek-v4"] });
      const args = forkArgs("deepseek-v4", null);
      expect(args[args.indexOf("--model") + 1]).toBe("deepseek-v4");
    });

    test("missing route-state file fails open to the requested model", () => {
      process.env["SM_CODEX_ROUTE_STATE_PATH"] = join(routeDir, "absent.json");
      const args = forkArgs("gpt-5.6-sol", null);
      expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    });

    test("unknown contract version fails open to the requested model", () => {
      activateDeepseekRoute({ contractVersion: "sm-switch.route-state/v9" });
      const args = forkArgs("gpt-5.6-sol", null);
      expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    });

    test("effort stays normalized against the requested model, not the routed one", () => {
      activateDeepseekRoute();
      const evidence: unknown[] = [];
      const args = buildCodexForkBootstrapArgs({
        sourceBackendSessionId: "source-1",
        sessionName: "test4",
        branchName: "plan-a",
        workdir: asAbsolutePath("/tmp/ws/test4"),
        model: "gpt-5.5",
        effort: "max",
        onEffortNormalized: (entry) => evidence.push(entry),
      });

      expect(args[args.indexOf("--model") + 1]).toBe("deepseek-v4-flash");
      // gpt-5.5 is legacy: max clamps to xhigh regardless of the served model.
      expect(args).toContain("model_reasoning_effort=xhigh");
      expect(evidence).toEqual([{
        kind: "codex_effort_normalized",
        model: "gpt-5.5",
        persistedEffort: "max",
        cliEffort: "xhigh",
      }]);
    });
  });

  test("extracts child id from item.completed collab_tool_call receiver_thread_ids", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "collab_tool_call",
        receiver_thread_ids: ["019f12c5-324f-7022-a2f6-46b9306162b3"],
      },
    });

    expect(extractCodexForkChildIdFromJsonLine(line)).toBe(
      "019f12c5-324f-7022-a2f6-46b9306162b3",
    );
  });

  test("extracts child id from function_call_output agent_id json", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: JSON.stringify({
          agent_id: "019f12c5-324f-7022-a2f6-46b9306162b3",
          nickname: "Halley",
        }),
      },
    });

    expect(extractCodexForkChildIdFromJsonLine(line)).toBe(
      "019f12c5-324f-7022-a2f6-46b9306162b3",
    );
  });

  test("extracts child id from final text fallback", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "CHILD_ID=019f12c5-324f-7022-a2f6-46b9306162b3 RESULT=BRANCH_READY",
      },
    });

    expect(extractCodexForkChildIdFromJsonLine(line)).toBe(
      "019f12c5-324f-7022-a2f6-46b9306162b3",
    );
  });
});
