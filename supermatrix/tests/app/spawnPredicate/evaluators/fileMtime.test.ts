import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { evaluateFileMtimePredicate } from "../../../../src/app/spawnPredicate/evaluators/fileMtime.ts";
import { validateSpawnPredicate } from "../../../../src/app/spawnPredicate/schema.ts";

describe("file-mtime predicate evaluator", () => {
  test("matches files whose mtime is at or after since", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sm-predicate-file-mtime-"));
    try {
      const artifactPath = join(dir, "artifact.txt");
      const mtimeMs = 1_700_000_000_000;
      await writeFile(artifactPath, "artifact\n", "utf8");
      await utimes(artifactPath, new Date(mtimeMs), new Date(mtimeMs));

      const predicate = validateSpawnPredicate(
        {
          type: "file-mtime",
          root_path: dir,
          path_glob: "artifact.txt",
          since: { kind: "timestamp_ms", value: mtimeMs },
        },
        { allowedPathRoots: [dir] }
      ).predicate;
      if (predicate.type !== "file-mtime") throw new Error("expected file-mtime predicate");

      await expect(evaluateFileMtimePredicate(predicate, { allowedPathRoots: [dir] })).resolves.toMatchObject({
        matched: true,
        observed_count: 1,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("rejects files whose mtime is before since", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sm-predicate-file-mtime-"));
    try {
      const artifactPath = join(dir, "artifact.txt");
      const mtimeMs = 1_700_000_000_000;
      await writeFile(artifactPath, "artifact\n", "utf8");
      await utimes(artifactPath, new Date(mtimeMs), new Date(mtimeMs));

      const predicate = validateSpawnPredicate(
        {
          type: "file-mtime",
          root_path: dir,
          path_glob: "artifact.txt",
          since: { kind: "timestamp_ms", value: mtimeMs + 1 },
        },
        { allowedPathRoots: [dir] }
      ).predicate;
      if (predicate.type !== "file-mtime") throw new Error("expected file-mtime predicate");

      await expect(evaluateFileMtimePredicate(predicate, { allowedPathRoots: [dir] })).resolves.toMatchObject({
        matched: false,
        observed_count: 0,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
