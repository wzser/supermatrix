import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LarkManifestSnapshot =
  | {
      status: "pass";
      packageJsonPath: string;
      packageLockPath: string;
      packageJson: Buffer;
      packageLock: Buffer;
    }
  | { status: "fail"; error: string };

type RestoreCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; stdio: "ignore" },
) => void;

export function snapshotLarkManifests(
  supermatrixDir: string,
): LarkManifestSnapshot {
  const packageJsonPath = join(supermatrixDir, "package.json");
  const packageLockPath = join(supermatrixDir, "package-lock.json");
  try {
    return {
      status: "pass",
      packageJsonPath,
      packageLockPath,
      packageJson: readFileSync(packageJsonPath),
      packageLock: readFileSync(packageLockPath),
    };
  } catch (error) {
    return {
      status: "fail",
      error: `cannot snapshot lark-cli manifests: ${(error as Error).message}`.slice(0, 300),
    };
  }
}

export function restoreLarkManifests(
  snapshot: Extract<LarkManifestSnapshot, { status: "pass" }>,
  input: {
    supermatrixDir: string;
    npmBin: string;
    runCommand: RestoreCommandRunner;
  },
): { status: "pass" } | { status: "fail"; error: string } {
  const restoreFiles = () => {
    writeFileSync(snapshot.packageJsonPath, snapshot.packageJson);
    writeFileSync(snapshot.packageLockPath, snapshot.packageLock);
  };
  try {
    restoreFiles();
    input.runCommand(input.npmBin, ["install", "--ignore-scripts"], {
      cwd: input.supermatrixDir,
      timeout: 300_000,
      stdio: "ignore",
    });
    // npm may normalize the lockfile even when dependency bytes are unchanged.
    // The rollback contract is exact restoration of the pre-upgrade manifests.
    restoreFiles();
    return { status: "pass" };
  } catch (error) {
    try {
      restoreFiles();
    } catch {
      // The original restore error remains the actionable failure below.
    }
    return {
      status: "fail",
      error: `cannot restore lark-cli manifests: ${(error as Error).message}`.slice(0, 300),
    };
  }
}
