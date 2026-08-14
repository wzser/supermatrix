import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  businessDate,
  loadDailyCommitGovernedRepos,
  resolveSopById,
  selectGovernedRepos,
} from "../../src/scripts/localgit-context.js";

const scratchDirs: string[] = [];

function scratchDir(): string {
  const path = mkdtempSync(join(tmpdir(), "localgit-context-"));
  scratchDirs.push(path);
  return path;
}

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

describe("localgit shared context", () => {
  it("uses Asia/Shanghai instead of UTC slicing", () => {
    expect(businessDate(new Date("2026-07-13T19:15:00.000Z"))).toBe("2026-07-14");
  });

  it("resolves exactly one SOP by stable id", () => {
    const root = scratchDir();
    writeFileSync(join(root, "SOP-x-active-20260714-abc123.md"), "x\n");

    expect(resolveSopById(root, "abc123")).toBe(join(root, "SOP-x-active-20260714-abc123.md"));
    expect(() => resolveSopById(root, "missing")).toThrow("found 0");

    writeFileSync(join(root, "SOP-y-active-20260715-abc123.md"), "y\n");
    expect(() => resolveSopById(root, "abc123")).toThrow("found 2");
  });

  it("keeps only governed unique git workdirs", () => {
    const rows = [
      { name: "one", path: "/repos/shared", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "平台" },
      { name: "alias", path: "/repos/shared", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "工具" },
      { name: "affiliate", path: "/repos/affiliate", status: "idle", scope: "user", affiliatedTo: "one", category: "平台" },
      { name: "not-git", path: "/repos/not-git", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "业务" },
    ];

    const repos = selectGovernedRepos(
      rows,
      (path) => path !== "/repos/not-git",
    );

    expect(repos).toEqual([{ name: "one", path: "/repos/shared" }]);
  });

  it("derives daily-commit scope from session governance fields without reading the legacy control page", () => {
    let legacyControlRead = false;
    const deps = {
      // This deliberately remains an extra property after the control-plane dependency is removed.
      // If production code ever starts reading the retired checkbox again, this assertion catches it.
      fetchControlPage: () => {
        legacyControlRead = true;
        return JSON.stringify({
          ok: true,
          data: { fields: ["Session", "Daily Commit"], data: [], has_more: false },
        });
      },
      fetchSessionRows: () => [
        { name: "primary", path: "/repos/shared", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "平台" },
        { name: "shared-alias", path: "/repos/shared", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "工具" },
        { name: "not-git", path: "/repos/not-git", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "业务" },
        { name: "deleted", path: "/repos/deleted", status: "deleted", scope: "user", affiliatedTo: "first-principle", category: "平台" },
        { name: "child", path: "/repos/child", status: "idle", scope: "child", affiliatedTo: "first-principle", category: "平台" },
        { name: "affiliate", path: "/repos/affiliate", status: "idle", scope: "user", affiliatedTo: "localgit", category: "平台" },
        { name: "external", path: "/repos/external", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "外部" },
        { name: "employee", path: "/repos/employee", status: "idle", scope: "user", affiliatedTo: "first-principle", category: "员工" },
      ],
      isGitRepo: (path) => path !== "/repos/not-git",
    };
    const selected = loadDailyCommitGovernedRepos(deps);

    expect(legacyControlRead).toBe(false);
    expect(selected).toEqual({
      governedSessionCount: 3,
      repos: [{ name: "primary", path: "/repos/shared" }],
    });
  });
});
