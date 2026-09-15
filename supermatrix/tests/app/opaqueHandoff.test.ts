import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { asAbsolutePath } from "../../src/domain/ids.ts";
import { executeOpaqueHandoff, type OpaqueHandoff } from "../../src/app/opaqueHandoff.ts";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true });
});

describe("executeOpaqueHandoff", () => {
  test("feeds exact bytes and digest to the fixed consumer without a shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sm-opaque-executor-"));
    cleanup.push(cwd);
    const executable = join(cwd, "bin/parent-comment-problem-sync.sh");
    await mkdir(join(cwd, "bin"));
    await writeFile(executable, "#!/bin/sh\nprintf '%s|%s|%s' \"$(cat | base64 | tr -d '\\n')\" \"$SM_OPAQUE_HANDOFF_SHA256\" \"$4\"\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    const bytes = Buffer.from('{"delivery_mode":"spawn2_todo_pool"}\n', "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const handoff: OpaqueHandoff = {
      encodedBytes: bytes.toString("base64"),
      bytesSha256: digest,
      executable: "bin/parent-comment-problem-sync.sh",
      args: ["--input", "-", "--handoff-comm-id", "'<framework comm_id>'"],
    };

    const result = await executeOpaqueHandoff({
      cwd: asAbsolutePath(cwd),
      handoff,
      commId: "comm_exact_1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${bytes.toString("base64")}|${digest}|comm_exact_1`);
  });

  test("fails before spawning when the handoff digest is inconsistent", async () => {
    const bytes = Buffer.from("spawn2_todo_pool", "utf8");
    await expect(executeOpaqueHandoff({
      cwd: asAbsolutePath("/tmp"),
      handoff: {
        encodedBytes: bytes.toString("base64"),
        bytesSha256: "0".repeat(64),
        executable: "bin/parent-comment-problem-sync.sh",
        args: ["--input", "-", "--handoff-comm-id", "'<framework comm_id>'"],
      },
      commId: "comm_digest_mismatch",
    })).rejects.toThrow("digest mismatch");
  });

  test("aborts the fixed consumer and prevents a post-timeout write", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sm-opaque-timeout-"));
    cleanup.push(cwd);
    const executable = join(cwd, "bin/parent-comment-problem-sync.sh");
    const marker = join(cwd, "post-timeout-write");
    await mkdir(join(cwd, "bin"));
    await writeFile(executable, `#!/bin/sh
cat >/dev/null
sleep 1
printf wrote > ${marker}
`, { mode: 0o755 });
    await chmod(executable, 0o755);
    const bytes = Buffer.from("opaque-timeout-fixture", "utf8");
    const controller = new AbortController();
    const promise = executeOpaqueHandoff({
      cwd: asAbsolutePath(cwd),
      handoff: {
        encodedBytes: bytes.toString("base64"),
        bytesSha256: createHash("sha256").update(bytes).digest("hex"),
        executable: "bin/parent-comment-problem-sync.sh",
        args: ["--input", "-", "--handoff-comm-id", "'<framework comm_id>'"],
      },
      commId: "comm_timeout_1",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toThrow("aborted");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
