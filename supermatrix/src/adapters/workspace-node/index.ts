import { access, copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AbsolutePath } from "../../domain/ids.ts";
import type { WorkspaceFs } from "../../ports/WorkspaceFs.ts";
import { runGit, type GitIdentity } from "./git.ts";

export type NodeWorkspaceFsOptions = {
  gitUserName: string;
  gitUserEmail: string;
};

export class NodeWorkspaceFs implements WorkspaceFs {
  private readonly identity: GitIdentity;

  constructor(opts: NodeWorkspaceFsOptions) {
    this.identity = { name: opts.gitUserName, email: opts.gitUserEmail };
  }

  async exists(path: AbsolutePath): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: AbsolutePath): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async rmrf(path: AbsolutePath): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async readFile(path: AbsolutePath): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeFile(path: AbsolutePath, content: string): Promise<void> {
    await writeFile(path, content, "utf8");
  }

  async copyFile(src: AbsolutePath, dest: AbsolutePath): Promise<void> {
    await copyFile(src, dest);
  }

  async symlink(target: AbsolutePath, linkPath: AbsolutePath): Promise<void> {
    await symlink(target, linkPath);
  }

  async listDir(path: AbsolutePath): Promise<string[]> {
    return readdir(path);
  }

  async gitInit(workdir: AbsolutePath): Promise<void> {
    await runGit(workdir, ["init", "-q"]);
  }

  async gitCommit(
    workdir: AbsolutePath,
    message: string,
    paths: AbsolutePath[],
  ): Promise<void> {
    if (paths.length > 0) {
      await runGit(workdir, ["add", "--", ...paths]);
    }
    await runGit(workdir, ["commit", "--allow-empty", "-m", message], this.identity);
  }
}
