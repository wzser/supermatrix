import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  restoreBackendRuntimeDefaults,
  type PersistedBackendRuntimeDefaults,
} from "../../src/app/backendRuntimeDefaultsBoot.ts";
import {
  getConfiguredBackendRuntimeDefaults,
  resetConfiguredBackendRuntimeDefaultsForTests,
} from "../../src/ports/BackendRuntimeDefaults.ts";
import { KIMI_K3_MODEL } from "../../src/ports/KimiModelCatalog.ts";
import { resolveRunExecutionConfig } from "../../src/ports/RunExecutionConfig.ts";

function row(patch: Partial<PersistedBackendRuntimeDefaults>): PersistedBackendRuntimeDefaults {
  return { backend: "kimi", model: null, effort: null, ...patch };
}

describe("restoreBackendRuntimeDefaults", () => {
  beforeEach(() => resetConfiguredBackendRuntimeDefaultsForTests());

  test("restores a persisted kimi default so a model-less kimi session executes it after boot", () => {
    const onInvalid = vi.fn();
    restoreBackendRuntimeDefaults([row({ backend: "kimi", model: KIMI_K3_MODEL })], onInvalid);

    expect(onInvalid).not.toHaveBeenCalled();
    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBe(KIMI_K3_MODEL);
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: null }),
    ).toEqual({ backend: "kimi", model: KIMI_K3_MODEL, effort: "high" });
  });

  test("restores claude and codex defaults alongside kimi", () => {
    restoreBackendRuntimeDefaults(
      [
        row({ backend: "claude", model: "claude-sonnet-5", effort: "high" }),
        row({ backend: "codex", model: "gpt-5.5" }),
        row({ backend: "kimi", model: KIMI_K3_MODEL }),
      ],
      vi.fn(),
    );

    expect(getConfiguredBackendRuntimeDefaults("claude")).toEqual({
      model: "claude-sonnet-5",
      effort: "high",
    });
    expect(getConfiguredBackendRuntimeDefaults("codex").model).toBe("gpt-5.5");
    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBe(KIMI_K3_MODEL);
  });

  test("a persisted kimi model outside the current catalog is reported and never applied", () => {
    const onInvalid = vi.fn();
    restoreBackendRuntimeDefaults([row({ backend: "kimi", model: "kimi-code/retired" })], onInvalid);

    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBeNull();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0]?.[0]).toMatchObject({ backend: "kimi" });
    expect(onInvalid.mock.calls[0]?.[1]).toContain("未知 kimi 模型");
  });

  test("a cleared (null) persisted default leaves the null passthrough intact", () => {
    const onInvalid = vi.fn();
    restoreBackendRuntimeDefaults([row({ backend: "kimi", model: null })], onInvalid);

    expect(onInvalid).not.toHaveBeenCalled();
    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBeNull();
    expect(
      resolveRunExecutionConfig({ backend: "kimi", model: null, effort: null }),
    ).toEqual({ backend: "kimi", model: null, effort: null });
  });

  test("one invalid row does not abort restoration of the remaining backends", () => {
    const onInvalid = vi.fn();
    restoreBackendRuntimeDefaults(
      [
        row({ backend: "claude", model: "claude-retired-9" }),
        row({ backend: "kimi", model: KIMI_K3_MODEL }),
      ],
      onInvalid,
    );

    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(getConfiguredBackendRuntimeDefaults("claude").model).toBeNull();
    expect(getConfiguredBackendRuntimeDefaults("kimi").model).toBe(KIMI_K3_MODEL);
  });
});
