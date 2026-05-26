import type { AbsolutePath } from "../domain/ids.ts";

export type WorkspaceFs = {
  exists(path: AbsolutePath): Promise<boolean>;
  mkdir(path: AbsolutePath): Promise<void>;
  rmrf(path: AbsolutePath): Promise<void>;
  readFile(path: AbsolutePath): Promise<string>;
  writeFile(path: AbsolutePath, content: string): Promise<void>;
  copyFile(src: AbsolutePath, dest: AbsolutePath): Promise<void>;
  symlink(target: AbsolutePath, linkPath: AbsolutePath): Promise<void>;
  listDir(path: AbsolutePath): Promise<string[]>;
  gitInit(workdir: AbsolutePath): Promise<void>;
  // Stages exactly the given paths (no `git add -A`) and creates a commit.
  // Empty `paths` still produces an `--allow-empty` commit but stages nothing —
  // never sweep the worktree, so nested repos / agent-clones stay untouched.
  gitCommit(
    workdir: AbsolutePath,
    message: string,
    paths: AbsolutePath[],
  ): Promise<void>;
};
