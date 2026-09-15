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


function inspectPatchedV2Fixture(bootstrapName = "bootstrap"): {
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

bootstrap_name = sys.argv[2]
fixture = (
    module.ANCHOR_V2_CTOR
    + "\n"
    + module.ANCHOR_V2_ACP_HOME_DIR
    + "\n"
    + module.ANCHOR_V2_BOOTSTRAP.replace("bootstrap({", bootstrap_name + "({")
)
patched = module.apply_js_patch(fixture)
print(json.dumps({
    "delta": len(patched.encode("utf-8")) - len(fixture.encode("utf-8")),
    "patched": patched,
    "verify": module.verify_sm_patch_markers(patched),
}))
`;
  const result = spawnSync("python3", ["-c", program, patchScript, bootstrapName], {
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

function repatchV2Fixture(): string {
  const program = String.raw`
import contextlib
import importlib.util
import io
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

fixture = (
    module.ANCHOR_V2_CTOR
    + "\\n"
    + module.ANCHOR_V2_ACP_HOME_DIR
    + "\\n"
    + module.ANCHOR_V2_BOOTSTRAP
)
patched = module.apply_js_patch(fixture)
with contextlib.redirect_stdout(io.StringIO()):
    repatched = module.apply_js_patch(patched)
print(repatched)
`;
  const result = spawnSync("python3", ["-c", program, patchScript], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

type NativeV2MarkerFailure =
  | "missing-v2-engine"
  | "missing-acp-skills-dir-v2"
  | "duplicate-v2-engine"
  | "duplicate-acp-skills-dir-v2";

type NativeV2MarkerCheck = "apply_js_patch" | "verify_sm_patch_markers";

type NativeV2BootstrapFailure = "unknown" | "duplicate";

function nativeV2BootstrapFailure(fixture: NativeV2BootstrapFailure): {
  status: number | null;
  stderr: string;
} {
  const program = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

bootstrap = module.ANCHOR_V2_BOOTSTRAP.replace("bootstrap({", "bootstrap$2({")
if sys.argv[2] == "duplicate":
    bootstrap = module.ANCHOR_V2_BOOTSTRAP + "\n" + module.ANCHOR_V2_BOOTSTRAP_BUNDLER_SUFFIX
fixture = (
    module.ANCHOR_V2_CTOR
    + "\n"
    + module.ANCHOR_V2_ACP_HOME_DIR
    + "\n"
    + bootstrap
)
module.apply_js_patch(fixture)
raise SystemExit("unexpected success")
`;
  const result = spawnSync(
    "python3",
    ["-c", program, patchScript, fixture],
    { encoding: "utf8" },
  );

  return { status: result.status, stderr: result.stderr };
}

function insufficientSeaFixture(): {
  patchStatus: number;
  stderr: string;
  unchanged: boolean;
  backupExists: boolean;
} {
  const program = String.raw`
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

js = (
    "class AcpSession {\n"
    "\tconstructor(conn, session, sessionId, elicitationForm) {\n"
    + module.ANCHOR_V2_CTOR
    + "\n}\n"
    "function run(opts, homeDir, configPath) {\n"
    "\tconst acpInput = {\n"
    + module.ANCHOR_V2_ACP_HOME_DIR
    + "\n\t};\n"
    + module.ANCHOR_V2_BOOTSTRAP
    + "\n\t\t}\n\t});\n}\n"
)
blob = (
    module.MAGIC
    + bytes(5)
    + (0).to_bytes(8, "little")
    + len(js.encode("utf-8")).to_bytes(8, "little")
    + js.encode("utf-8")
    + (0).to_bytes(8, "little")
)

header = bytearray(32)
header[0:4] = (0xFEEDFACF).to_bytes(4, "little")
header[16:20] = (2).to_bytes(4, "little")

sea_segment = bytearray(152)
sea_segment[0:4] = (0x19).to_bytes(4, "little")
sea_segment[4:8] = len(sea_segment).to_bytes(4, "little")
sea_segment[8:16] = b"NODE_SEA"
sea_segment[56:60] = (1).to_bytes(4, "little")
sea_segment[72:87] = b"__NODE_SEA_BLOB"
sea_segment[88:96] = b"NODE_SEA"
sea_segment[112:120] = len(blob).to_bytes(8, "little")
sea_segment[120:128] = (256).to_bytes(8, "little")

linkedit_segment = bytearray(72)
linkedit_segment[0:4] = (0x19).to_bytes(4, "little")
linkedit_segment[4:8] = len(linkedit_segment).to_bytes(4, "little")
linkedit_segment[8:18] = b"__LINKEDIT"
linkedit_segment[40:48] = (256 + len(blob)).to_bytes(8, "little")

with tempfile.TemporaryDirectory() as tmp:
    binary = Path(tmp) / "kimi"
    binary.write_bytes(bytes(header + sea_segment + linkedit_segment) + blob)
    before = binary.read_bytes()
    result = subprocess.run(
        [sys.executable, sys.argv[1], str(binary)],
        capture_output=True,
        text=True,
    )
    print(json.dumps({
        "patchStatus": result.returncode,
        "stderr": result.stderr,
        "unchanged": binary.read_bytes() == before,
        "backupExists": Path(str(binary) + ".pre-sm-patch").exists(),
    }))
`;
  const result = spawnSync("python3", ["-c", program, patchScript], {
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    patchStatus: number;
    stderr: string;
    unchanged: boolean;
    backupExists: boolean;
  };
}

function nativeV2MarkerFailure(
  fixture: NativeV2MarkerFailure,
  check: NativeV2MarkerCheck,
): {
  status: number | null;
  stderr: string;
} {
  const program = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("kimi_patch", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

fixture_name = sys.argv[2]
check_name = sys.argv[3]
compact_loader = module.COMPACT_V2_TURN_LOADER_TEMPLATE
if fixture_name == "missing-v2-engine":
    compact_loader = compact_loader.replace(module.PATCH_MARKER_V2_ENGINE, "")
elif fixture_name == "duplicate-v2-engine":
    compact_loader += "\\n/* " + module.PATCH_MARKER_V2_ENGINE + " */"

if fixture_name == "missing-acp-skills-dir-v2":
    skills_fragment = module.ANCHOR_V2_ACP_HOME_DIR
    bootstrap_fragment = module.ANCHOR_V2_BOOTSTRAP
else:
    skills_fragment = module.REPLACEMENT_V2_ACP_ARGS
    bootstrap_fragment = module.REPLACEMENT_V2_BOOTSTRAP
    if fixture_name == "duplicate-acp-skills-dir-v2":
        skills_fragment += "\\n/* " + module.PATCH_MARKER_SKILLS_DIR_V2 + " */"

fixture = compact_loader + "\\n" + skills_fragment + "\\n" + bootstrap_fragment
if module.ANCHOR_V2_CTOR in fixture:
    raise RuntimeError("native-V2 negative fixture still contains the ctor anchor")

if check_name == "apply_js_patch":
    module.apply_js_patch(fixture)
else:
    module.verify_sm_patch_markers(fixture)
raise SystemExit("unexpected success")
`;
  const result = spawnSync(
    "python3",
    ["-c", program, patchScript, fixture, check],
    { encoding: "utf8" },
  );

  return { status: result.status, stderr: result.stderr };
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

  it("accepts the native V2 bootstrap$1 symbol emitted by kimi-code 0.38.0", () => {
    const { delta, patched } = inspectPatchedV2Fixture("bootstrap$1");

    expect(delta).toBeLessThanOrEqual(3068);
    expect(patched).toContain("bootstrap$1({");
    expect(patched).toContain("args: opts.args");
    expect(patched).toContain("SM-PATCH acp-skills-dir-v2 (local fork)");
  });

  it.each([
    ["unknown bootstrap symbol", "unknown", "found 0x"],
    ["stable and suffixed bootstrap symbols together", "duplicate", "found 2x"],
  ] as const)("fails closed for %s", (_label, fixture, diagnostic) => {
    const result = nativeV2BootstrapFailure(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("anchor 'v2 acp bootstrap'");
    expect(result.stderr).toContain(diagnostic);
  });

  it("fails closed without writing when the synthetic SEA has no patch slack", () => {
    const result = insufficientSeaFixture();

    expect(result.patchStatus).toBe(1);
    expect(result.stderr).toContain("bytes beyond the section slack");
    expect(result.unchanged).toBe(true);
    expect(result.backupExists).toBe(false);
  });

  it("is idempotent after the compact V2 loader consumes the ctor anchor", () => {
    const repatched = repatchV2Fixture();

    expect(repatched).toContain("SM-PATCH v2-engine (local fork)");
    expect(repatched).toContain("SM-PATCH acp-skills-dir-v2 (local fork)");
  });

  it.each([
    [
      "missing acp-skills-dir-v2",
      "missing-acp-skills-dir-v2",
      "required SM-PATCH markers missing: acp-skills-dir-v2",
    ],
    [
      "missing v2-engine",
      "missing-v2-engine",
      "required SM-PATCH markers missing: v2-engine",
    ],
    [
      "duplicate v2-engine",
      "duplicate-v2-engine",
      "SM-PATCH markers duplicated: v2-engine",
    ],
    [
      "duplicate acp-skills-dir-v2",
      "duplicate-acp-skills-dir-v2",
      "SM-PATCH markers duplicated: acp-skills-dir-v2",
    ],
  ] as const)(
    "fails closed for a compact native-V2 fixture with %s after ctor-anchor consumption",
    (_label, fixture, diagnostic) => {
      for (const check of ["apply_js_patch", "verify_sm_patch_markers"] as const) {
        const result = nativeV2MarkerFailure(fixture, check);

        expect(result.status, `${check}: ${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(diagnostic);
      }
    },
  );

});
