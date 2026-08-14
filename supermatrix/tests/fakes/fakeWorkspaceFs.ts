import type { AbsolutePath } from "../../src/domain/ids.ts";
import type { WorkspaceFs } from "../../src/ports/WorkspaceFs.ts";

export function createFakeWorkspaceFs(seed: Record<string, string> = {}): WorkspaceFs & {
  files: Map<string, string>;
  dirs: Set<string>;
  commits: Array<{ workdir: string; message: string; paths: string[] }>;
  symlinks: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const commits: Array<{ workdir: string; message: string; paths: string[] }> = [];
  const symlinks = new Map<string, string>();

  return {
    files,
    dirs,
    commits,
    symlinks,
    async exists(path: AbsolutePath): Promise<boolean> {
      return files.has(path) || dirs.has(path);
    },
    async mkdir(path: AbsolutePath): Promise<void> {
      dirs.add(path);
    },
    async rmrf(path: AbsolutePath): Promise<void> {
      dirs.delete(path);
      const prefix = path.endsWith("/") ? path : path + "/";
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(prefix)) files.delete(key);
      }
    },
    async readFile(path: AbsolutePath): Promise<string> {
      const val = files.get(path);
      if (val === undefined) throw new Error(`fake readFile: missing ${path}`);
      return val;
    },
    async writeFile(path: AbsolutePath, content: string): Promise<void> {
      files.set(path, content);
    },
    async copyFile(src: AbsolutePath, dest: AbsolutePath): Promise<void> {
      const val = files.get(src);
      if (val === undefined) throw new Error(`fake copyFile: missing ${src}`);
      files.set(dest, val);
    },
    async symlink(target: AbsolutePath, linkPath: AbsolutePath): Promise<void> {
      symlinks.set(linkPath, target);
      files.set(linkPath, `-> ${target}`);
    },
    async listDir(path: AbsolutePath): Promise<string[]> {
      const prefix = path.endsWith("/") ? path : path + "/";
      const entries = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const firstSegment = rest.split("/")[0];
          if (firstSegment) entries.add(firstSegment);
        }
      }
      return [...entries].sort();
    },
    async gitInit(workdir: AbsolutePath): Promise<void> {
      dirs.add(workdir);
    },
    async gitCommit(
      workdir: AbsolutePath,
      message: string,
      paths: AbsolutePath[],
    ): Promise<void> {
      commits.push({ workdir, message, paths: [...paths] });
    },
  };
}
