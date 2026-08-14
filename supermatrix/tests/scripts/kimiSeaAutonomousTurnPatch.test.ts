import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patchScript = path.resolve(
  import.meta.dirname,
  "../../scripts/kimi-sea-autonomous-turn-patch.py",
);

function inspectPatchedFixture(mainAgentId: string): {
  delta: number;
  injected: string;
  patched: string;
} {
  const program = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

predicate = (
    "(event) => event.agentId === void 0 || event.agentId === " + sys.argv[2]
)
acp_harness = (
    '\t\tconst harness = createKimiHarness({\n'
    '\t\t\tidentity: createKimiCodeHostIdentity(),\n'
    '\t\t\tuiMode: "acp"\n'
    '\t\t});'
)
prompt_harness = (
    '\tconst harness = await createPromptHarness({\n'
    '\t\tskillDirs: opts.skillsDirs,\n'
    '\t\tuiMode: "print"\n'
    '\t});'
)
fixture = (
    prompt_harness
    + "\n"
    + module.ANCHOR_CTOR
    + "\n"
    + module.ANCHOR_ENTRY
    + "\t\t\tconst isFromMainAgent = " + predicate + ";\n"
    + module.ANCHOR_FINALLY
    + acp_harness
)
patched = module.apply_js_patch(fixture)
print(json.dumps({
    "delta": len(patched.encode("utf-8")) - len(fixture.encode("utf-8")),
    "injected": patched,
    "patched": patched,
}))
`;
  const result = spawnSync("python3", ["-c", program, patchScript, mainAgentId], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    delta: number;
    injected: string;
    patched: string;
  };
}

function patchAlreadyV2Fixture(): string {
  const program = String.raw`
import contextlib
import importlib.util
import io
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

fixture = (
    "/* " + module.PATCH_MARKER_V2 + " */\n"
    + '\t\tconst harness = createKimiHarness({\n'
    + '\t\t\tidentity: createKimiCodeHostIdentity(),\n'
    + '\t\t\tuiMode: "acp"\n'
    + '\t\t});'
)
with contextlib.redirect_stdout(io.StringIO()):
    patched = module.apply_js_patch(fixture)
print(patched)
`;
  const result = spawnSync("python3", ["-c", program, patchScript], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function verifyMarkerFixture(js: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const program = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

print(module.verify_sm_patch_markers(sys.argv[2]))
`;
  const result = spawnSync("python3", ["-c", program, patchScript, js], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseVerifyCliFixture(): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const program = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

sys.argv = ["kimi-sea-autonomous-turn-patch.py", "--verify", "/tmp/kimi"]
binary, verify_only = module.parse_cli()
print(json.dumps({"binary": str(binary), "verifyOnly": verify_only}))
`;
  const result = spawnSync("python3", ["-c", program, patchScript], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function verifySidecarFixture(sidecar: "present" | "missing"): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const program = String.raw`
import importlib.util
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as tmp:
    binary = Path(tmp) / "kimi"
    binary.write_bytes(b"binary")
    if sys.argv[2] == "present":
        Path(str(binary) + ".sm.cjs").write_text("(() => {})")
    module.verify_runtime_sidecar(binary, 'process.execPath+".sm.cjs"')
print("ok")
`;
  const result = spawnSync("python3", ["-c", program, patchScript, sidecar], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}


function inspectPatchedV2Fixture(): {
  delta: number;
  patched: string;
} {
  const program = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

fixture = (
    module.ANCHOR_V2_CTOR
    + "\n"
    + module.ANCHOR_V2_ACP_HOME_DIR
    + "\n"
    + module.ANCHOR_V2_BOOTSTRAP
)
patched = module.apply_js_patch(fixture)
print(json.dumps({
    "delta": len(patched.encode("utf-8")) - len(fixture.encode("utf-8")),
    "patched": patched,
    "verify": module.verify_sm_patch_markers(patched),
}))
`;
  const result = spawnSync("python3", ["-c", program, patchScript], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    delta: number;
    patched: string;
    verify: number;
  };
  return { delta: parsed.delta, patched: parsed.patched };
}

describe("kimi SEA autonomous-turn patch", () => {
  it("fits the 1700-byte SEA slack shipped by kimi-code 0.29.0", () => {
    expect(inspectPatchedFixture("MAIN_AGENT_ID$8").delta).toBeLessThanOrEqual(1700);
  });

  it("copies the target bundle's main-agent predicate into the injected listener", () => {
    const { injected } = inspectPatchedFixture("MAIN_AGENT_ID$8");

    expect(injected).toContain("MAIN_AGENT_ID$8");
    expect(injected).not.toContain("MAIN_AGENT_ID$7");
  });

  it("fits kimi-code 0.30.0's 2322-byte SEA slack after its main-agent renumbering", () => {
    const { delta, injected } = inspectPatchedFixture("MAIN_AGENT_ID$5");

    expect(delta).toBeLessThanOrEqual(2322);
    expect(injected).toContain("MAIN_AGENT_ID$5");
  });

  it("fits the 314-byte SEA slack implied by the failed 0.30.0 upgrade receipt", () => {
    const { delta } = inspectPatchedFixture("MAIN_AGENT_ID$5");

    expect(delta).toBeLessThanOrEqual(314);
  });

  it("loads the compact runtime helper through a SEA-safe binary sidecar", () => {
    const { patched } = inspectPatchedFixture("MAIN_AGENT_ID$5");

    expect(patched).toContain('process.execPath+".sm.cjs"');
    expect(patched).not.toContain("/Users/LOCAL_USER/SuperMatrix/scripts/kimi-sea-runtime.cjs");
  });

  it("closes the ACP-only skills-dir omission without changing the prompt path", () => {
    const { patched } = inspectPatchedFixture("MAIN_AGENT_ID$8");

    expect(patched.match(/skillDirs: opts\.skillsDirs/g)).toHaveLength(1);
    expect(patched.match(/uiMode: "print"/g)).toHaveLength(1);
    expect(patched).toContain("skillDirs: parent.opts().skillsDir");
    expect(patched.match(/uiMode: "acp"/g)).toHaveLength(1);
  });

  it("adds the skills-dir fix to a binary that already carries the v2 turn patch", () => {
    expect(patchAlreadyV2Fixture()).toContain(
      "skillDirs: parent.opts().skillsDir",
    );
  });

  it("keeps watchdog's marker audit read-only and requires both markers", () => {
    const success = verifyMarkerFixture(
      "/* SM-PATCH v2 (local fork) */\n/* SM-PATCH acp-skills-dir (local fork) */",
    );
    const missing = verifyMarkerFixture("/* SM-PATCH v2 (local fork) */");

    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout.trim()).toBe("2");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("required SM-PATCH markers missing");
  });

  it("accepts the watchdog --verify CLI form without treating it as a binary path", () => {
    const result = parseVerifyCliFixture();

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      binary: "/tmp/kimi",
      verifyOnly: true,
    });
  });

  it("requires the compact runtime sidecar when auditing a compact binary", () => {
    const present = verifySidecarFixture("present");
    const missing = verifySidecarFixture("missing");

    expect(present.status, present.stderr).toBe(0);
    expect(present.stdout.trim()).toBe("ok");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("compact runtime sidecar not found");
  });
  it("fits kimi-code 0.33.0's 314-byte SEA slack on the native V2 layout", () => {
    const { delta, patched } = inspectPatchedV2Fixture();

    expect(delta).toBeLessThanOrEqual(314);
    expect(patched).toContain("SM-PATCH v2-engine (local fork)");
    expect(patched).toContain("SM-PATCH acp-skills-dir-v2 (local fork)");
  });

  it("forwards --skills-dir at the top level of the V2 ACP bootstrap input", () => {
    const { patched } = inspectPatchedV2Fixture();

    const argsLine = "\t\targs: opts.args,";
    const clientIdentity = "\t\tclientIdentity: {";
    expect(patched.match(new RegExp(argsLine.replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(patched.indexOf(argsLine)).toBeGreaterThan(-1);
    expect(patched.indexOf(clientIdentity)).toBeGreaterThan(patched.indexOf(argsLine));
  });

});
