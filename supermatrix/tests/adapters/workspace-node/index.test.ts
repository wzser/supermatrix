import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runGit } from "../../../src/adapters/workspace-node/git.ts";
import { NodeWorkspaceFs } from "../../../src/adapters/workspace-node/index.ts";
import { asAbsolutePath } from "../../../src/domain/ids.ts";

const execFileP = promisify(execFile);

let dir: string;
let fs: NodeWorkspaceFs;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "supermatrix-ws-"));
  fs = new NodeWorkspaceFs({
    gitUserName: "SuperMatrix Console",
    gitUserEmail: "console@supermatrix.local",
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("NodeWorkspaceFs", () => {
  test("mkdir, writeFile, readFile, exists round trip", async () => {
    const target = asAbsolutePath(join(dir, "sub"));
    await fs.mkdir(target);
    expect(await fs.exists(target)).toBe(true);
    const file = asAbsolutePath(join(target, "hello.txt"));
    await fs.writeFile(file, "hi");
    expect(await fs.readFile(file)).toBe("hi");
  });

  test("rmrf removes non-empty directory", async () => {
    const target = asAbsolutePath(join(dir, "x"));
    await fs.mkdir(target);
    await fs.writeFile(asAbsolutePath(join(target, "a.txt")), "a");
    await fs.rmrf(target);
    expect(await fs.exists(target)).toBe(false);
  });

  test("gitInit then gitCommit succeeds with --allow-empty", async () => {
    const wd = asAbsolutePath(join(dir, "repo"));
    await fs.mkdir(wd);
    await fs.gitInit(wd);
    const readme = asAbsolutePath(join(wd, "README.md"));
    await fs.writeFile(readme, "hi");
    await fs.gitCommit(wd, "initial", [readme]);
    await fs.gitCommit(wd, "empty sync", []);
  });

  test("gitCommit author identifies the acting session and target repo", async () => {
    const wd = asAbsolutePath(join(dir, "target-repo"));
    fs = new NodeWorkspaceFs({
      gitActorSessionName: "watchdog",
      gitUserEmail: "watchdog@supermatrix.local",
    });
    await fs.mkdir(wd);
    await fs.gitInit(wd);
    const readme = asAbsolutePath(join(wd, "README.md"));
    await fs.writeFile(readme, "hi");

    await fs.gitCommit(wd, "initial", [readme]);

    const { stdout } = await execFileP("git", ["log", "-1", "--format=%an <%ae>"], { cwd: wd });
    expect(stdout.trim()).toBe("watchdog-target-repo <watchdog@supermatrix.local>");
  });

  test("gitCommit with explicit paths ignores nested repos in the worktree", async () => {
    // Reproduces the deepsearch failure mode: a sibling subdirectory contains
    // only a `.git/` (no checkout), which would make `git add -A` fatal. The
    // path-scoped commit must succeed because we never sweep the worktree.
    const wd = asAbsolutePath(join(dir, "repo"));
    await fs.mkdir(wd);
    await fs.gitInit(wd);

    const nestedRepo = join(wd, "refs", "external");
    await mkdir(nestedRepo, { recursive: true });
    await runGit(asAbsolutePath(nestedRepo), ["init", "-q"]);
    // No checkout, just a leftover untracked path inside that nested repo.
    await writeFile(join(nestedRepo, "stray.txt"), "x");

    const tracked = asAbsolutePath(join(wd, "NOTES.md"));
    await fs.writeFile(tracked, "# only this");

    // Must not throw — `git add -- NOTES.md` never touches refs/.
    await expect(
      fs.gitCommit(wd, "notes: initial", [tracked]),
    ).resolves.toBeUndefined();
  });
});
