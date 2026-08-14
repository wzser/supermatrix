import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIMI_AUTONOMOUS_TURN_PATCH_BINARY,
  KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT,
  KIMI_PATCH_MARKER_OUTPUT_MAX_BUFFER,
  buildKimiPatchFailureSpawnBody,
  discardKimiBinarySnapshot,
  restoreKimiBinarySnapshot,
  runKimiAutonomousTurnPatch,
  snapshotKimiBinary,
} from "../../src/scripts/_weekly-upgrade-kimi-patch.js";

describe("weekly Kimi SM-PATCH recovery", () => {
  it("runs the mandatory patch script and verifies the installed binary marker", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = runKimiAutonomousTurnPatch((command, args) => {
      calls.push({ command, args });
      if (command === "strings") return "SM-PATCH (local fork)\n";
      return "patched OK\n";
    });

    expect(calls).toEqual([
      { command: "python3", args: [KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT] },
      { command: "strings", args: [KIMI_AUTONOMOUS_TURN_PATCH_BINARY] },
    ]);
    expect(result).toEqual({ status: "pass", markerCount: 1 });
  });

  it("allocates a bounded larger capture only for the noisy marker inspection", () => {
    const calls: Array<{
      command: string;
      args: string[];
      options?: { maxBuffer?: number };
    }> = [];
    const result = runKimiAutonomousTurnPatch((command, args, options) => {
      calls.push({ command, args, options });
      return command === "strings" ? "SM-PATCH (local fork)\n" : "patched OK\n";
    });

    expect(KIMI_PATCH_MARKER_OUTPUT_MAX_BUFFER).toBe(64 * 1024 * 1024);
    expect(calls).toEqual([
      {
        command: "python3",
        args: [KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT],
        options: undefined,
      },
      {
        command: "strings",
        args: [KIMI_AUTONOMOUS_TURN_PATCH_BINARY],
        options: { maxBuffer: KIMI_PATCH_MARKER_OUTPUT_MAX_BUFFER },
      },
    ]);
    expect(result).toEqual({ status: "pass", markerCount: 1 });
  });

  it("fails closed when the post-upgrade binary has no SM-PATCH marker", () => {
    const result = runKimiAutonomousTurnPatch((command) => (
      command === "strings" ? "unpatched binary\n" : "patched OK\n"
    ));

    expect(result).toMatchObject({ status: "fail", markerCount: 0 });
    expect(result.error).toContain('grep -c "SM-PATCH" returned 0');
  });

  it("stops on a patch-script failure without treating an old marker as success", () => {
    const calls: string[] = [];
    const result = runKimiAutonomousTurnPatch((command) => {
      calls.push(command);
      throw new Error("anchor drift");
    });

    expect(calls).toEqual(["python3"]);
    expect(result).toMatchObject({ status: "fail", markerCount: 0 });
    expect(result.error).toContain("anchor drift");
  });

  it("restores the exact pre-installer Kimi binary and executable mode", () => {
    const testDir = mkdtempSync(join(tmpdir(), "watchdog-kimi-snapshot-test-"));
    const binary = join(testDir, "kimi");
    writeFileSync(binary, "old-patched-binary");
    chmodSync(binary, 0o755);

    const snapshot = snapshotKimiBinary(binary);
    expect(snapshot.status).toBe("pass");
    if (snapshot.status !== "pass") throw new Error(snapshot.error);

    writeFileSync(binary, "new-unpatched-binary");
    chmodSync(binary, 0o700);

    expect(restoreKimiBinarySnapshot(snapshot)).toEqual({ status: "pass" });
    expect(readFileSync(binary, "utf-8")).toBe("old-patched-binary");
    expect(statSync(binary).mode & 0o777).toBe(0o755);

    discardKimiBinarySnapshot(snapshot);
    expect(existsSync(snapshot.snapshotDir)).toBe(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("routes a patch failure to codexroot with a stable per-run handoff id", () => {
    const body = buildKimiPatchFailureSpawnBody({
      runDate: "2026-07-22",
      patch: { status: "fail", markerCount: 0, error: "anchor drift" },
    });

    expect(body).toMatchObject({
      from: "watchdog",
      target: "codexroot",
      client_request_id: "2026-07-22:watchdog:kimi-sm-patch:codexroot",
      closure: { kind: "message", target: { type: "todo_pool" } },
    });
    expect(body.prompt).toContain("anchor drift");
    expect(body.prompt).toContain(KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT);
    expect(body.prompt).toContain("watchdog 不得修改该补丁脚本");
  });

  it("wires the mandatory restore and codexroot handoff into the Kimi installer path", () => {
    const source = readFileSync("src/scripts/weekly-upgrade.ts", "utf-8");

    expect(source).toContain("snapshotKimiBinary");
    expect(source).toContain("runKimiAutonomousTurnPatch");
    expect(source).toContain("restoreKimiBinarySnapshot");
    expect(source).toContain("discardKimiBinarySnapshot");
    expect(source).toContain('execFileSync("/bin/bash", [\n      "-l",\n      "-o",\n      "pipefail",');
    expect(source).toContain('"pipefail"');
    expect(source).not.toContain('["-lc", `curl -fsSL ${KIMI_CODE_INSTALLER_URL} | bash`]');
    expect(source).toContain("buildKimiPatchFailureSpawnBody");
    expect(source).toContain("reportKimiPatchFailure");
  });

  it("keeps the post-upgrade recovery contract in the root checklist and watchdog SOP", () => {
    const checklist = readFileSync("docs/weekly-cli-upgrade-checklist.md", "utf-8");
    const sop = readFileSync("sop/SOP-weekly-cli-upgrade-kimi-patch-active-20260806-kd7m2q.md", "utf-8");

    expect(checklist).toContain(KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT);
    expect(checklist).toContain("codexroot（T800）");
    expect(sop).toContain("strings ~/.kimi-code/bin/kimi | grep -c \"SM-PATCH\"");
    expect(sop).toContain("不要修改补丁脚本");
  });
});
