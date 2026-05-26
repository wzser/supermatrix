import { describe, expect, test } from "vitest";
import { buildCommandRegistry } from "../../src/app/commandRegistry.ts";

describe("commandRegistry", () => {
  test("contains all MVP commands", () => {
    const r = buildCommandRegistry();
    for (const name of [
      "new", "delete", "list", "cancel", "reset", "restart", "status", "help", "reload",
    ]) {
      expect(r[name]).toBeDefined();
    }
  });

  test("scopes are correct", () => {
    const r = buildCommandRegistry();
    expect(r.new.command.scope).toEqual(["root"]);
    expect(r.reset.command.scope).toEqual(["root", "user"]);
    expect(r.restart.command.scope).toEqual(["root", "user"]);
    expect(r.reload.command.scope).toEqual(["root"]);
  });

  test("descriptions are Chinese", () => {
    const r = buildCommandRegistry();
    for (const entry of Object.values(r)) {
      expect(entry.command.description).toMatch(/[\u4e00-\u9fa5]/u);
    }
  });
});
