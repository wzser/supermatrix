import { describe, it, expect } from "vitest";
import {
  detectAnthropicRateLimit,
  extractRateLimitSnippet,
  RATE_LIMIT_QUIET_WINDOW_MS,
  RATE_LIMIT_SCOPE,
} from "../../src/heal/rateLimit.js";

describe("detectAnthropicRateLimit", () => {
  it("matches Claude Code subscription phrasing in errorMessage", () => {
    expect(
      detectAnthropicRateLimit({
        status: "failed",
        errorMessage: "Claude API error: You've hit your limit · resets 9pm",
      }),
    ).toBe(true);
  });

  it("matches Anthropic rate_limit_error code", () => {
    expect(
      detectAnthropicRateLimit({
        errorMessage:
          "Error from anthropic: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"...\"}}",
      }),
    ).toBe(true);
  });

  it("matches usage_limit_error (weekly quota)", () => {
    expect(
      detectAnthropicRateLimit({ errorMessage: "usage_limit_error: weekly cap reached" }),
    ).toBe(true);
  });

  it("matches plain 'rate limit' phrase", () => {
    expect(
      detectAnthropicRateLimit({ finalMessage: "request hit a rate limit and was dropped" }),
    ).toBe(true);
  });

  it("matches 'rate-limited' verb form", () => {
    expect(
      detectAnthropicRateLimit({ note: "child was rate-limited by upstream" }),
    ).toBe(true);
  });

  it("matches Anthropic 429 phrasing", () => {
    expect(
      detectAnthropicRateLimit({ errorMessage: "anthropic responded with 429 Too Many Requests" }),
    ).toBe(true);
  });

  it("matches inside finalMessage", () => {
    expect(
      detectAnthropicRateLimit({ finalMessage: "You've hit your limit. Try again later." }),
    ).toBe(true);
  });

  it("matches inside stderrTail (shell-style evidence)", () => {
    expect(
      detectAnthropicRateLimit({ stderrTail: "ERROR: rate_limit_error" }),
    ).toBe(true);
  });

  it("does NOT match generic 'limit' or 'rate' alone", () => {
    expect(detectAnthropicRateLimit({ errorMessage: "memory limit exceeded" })).toBe(false);
    expect(detectAnthropicRateLimit({ errorMessage: "currency exchange rate fluctuated" })).toBe(false);
  });

  it("does NOT match 'incorporate' / 'corporate' substrings (bounded word)", () => {
    expect(detectAnthropicRateLimit({ errorMessage: "failed to incorporate the patch" })).toBe(false);
  });

  it("returns false for null / non-object / missing-fields evidence", () => {
    expect(detectAnthropicRateLimit(null)).toBe(false);
    expect(detectAnthropicRateLimit(undefined)).toBe(false);
    expect(detectAnthropicRateLimit("rate limit")).toBe(false);
    expect(detectAnthropicRateLimit({})).toBe(false);
    expect(detectAnthropicRateLimit({ unrelated: "x" })).toBe(false);
  });
});

describe("extractRateLimitSnippet", () => {
  it("returns the matching field's text, capped at 200 chars", () => {
    const long = "You've hit your limit. ".repeat(20);
    const out = extractRateLimitSnippet({ errorMessage: long });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(200);
    expect(out!.startsWith("You've hit your limit")).toBe(true);
  });

  it("returns null on non-match", () => {
    expect(extractRateLimitSnippet({ errorMessage: "disk full" })).toBeNull();
  });
});

describe("constants", () => {
  it("RATE_LIMIT_QUIET_WINDOW_MS is 60 minutes", () => {
    expect(RATE_LIMIT_QUIET_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("RATE_LIMIT_SCOPE is 'anthropic'", () => {
    expect(RATE_LIMIT_SCOPE).toBe("anthropic");
  });
});
