import { describe, expect, test, vi, beforeEach } from "vitest";
import { createNewHandler } from "../../../src/app/commands/newSession.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";
import { resetCodexModelCatalogForTests } from "../../../src/ports/CodexModelCatalog.ts";

function msg(text: string) {
  return {
    groupId: asLarkGroupId("oc_root"),
    messageId: "m",
    userId: "u",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

describe("/new handler model validation", () => {
  beforeEach(() => {
    resetCodexModelCatalogForTests([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
  });

  test("rejects unknown codex --model before creating a session", async () => {
    const create = vi.fn(async () => ({ session: { name: "codex-a" } }));
    const handler = createNewHandler({ lifecycle: { create } });

    await expect(
      handler({
        args: { backend: "codex", name: "codex-a", model: "gpt-5.3" },
        scope: "root",
        msg: msg("/new codex codex-a --model gpt-5.3"),
      }),
    ).rejects.toThrow('未知 codex 模型 "gpt-5.3"');
    expect(create).not.toHaveBeenCalled();
  });
});
