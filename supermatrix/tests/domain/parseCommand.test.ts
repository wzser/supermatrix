import { describe, expect, test } from "vitest";
import type { Command } from "../../src/domain/command.ts";
import { parseCommand } from "../../src/domain/parseCommand.ts";

const NEW_CMD: Command = {
  name: "new",
  description: "新建 session",
  scope: ["root"],
  params: [
    { name: "backend", type: "enum", required: true, kind: "positional", enum: ["claude", "codex"] },
    { name: "name", type: "string", required: true, kind: "positional" },
    { name: "model", type: "string", required: false, kind: "named" },
    { name: "workdir", type: "string", required: false, kind: "named" },
    { name: "purpose", type: "string", required: false, kind: "rest" },
  ],
};

const RESET_CMD: Command = {
  name: "reset",
  description: "清空上下文",
  scope: ["root", "user"],
  params: [{ name: "name", type: "string", required: false, kind: "positional", scope: ["root"] }],
};

const HELP_CMD: Command = {
  name: "help",
  description: "显示帮助",
  scope: ["root", "user"],
  params: [],
};

const REGISTRY = { new: NEW_CMD, reset: RESET_CMD, help: HELP_CMD };

describe("parseCommand", () => {
  test("parses /new claude foo 处理 图像 任务", () => {
    const result = parseCommand("/new claude foo 处理 图像 任务", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", purpose: "处理 图像 任务" },
    });
  });

  test("parses /help with no args", () => {
    const result = parseCommand("/help", REGISTRY);
    expect(result).toEqual({ kind: "ok", name: "help", args: {} });
  });

  test("parses /reset with optional name in root scope", () => {
    expect(parseCommand("/reset", REGISTRY, "root")).toEqual({ kind: "ok", name: "reset", args: {} });
    expect(parseCommand("/reset foo", REGISTRY, "root")).toEqual({
      kind: "ok",
      name: "reset",
      args: { name: "foo" },
    });
  });

  test("/reset rejects name param in user scope", () => {
    expect(parseCommand("/reset", REGISTRY, "user")).toEqual({ kind: "ok", name: "reset", args: {} });
    const result = parseCommand("/reset foo", REGISTRY, "user");
    expect(result.kind).toBe("error");
  });

  test("/reset with no scope accepts name (backward compat)", () => {
    expect(parseCommand("/reset foo", REGISTRY)).toEqual({
      kind: "ok",
      name: "reset",
      args: { name: "foo" },
    });
  });

  test("missing required param returns error", () => {
    const result = parseCommand("/new claude", REGISTRY);
    expect(result.kind).toBe("error");
  });

  test("enum violation returns error", () => {
    const result = parseCommand("/new gpt4 foo", REGISTRY);
    expect(result.kind).toBe("error");
  });

  test("unknown command returns error with name", () => {
    const result = parseCommand("/nope", REGISTRY);
    expect(result).toEqual({ kind: "error", message: "未知命令：nope" });
  });

  test("non-slash input returns error", () => {
    const result = parseCommand("hello", REGISTRY);
    expect(result.kind).toBe("error");
  });

  test("collapses consecutive spaces in rest param source", () => {
    const result = parseCommand("/new claude foo a  b", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", purpose: "a b" },
    });
  });

  test("parses --model named arg before rest", () => {
    const result = parseCommand("/new claude foo --model sonnet-4-6 做前端", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", model: "sonnet-4-6", purpose: "做前端" },
    });
  });

  test("parses --workdir named arg", () => {
    const result = parseCommand("/new codex reviewer --workdir /ws/scheduler", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "codex", name: "reviewer", workdir: "/ws/scheduler" },
    });
  });

  test("parses multiple named args together", () => {
    const result = parseCommand("/new claude foo --model sonnet --workdir /ws/bar purpose text", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", model: "sonnet", workdir: "/ws/bar", purpose: "purpose text" },
    });
  });

  test("named arg without value returns error", () => {
    const result = parseCommand("/new claude foo --model", REGISTRY);
    expect(result.kind).toBe("error");
  });

  test("named arg followed by another known --flag is treated as missing value", () => {
    const result = parseCommand("/new claude foo --model --workdir /ws/bar", REGISTRY);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("--model");
    }
  });

  test("accepts full-width slash prefix from Chinese IME", () => {
    expect(parseCommand("／help", REGISTRY)).toEqual({ kind: "ok", name: "help", args: {} });
  });

  test("accepts full-width command body from Chinese IME", () => {
    const result = parseCommand("／ｈｅｌｐ", REGISTRY);
    expect(result).toEqual({ kind: "ok", name: "help", args: {} });
  });

  test("accepts full-width args mixed with ASCII", () => {
    const result = parseCommand("／new claude ｆｏｏ", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo" },
    });
  });

  test("registry lookup is case-insensitive (IME auto-capitalize)", () => {
    expect(parseCommand("/Help", REGISTRY)).toEqual({ kind: "ok", name: "help", args: {} });
    expect(parseCommand("/HELP", REGISTRY)).toEqual({ kind: "ok", name: "help", args: {} });
  });

  test("named arg accepts double-quoted value containing spaces", () => {
    const result = parseCommand('/new claude foo --workdir "value with spaces"', REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", workdir: "value with spaces" },
    });
  });

  test("named arg accepts single-quoted value containing spaces", () => {
    const result = parseCommand("/new claude foo --workdir 'value with spaces'", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", workdir: "value with spaces" },
    });
  });

  test("quoted value preserves spaces with CJK content (NFKC folds full-width punctuation)", () => {
    // NFKC normalisation runs over the whole input (see parseCommand.ts comment on the
    // command path). Full-width parens/colon fold to half-width; CJK ideographs and
    // 、 are preserved verbatim. The point of this test is that the spaces survive.
    const result = parseCommand(
      '/new claude foo --workdir "watchdog-daily-commit（每日提交：A、B 等 1 个 repo）"',
      REGISTRY,
    );
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: {
        backend: "claude",
        name: "foo",
        workdir: "watchdog-daily-commit(每日提交:A、B 等 1 个 repo)",
      },
    });
  });

  test("unclosed double quote returns explicit error", () => {
    const result = parseCommand('/new claude foo --workdir "missing close', REGISTRY);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("引号");
    }
  });

  test("unclosed single quote returns explicit error", () => {
    const result = parseCommand("/new claude foo --workdir 'missing close", REGISTRY);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("引号");
    }
  });

  test("quoted empty value is allowed", () => {
    const result = parseCommand('/new claude foo --workdir ""', REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", workdir: "" },
    });
  });

  test("quotes do not interfere with unquoted single-token regression", () => {
    const result = parseCommand("/new claude foo --workdir /ws/bar", REGISTRY);
    expect(result).toEqual({
      kind: "ok",
      name: "new",
      args: { backend: "claude", name: "foo", workdir: "/ws/bar" },
    });
  });
});
