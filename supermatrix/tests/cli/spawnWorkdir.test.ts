import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveLinkedSpawnWorkdir } from "../../src/cli/apiServer.ts";
import { asAbsolutePath } from "../../src/domain/ids.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `spawn-workdir-${label}-`));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "spawn-workdir-test@example.com");
  git(root, "config", "user.name", "Spawn Workdir Test");
  writeFileSync(join(root, "tracked.txt"), label);
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

test("admits only a linked worktree of the target repository", async () => {
  const canonical = initRepo("target");
  const linked = `${canonical}-linked`;
  roots.push(linked);
  git(canonical, "worktree", "add", "--detach", linked, "refs/heads/main");

  await expect(resolveLinkedSpawnWorkdir({
    canonicalWorkdir: asAbsolutePath(canonical),
    requestedWorkdir: linked,
  })).resolves.toBe(realpathSync(linked));

  const unrelated = initRepo("unrelated");
  await expect(resolveLinkedSpawnWorkdir({
    canonicalWorkdir: asAbsolutePath(canonical),
    requestedWorkdir: unrelated,
  })).rejects.toThrow("not linked to target repository");

  await expect(resolveLinkedSpawnWorkdir({
    canonicalWorkdir: asAbsolutePath(canonical),
    requestedWorkdir: "relative/worktree",
  })).rejects.toThrow("must be absolute");
});
