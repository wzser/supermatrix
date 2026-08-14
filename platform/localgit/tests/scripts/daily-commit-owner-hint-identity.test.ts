import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

describe("daily-commit owner hint identity", () => {
  it("sends owner hints as bot notifications instead of user input", () => {
    const source = readFileSync(join(ROOT, "src/scripts/daily-commit.ts"), "utf-8");
    const sendLarkMessageBlock = source.match(
      /function sendLarkMessage[\s\S]+?\n}/,
    )?.[0];
    const ownerHintBlock = source.match(
      /const msg = `\[daily-commit hint[\s\S]+?appendDispatchLog\(\{/,
    )?.[0];

    expect(sendLarkMessageBlock).toContain('as: "bot" | "user" = "bot"');
    expect(sendLarkMessageBlock).toContain('"--as", as');
    expect(ownerHintBlock).toBeTruthy();
    expect(ownerHintBlock).toContain("请回「默认」或「选 X + 一句理由」");
    expect(ownerHintBlock).not.toContain('sendLarkMessage(groupId, msg, "user")');
    expect(ownerHintBlock).toContain("sendLarkMessage(groupId, msg)");
  });
});
