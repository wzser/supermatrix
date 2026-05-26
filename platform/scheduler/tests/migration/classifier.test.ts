import { describe, it, expect } from "vitest";
import { inferSuggestedClass, DEFAULT_DURATION_MS } from "../../src/migration/classifier.js";

describe("inferSuggestedClass", () => {
  it("shell tasks default to sync_job with 30min duration", () => {
    const r = inferSuggestedClass({ executor: "shell", config: { command: "echo", cwd: "/tmp", timeout: 1000 } });
    expect(r.suggestedClass).toBe("sync_job");
    expect(r.suggestedExpectedDurationMs).toBe(DEFAULT_DURATION_MS.sync_job);
  });

  it("http tasks default to delegation with 30min duration", () => {
    const r = inferSuggestedClass({ executor: "http", config: { url: "http://x", method: "POST", body: { target: "somebody", prompt: "go" }, timeout: 30000 } });
    expect(r.suggestedClass).toBe("delegation");
    expect(r.suggestedExpectedDurationMs).toBe(DEFAULT_DURATION_MS.delegation);
  });
});
