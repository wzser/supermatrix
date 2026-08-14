import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLarkCliAutoFileSender } from "../../../src/adapters/lark-cli/autoFileSender.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp("/tmp/sm-autofile-sender-test-");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeFakeCli(stdoutJson: unknown): Promise<{ cli: string; callsPath: string }> {
  const callsPath = join(tmp, "calls.jsonl");
  const cli = join(tmp, "lark-cli");
  await writeFile(
    cli,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(stdoutJson))});`,
      "",
    ].join("\n"),
  );
  await chmod(cli, 0o755);
  return { cli, callsPath };
}

describe("lark-cli auto file sender", () => {
  test("sends from the file directory using a relative basename and selected flag", async () => {
    const { cli, callsPath } = await writeFakeCli({ ok: true, data: { message_id: "om_1" } });
    const file = join(tmp, "photo.png");
    await writeFile(file, "png");
    const sender = createLarkCliAutoFileSender({ larkCliPath: cli });

    await expect(sender({
      groupId: asLarkGroupId("oc_1"),
      absolutePath: file,
      flag: "image",
      idempotencyKey: "codexroot-mr_1-photo",
    })).resolves.toBe(true);

    const call = JSON.parse((await readFile(callsPath, "utf8")).trim()) as {
      cwd: string;
      args: string[];
    };
    expect(call.cwd).toBe(await realpath(tmp));
    expect(call.args).toEqual([
      "im", "+messages-send",
      "--as", "bot",
      "--chat-id", "oc_1",
      "--image", "./photo.png",
      "--idempotency-key", "codexroot-mr_1-photo",
    ]);
    expect(call.args).not.toContain(file);
  });

  test("returns false when lark-cli exits zero but reports ok false", async () => {
    const { cli } = await writeFakeCli({
      ok: false,
      error: { type: "validation", message: "absolute path rejected" },
    });
    const file = join(tmp, "report.md");
    await writeFile(file, "report");
    const sender = createLarkCliAutoFileSender({ larkCliPath: cli });

    await expect(sender({
      groupId: asLarkGroupId("oc_1"),
      absolutePath: file,
      flag: "file",
      idempotencyKey: "codexroot-mr_1-report",
    })).resolves.toBe(false);
  });
});
