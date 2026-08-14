import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const probeSource = readFileSync(
  path.resolve(import.meta.dirname, "../../scripts/probe-kimi-acp.mjs"),
  "utf8",
);

describe("probe-kimi-acp command selection", () => {
  it("uses SM_KIMI_CLI_PATH or the generic kimi command instead of the retired uv path", () => {
    expect(probeSource).toContain('const KIMI = process.env.SM_KIMI_CLI_PATH ?? "kimi";');
    expect(probeSource).not.toContain("/Users/LOCAL_USER/.local/bin/kimi");
  });
});
