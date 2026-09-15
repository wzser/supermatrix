import { describe, expect, test } from "vitest";
import {
  isCodexModelAtCapacity,
  isConfirmedCodexModelUnavailable,
} from "../../../src/adapters/backend-codex/modelUnavailable.ts";

const CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

describe("isConfirmedCodexModelUnavailable", () => {
  test("recognizes the exact account-entitlement response", () => {
    expect(isConfirmedCodexModelUnavailable(
      "The model `gpt-5.5` does not exist or you do not have access to it",
    )).toBe(true);
  });

  test("recognizes a structured model entitlement error", () => {
    expect(isConfirmedCodexModelUnavailable({
      error: { code: "model_not_found", type: "invalid_request_error", status: 404 },
    })).toBe(true);
  });

  test.each([
    { status: 429, error: { message: "rate limited" } },
    new Error("request timed out"),
    new Error("cancelled by user"),
    { error: { code: "stale_rollout", message: "resume session is stale" } },
    { error: { code: "authentication_error", message: "authentication expired" } },
    new Error("getaddrinfo ENOTFOUND api.openai.com"),
    { status: 400, error: { message: "Unsupported reasoning effort 'ultra'" } },
    { status: 500, error: { message: "unknown server error" } },
  ])("rejects non-entitlement failure %#", (failure) => {
    expect(isConfirmedCodexModelUnavailable(failure)).toBe(false);
  });
});

describe("isCodexModelAtCapacity", () => {
  test("recognizes the exact provider capacity message (string)", () => {
    expect(isCodexModelAtCapacity(CAPACITY_MESSAGE)).toBe(true);
  });

  test("recognizes the capacity message with trailing whitespace", () => {
    expect(isCodexModelAtCapacity(`  ${CAPACITY_MESSAGE}  `)).toBe(true);
  });

  test("recognizes a structured error carrying the capacity message", () => {
    expect(isCodexModelAtCapacity({ error: { message: CAPACITY_MESSAGE } })).toBe(true);
    expect(isCodexModelAtCapacity(new Error(CAPACITY_MESSAGE))).toBe(true);
  });

  test.each([
    "The model `gpt-5.6-terra` does not exist or you do not have access to it",
    "429 Too Many Requests: rate limited",
    "Selected model is at capacity.",
    "Model is at capacity. Please try a different model.",
    "at capacity",
    "[TIMEOUT] inactivity: no output for 900s",
    "cancelled by user",
    { error: { code: "model_not_found", status: 404 } },
  ])("rejects non-capacity failure %#", (failure) => {
    expect(isCodexModelAtCapacity(failure)).toBe(false);
  });

  test("the entitlement error is not a capacity error and vice versa", () => {
    const entitlement = "The model `gpt-5.5` does not exist or you do not have access to it";
    expect(isConfirmedCodexModelUnavailable(entitlement)).toBe(true);
    expect(isCodexModelAtCapacity(entitlement)).toBe(false);
    expect(isCodexModelAtCapacity(CAPACITY_MESSAGE)).toBe(true);
    expect(isConfirmedCodexModelUnavailable(CAPACITY_MESSAGE)).toBe(false);
  });
});
