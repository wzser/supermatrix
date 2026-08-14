import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  restoreLarkManifests,
  snapshotLarkManifests,
} from "../../src/scripts/_weekly-upgrade-lark-rollback.js";

describe("weekly lark-cli rollback snapshot", () => {
  it("restores exact manifests around npm dependency convergence", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-lark-rollback-"));
    const packageJson = Buffer.from('{"dependencies":{"@larksuite/cli":"1.2.3"}}\n');
    const packageLock = Buffer.from('{"lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(dir, "package.json"), packageJson);
    writeFileSync(join(dir, "package-lock.json"), packageLock);

    try {
      const snapshot = snapshotLarkManifests(dir);
      expect(snapshot.status).toBe("pass");
      if (snapshot.status !== "pass") return;
      writeFileSync(join(dir, "package.json"), '{"changed":true}\n');
      writeFileSync(join(dir, "package-lock.json"), '{"changed":true}\n');
      const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

      const restored = restoreLarkManifests(snapshot, {
        supermatrixDir: dir,
        npmBin: "/usr/local/bin/npm",
        runCommand(command, args, options) {
          calls.push({ command, args, cwd: options.cwd });
          expect(readFileSync(join(dir, "package.json"))).toEqual(packageJson);
          writeFileSync(join(dir, "package-lock.json"), '{"npmNormalized":true}\n');
        },
      });

      expect(restored).toEqual({ status: "pass" });
      expect(calls).toEqual([{
        command: "/usr/local/bin/npm",
        args: ["install", "--ignore-scripts"],
        cwd: dir,
      }]);
      expect(readFileSync(join(dir, "package.json"))).toEqual(packageJson);
      expect(readFileSync(join(dir, "package-lock.json"))).toEqual(packageLock);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the original manifests even when dependency convergence fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-lark-rollback-fail-"));
    const packageJson = Buffer.from('{"dependencies":{"@larksuite/cli":"1.2.3"}}\n');
    const packageLock = Buffer.from('{"lockfileVersion":3,"packages":{}}\n');
    writeFileSync(join(dir, "package.json"), packageJson);
    writeFileSync(join(dir, "package-lock.json"), packageLock);

    try {
      const snapshot = snapshotLarkManifests(dir);
      expect(snapshot.status).toBe("pass");
      if (snapshot.status !== "pass") return;
      writeFileSync(join(dir, "package.json"), '{"changed":true}\n');

      const restored = restoreLarkManifests(snapshot, {
        supermatrixDir: dir,
        npmBin: "/usr/local/bin/npm",
        runCommand() {
          writeFileSync(join(dir, "package-lock.json"), '{"partial":true}\n');
          throw new Error("npm install failed");
        },
      });

      expect(restored).toEqual({
        status: "fail",
        error: "cannot restore lark-cli manifests: npm install failed",
      });
      expect(readFileSync(join(dir, "package.json"))).toEqual(packageJson);
      expect(readFileSync(join(dir, "package-lock.json"))).toEqual(packageLock);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
