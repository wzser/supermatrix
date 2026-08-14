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
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
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
          slug: "gpt-5.6-sol",
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
        slug: "gpt-5.6-sol",
        models: TEST_CODEX_CATALOG,
        totalCandidates: TEST_CODEX_CATALOG.length,
      }),
    );
    const r = await check.run(ctx(), "execute");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.detail).toMatchObject({ source: "detected", slug: "gpt-5.6-sol" });
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBe("gpt-5.6-sol");
  });

  it("on resolver ok, writes slug into env and reports detected", async () => {
    const check = createCodexDefaultModelCheck(
      makeDeps({
        kind: "ok",
        slug: "gpt-5.6-sol",
        models: TEST_CODEX_CATALOG,
        totalCandidates: TEST_CODEX_CATALOG.length,
      }),
    );
    const r = await check.run(ctx(), "execute");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.detail).toMatchObject({
        source: "detected",
        slug: "gpt-5.6-sol",
        candidates: TEST_CODEX_CATALOG.length,
      });
    }
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBe("gpt-5.6-sol");
    expect(getCodexBundledModels()).toEqual(TEST_CODEX_CATALOG);
  });

  it("does not treat hidden 5.4 deprecations as active alias drift", async () => {
    process.env.SM_CODEX_DEFAULT_MODEL = "gpt-5.5";
    const currentCatalog = [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ];
    const check = createCodexDefaultModelCheck(
      makeDeps({
        kind: "ok",
        slug: "gpt-5.6-sol",
        models: currentCatalog,
        totalCandidates: currentCatalog.length,
      }),
    );

    const r = await check.run(ctx(), "execute");

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.detail).toMatchObject({ source: "env", slug: "gpt-5.5" });
    }
    expect(getCodexBundledModels()).toEqual(currentCatalog);
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBe("gpt-5.5");
  });

  it("warns with stable structured detail when an active alias target drifts", async () => {
    process.env.SM_CODEX_DEFAULT_MODEL = "gpt-5.5";
    const driftedCatalog = [
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
    ];
    const check = createCodexDefaultModelCheck(
      makeDeps({
        kind: "ok",
        slug: "gpt-5.6-sol",
        models: driftedCatalog,
        totalCandidates: driftedCatalog.length,
      }),
    );

    const r = await check.run(ctx(), "execute");

    expect(r.status).toBe("warn");
    if (r.status === "warn") {
      expect(r.message).toContain("terra->gpt-5.6-terra");
      expect(r.detail).toMatchObject({
        source: "env",
        slug: "gpt-5.5",
        reasonCode: "CODEX_ALIAS_CATALOG_DRIFT",
        aliases: [
          { alias: "gpt5.6-terra", target: "gpt-5.6-terra" },
          { alias: "terra", target: "gpt-5.6-terra" },
          { alias: "5.6-terra", target: "gpt-5.6-terra" },
        ],
      });
    }
    expect(getCodexBundledModels()).toEqual(driftedCatalog);
    expect(process.env.SM_CODEX_DEFAULT_MODEL).toBe("gpt-5.5");
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
    expect(getCodexBundledModels()).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("phase is pre-wiring", () => {
    const check = createCodexDefaultModelCheck(
      makeDeps({ kind: "fail", error: "x" }),
    );
    expect(check.phases).toEqual(["pre-wiring"]);
    expect(check.name).toBe("codex-default-model");
  });
});
