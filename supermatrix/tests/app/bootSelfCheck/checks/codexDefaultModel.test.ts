import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexDefaultModelCheck } from "../../../../src/app/bootSelfCheck/checks/codexDefaultModel.ts";
import type {
  CodexDefaultModelResolution,
  CodexDefaultModelCheckDeps,
} from "../../../../src/app/bootSelfCheck/checks/codexDefaultModel.ts";
import type { BootCheckContext } from "../../../../src/app/bootSelfCheck/types.ts";
import {
  getCodexBundledModels,
  resetCodexModelCatalogForTests,
} from "../../../../src/ports/CodexModelCatalog.ts";

function ctx(): BootCheckContext {
  return {
    cfg: {} as BootCheckContext["cfg"],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({} as never),
    } as never,
    processLister: {
      list: async () => [],
      killAll: async () => [],
      getCommand: async () => null,
      getProcessInfo: async () => null,
    },
  };
}

function makeDeps(result: CodexDefaultModelResolution): CodexDefaultModelCheckDeps {
  return {
    resolve: async () => result,
  };
}

const TEST_CODEX_CATALOG = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
];

describe("codex-default-model", () => {
  const ORIGINAL_ENV = process.env.SM_CODEX_DEFAULT_MODEL;

  beforeEach(() => {
    delete process.env.SM_CODEX_DEFAULT_MODEL;
    resetCodexModelCatalogForTests(["pre-test-model"]);
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SM_CODEX_DEFAULT_MODEL;
    else process.env.SM_CODEX_DEFAULT_MODEL = ORIGINAL_ENV;
    resetCodexModelCatalogForTests();
  });

  it("returns ok+source=env when SM_CODEX_DEFAULT_MODEL is already set and present in detected catalog", async () => {
    process.env.SM_CODEX_DEFAULT_MODEL = "gpt-5.4";
    const check = createCodexDefaultModelCheck({
      resolve: async () => {
        return {
          kind: "ok",
          slug: "gpt-5.5",
          models: TEST_CODEX_CATALOG,
          totalCandidates: TEST_CODEX_CATALOG.length,
        };
      },
    });
    const r = await check.run(ctx(), "execute");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.detail).toMatchObject({ source: "env", slug: "gpt-5.4" });
    expect(getCodexBundledModels()).toEqual(TEST_CODEX_CATALOG);
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBe("gpt-5.4");
  });

  it("treats whitespace-only env as unset and falls through to detection", async () => {
    process.env.SM_CODEX_DEFAULT_MODEL = "   ";
    const check = createCodexDefaultModelCheck(
      makeDeps({
        kind: "ok",
        slug: "gpt-5.5",
        models: TEST_CODEX_CATALOG,
        totalCandidates: TEST_CODEX_CATALOG.length,
      }),
    );
    const r = await check.run(ctx(), "execute");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.detail).toMatchObject({ source: "detected", slug: "gpt-5.5" });
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBe("gpt-5.5");
  });

  it("on resolver ok, writes slug into env and reports detected", async () => {
    const check = createCodexDefaultModelCheck(
      makeDeps({
        kind: "ok",
        slug: "gpt-5.5",
        models: TEST_CODEX_CATALOG,
        totalCandidates: TEST_CODEX_CATALOG.length,
      }),
    );
    const r = await check.run(ctx(), "execute");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.detail).toMatchObject({
        source: "detected",
        slug: "gpt-5.5",
        candidates: TEST_CODEX_CATALOG.length,
      });
    }
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBe("gpt-5.5");
    expect(getCodexBundledModels()).toEqual(TEST_CODEX_CATALOG);
  });

  it("on resolver fail, returns warn and caches the safe fallback catalog", async () => {
    const check = createCodexDefaultModelCheck(
      makeDeps({ kind: "fail", error: "codex binary not found on PATH" }),
    );
    const r = await check.run(ctx(), "execute");
    expect(r.status).toBe("warn");
    if (r.status === "warn") {
      expect(r.message).toContain("codex binary not found");
      expect(r.message).toContain("using fallback codex model list, expect drift");
    }
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBeUndefined();
    expect(getCodexBundledModels()).toEqual(["gpt-5.5", "gpt-5.4"]);
  });

  it("phase is pre-wiring", () => {
    const check = createCodexDefaultModelCheck(
      makeDeps({ kind: "fail", error: "x" }),
    );
    expect(check.phases).toEqual(["pre-wiring"]);
    expect(check.name).toBe("codex-default-model");
  });
});
