import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  defaultCodexRouteStatePath,
  isCodexRouteOverrideActive,
  resolveCodexRouteExecution,
  resolveCodexRouteModel,
  resolveCodexRouteOverride,
  ROUTE_STATE_CONTRACT_VERSION,
} from "../../../src/adapters/backend-codex/routeState.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-route-state-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeState(state: unknown): string {
  const path = join(dir, `route-state-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state));
  return path;
}

function deepseekState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: ROUTE_STATE_CONTRACT_VERSION,
    backend: "codex",
    route: "deepseek",
    defaultModel: "deepseek-v4-flash",
    servedModels: ["deepseek-v4-flash", "deepseek-v4"],
    activatedAt: "2026-08-06T12:00:00+08:00",
    proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
    ...overrides,
  };
}

describe("resolveCodexRouteModel", () => {
  test("deepseek route remaps a non-served requested model to defaultModel", () => {
    const path = writeState(deepseekState());
    expect(resolveCodexRouteModel("gpt-5.6-terra", path)).toBe("deepseek-v4-flash");
  });

  test("deepseek route keeps a requested model already in servedModels", () => {
    const path = writeState(deepseekState());
    expect(resolveCodexRouteModel("deepseek-v4", path)).toBe("deepseek-v4");
  });

  test("openai route passes the requested model through", () => {
    const path = writeState(deepseekState({
      route: "openai",
      defaultModel: null,
      servedModels: [],
      proxy: null,
    }));
    expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("gpt-5.6-sol");
  });

  test("missing file fails open to the requested model", () => {
    expect(resolveCodexRouteModel("gpt-5.6-sol", join(dir, "does-not-exist.json"))).toBe(
      "gpt-5.6-sol",
    );
  });

  test("corrupt JSON fails open to the requested model", () => {
    const path = writeState("{not json");
    expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("gpt-5.6-sol");
  });

  test("non-object JSON fails open to the requested model", () => {
    const path = writeState("[1,2]");
    expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("gpt-5.6-sol");
  });

  test("unknown contract version fails open to the requested model", () => {
    const path = writeState(deepseekState({ contractVersion: "sm-switch.route-state/v2" }));
    expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("gpt-5.6-sol");
  });

  test("non-codex backend fails open to the requested model", () => {
    const path = writeState(deepseekState({ backend: "claude" }));
    expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("gpt-5.6-sol");
  });

  test("deepseek route without a usable defaultModel fails open", () => {
    for (const defaultModel of [null, "", "   ", 42]) {
      const path = writeState(deepseekState({ defaultModel }));
      expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("gpt-5.6-sol");
    }
  });

  test("malformed servedModels still remaps to defaultModel", () => {
    const path = writeState(deepseekState({ servedModels: "deepseek-v4-flash" }));
    expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("deepseek-v4-flash");
  });

  test("non-string servedModels entries are ignored", () => {
    const path = writeState(deepseekState({ servedModels: [42, null, "deepseek-v4"] }));
    expect(resolveCodexRouteModel("deepseek-v4", path)).toBe("deepseek-v4");
    expect(resolveCodexRouteModel("gpt-5.6-sol", path)).toBe("deepseek-v4-flash");
  });
});

describe("resolveCodexRouteExecution", () => {
  test("returns the model and activation boundary from one valid deepseek state", () => {
    const path = writeState(deepseekState());
    expect(resolveCodexRouteExecution("gpt-5.6-sol", path)).toEqual({
      model: "deepseek-v4-flash",
      activatedAt: Date.parse("2026-08-06T12:00:00+08:00"),
    });
  });

  test("fails open for an unavailable, unknown, or malformed route contract", () => {
    for (const path of [
      join(dir, "does-not-exist.json"),
      writeState("{not json"),
      writeState(deepseekState({ contractVersion: "sm-switch.route-state/v2" })),
      writeState(deepseekState({ activatedAt: "not-a-timestamp" })),
    ]) {
      expect(resolveCodexRouteExecution("gpt-5.6-sol", path)).toEqual({
        model: "gpt-5.6-sol",
        activatedAt: null,
      });
    }
  });
});

describe("resolveCodexRouteOverride", () => {
  test("reports the active route and the model it serves instead", () => {
    const path = writeState(deepseekState());
    expect(resolveCodexRouteOverride("gpt-5.6-sol", path)).toEqual({
      route: "deepseek",
      model: "deepseek-v4-flash",
    });
  });

  test("reports no override when the requested model is itself served", () => {
    const path = writeState(deepseekState());
    expect(resolveCodexRouteOverride("deepseek-v4", path)).toBeNull();
  });

  test("reports no override on a passthrough route", () => {
    const path = writeState(deepseekState({
      route: "openai",
      defaultModel: null,
      servedModels: [],
      proxy: null,
    }));
    expect(resolveCodexRouteOverride("gpt-5.6-sol", path)).toBeNull();
  });

  test("fails open to no override on a missing / corrupt / unknown-version state", () => {
    expect(resolveCodexRouteOverride("gpt-5.6-sol", join(dir, "does-not-exist.json"))).toBeNull();
    expect(resolveCodexRouteOverride("gpt-5.6-sol", writeState("{not json"))).toBeNull();
    expect(
      resolveCodexRouteOverride(
        "gpt-5.6-sol",
        writeState(deepseekState({ contractVersion: "sm-switch.route-state/v2" })),
      ),
    ).toBeNull();
  });
});

describe("isCodexRouteOverrideActive", () => {
  test("is true on the deepseek route regardless of the served model set", () => {
    expect(isCodexRouteOverrideActive(writeState(deepseekState()))).toBe(true);
    // Model-independent: still true for a state whose servedModels would make
    // resolveCodexRouteOverride report "no override" for a given model.
    expect(
      isCodexRouteOverrideActive(writeState(deepseekState({ servedModels: ["gpt-5.6-sol"] }))),
    ).toBe(true);
  });

  test("is false on a passthrough route", () => {
    const path = writeState(deepseekState({
      route: "openai",
      defaultModel: null,
      servedModels: [],
      proxy: null,
    }));
    expect(isCodexRouteOverrideActive(path)).toBe(false);
  });

  test("fails open to false on missing / corrupt / non-object state", () => {
    expect(isCodexRouteOverrideActive(join(dir, "does-not-exist.json"))).toBe(false);
    expect(isCodexRouteOverrideActive(writeState("{not json"))).toBe(false);
    expect(isCodexRouteOverrideActive(writeState("[1,2]"))).toBe(false);
  });

  test("fails open to false on unknown version / non-codex backend / no defaultModel", () => {
    expect(
      isCodexRouteOverrideActive(
        writeState(deepseekState({ contractVersion: "sm-switch.route-state/v2" })),
      ),
    ).toBe(false);
    expect(isCodexRouteOverrideActive(writeState(deepseekState({ backend: "claude" })))).toBe(false);
    expect(isCodexRouteOverrideActive(writeState(deepseekState({ defaultModel: "  " })))).toBe(false);
  });
});

describe("defaultCodexRouteStatePath", () => {
  const ORIGINAL_OVERRIDE = process.env["SM_CODEX_ROUTE_STATE_PATH"];
  const ORIGINAL_RUNTIME_ROOT = process.env["SM_RUNTIME_ROOT"];

  afterEach(() => {
    if (ORIGINAL_OVERRIDE === undefined) delete process.env["SM_CODEX_ROUTE_STATE_PATH"];
    else process.env["SM_CODEX_ROUTE_STATE_PATH"] = ORIGINAL_OVERRIDE;
    if (ORIGINAL_RUNTIME_ROOT === undefined) delete process.env["SM_RUNTIME_ROOT"];
    else process.env["SM_RUNTIME_ROOT"] = ORIGINAL_RUNTIME_ROOT;
  });

  test("honors SM_CODEX_ROUTE_STATE_PATH override", () => {
    process.env["SM_CODEX_ROUTE_STATE_PATH"] = "/custom/route-state.json";
    expect(defaultCodexRouteStatePath()).toBe("/custom/route-state.json");
  });

  test("derives from SM_RUNTIME_ROOT when no override is set", () => {
    delete process.env["SM_CODEX_ROUTE_STATE_PATH"];
    process.env["SM_RUNTIME_ROOT"] = "/rt";
    expect(defaultCodexRouteStatePath()).toBe("/rt/data/sm-switch/route-state.json");
  });
});
