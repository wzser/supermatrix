import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");

describe("shared infrastructure shell scripts", () => {
  test("sync-bitable counters are updated in the parent shell", () => {
    const script = readFileSync(resolve(REPO_ROOT, "scripts/sync-bitable.sh"), "utf8");

    expect(script).not.toMatch(/\|\s*while\s+IFS=/u);
    expect(script).toMatch(/done\s*<\s*<\(/u);
  });

  test("setup-dogfood-session does not interpolate shell variables into SQL", () => {
    const script = readFileSync(resolve(REPO_ROOT, "scripts/setup-dogfood-session.sh"), "utf8");

    expect(script).not.toContain("WHERE name = '$SESSION_NAME'");
    expect(script).not.toContain("('$SESSION_ID', '$SESSION_NAME'");
    expect(script).toContain("import sqlite3");
  });
});
