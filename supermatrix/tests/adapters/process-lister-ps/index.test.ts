import { describe, expect, test } from "vitest";
import { extractBackendSessionId } from "../../../src/adapters/process-lister-ps/index.ts";

const UUID = "53316059-aaaa-bbbb-cccc-000000000001";

describe("process-lister backend session id extraction", () => {
  test("extracts claude --resume ids", () => {
    expect(
      extractBackendSessionId(`claude -p --output-format stream-json --resume ${UUID} "hello"`),
    ).toBe(UUID);
  });

  test("extracts codex resume ids", () => {
    expect(
      extractBackendSessionId(`codex exec resume ${UUID} --json --dangerously-bypass-approvals-and-sandbox "hello"`),
    ).toBe(UUID);
  });

  test("returns null when the process is not resuming a prior backend session", () => {
    expect(
      extractBackendSessionId(`codex exec --json --dangerously-bypass-approvals-and-sandbox "hello"`),
    ).toBeNull();
  });
});
