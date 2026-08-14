import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("verify-caller-provenance", () => {
  test("E1/E3 use Node-shaped processes to prove env harvest and replay", async () => {
    const { stdout } = await execFileAsync(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      ["scripts/verify-caller-provenance.ts"],
      { cwd: repoRoot, timeout: 10_000 },
    );

    expect(stdout).toContain(
      "PASS  E1 same-uid sibling can read a Node backend process env",
    );
    expect(stdout).toContain(
      "an env-injected attestation is harvestable and replayable",
    );
    expect(stdout).toMatch(
      /PASS  E3 replaying a harvested victim token.+victimPid=\d+ requesterPid=\d+/su,
    );
  });
});
