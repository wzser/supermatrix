import { describe, expect, test } from "vitest";
import {
  isCodexArrayParamResumeError,
  isThinkingBlockResumeError,
} from "../../src/domain/backendResumeErrors.ts";

describe("isCodexArrayParamResumeError", () => {
  test("matches the poisoned Codex resume history shape", () => {
    expect(isCodexArrayParamResumeError("400 [ArrayParam] [input[115].content] [array_above_max_length]")).toBe(true);
  });

  test("does not match generic Bad Request or a different array error", () => {
    expect(isCodexArrayParamResumeError('{"detail":"Bad Request"}')).toBe(false);
    expect(isCodexArrayParamResumeError("400 [ArrayParam] [input[115].content] [wrong_error]")).toBe(false);
  });
});

describe("isThinkingBlockResumeError", () => {
  test("matches the model-switch 'cannot be modified' 400", () => {
    const err =
      "API Error: 400 messages.35.content.5: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
    expect(isThinkingBlockResumeError(err)).toBe(true);
  });

  test("matches the invalid thinking signature 400", () => {
    expect(isThinkingBlockResumeError("Invalid `signature` in `thinking` block")).toBe(true);
    expect(isThinkingBlockResumeError("Invalid signature in thinking block")).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isThinkingBlockResumeError("API Error: 529 overloaded")).toBe(false);
    expect(isThinkingBlockResumeError('{"detail":"Bad Request"}')).toBe(false);
    expect(isThinkingBlockResumeError("")).toBe(false);
    expect(isThinkingBlockResumeError(undefined)).toBe(false);
  });
});
