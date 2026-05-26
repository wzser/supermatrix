import { describe, expect, test } from "vitest";
import {
  extractStaWritebackCommandText,
  parseStaWritebackTaskId,
} from "../../src/domain/staWritebackCommand.ts";

describe("sta writeback command parsing", () => {
  test("parses quoted and bare slash commands", () => {
    expect(parseStaWritebackTaskId('/sta-writeback task_id="698debdc"')).toBe("698debdc");
    expect(parseStaWritebackTaskId("/sta-writeback task_id=698debdc")).toBe("698debdc");
  });

  test("extracts a command from card-rendered content", () => {
    expect(extractStaWritebackCommandText([
      "<card>",
      "/sta-writeback task_id=698debdc",
      "---",
      "</card>",
    ].join("\n"))).toBe("/sta-writeback task_id=698debdc");
  });

  test("canonicalizes the Chinese trigger so the slash command router can run it", () => {
    expect(extractStaWritebackCommandText('货件写回 task_id="698debdc"')).toBe(
      '/sta-writeback task_id="698debdc"',
    );
  });
});
