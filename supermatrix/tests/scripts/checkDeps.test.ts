import { describe, expect, test } from "vitest";
import { classifyImport, isViolation } from "../../scripts/check-deps.ts";

describe("check-deps", () => {
  test("domain importing from ports is a violation", () => {
    const from = classifyImport("src/domain/session.ts");
    const to = classifyImport("src/ports/BindingStore.ts");
    expect(isViolation(from, to)).toBe(true);
  });

  test("adapters importing from ports is allowed", () => {
    const from = classifyImport("src/adapters/store-sqlite/index.ts");
    const to = classifyImport("src/ports/BindingStore.ts");
    expect(isViolation(from, to)).toBe(false);
  });

  test("app importing from adapters is a violation", () => {
    const from = classifyImport("src/app/dispatcher.ts");
    const to = classifyImport("src/adapters/backend-claude/index.ts");
    expect(isViolation(from, to)).toBe(true);
  });

  test("cli importing from app is allowed", () => {
    const from = classifyImport("src/cli/main.ts");
    const to = classifyImport("src/app/bootstrap.ts");
    expect(isViolation(from, to)).toBe(false);
  });

  test("ports importing from domain is allowed", () => {
    const from = classifyImport("src/ports/AgentBackend.ts");
    const to = classifyImport("src/domain/session.ts");
    expect(isViolation(from, to)).toBe(false);
  });

  test("domain importing from another domain file is allowed", () => {
    const from = classifyImport("src/domain/session.ts");
    const to = classifyImport("src/domain/ids.ts");
    expect(isViolation(from, to)).toBe(false);
  });
});
