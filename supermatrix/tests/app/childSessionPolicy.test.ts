import { afterEach, describe, expect, test } from "vitest";
import { policyForType, policyForTypeOrDefault } from "../../src/app/childSessionPolicy.ts";

describe("child session policy table", () => {
  test("one_shot_delegation keeps pre-refactor defaults", () => {
    const p = policyForType("one_shot_delegation");
    expect(p.maxBusyChildrenPerParent).toBe(5);
    expect(p.maxIdleChildrenPerParent).toBe(0);
    expect(p.maxDepth).toBe(3);
    expect(p.maxRuntimeSec).toBe(30 * 60);
    expect(p.staleIdleTtlSec).toBe(60 * 60);
  });

  test("ephemeral_conversation keeps pre-refactor defaults (tightening deferred)", () => {
    // decisions.md D8 called for maxBusy=2 / maxIdle=10 / maxDepth=1 / shorter
    // TTLs, but step 4 preserves current behavior to avoid silent regressions.
    const p = policyForType("ephemeral_conversation");
    expect(p.maxBusyChildrenPerParent).toBe(5);
    expect(p.maxDepth).toBe(3);
  });

  test("event_awaited_worker gets an hour-long runtime cap", () => {
    const p = policyForType("event_awaited_worker");
    expect(p.maxRuntimeSec).toBe(60 * 60);
  });

  test("policyForTypeOrDefault falls back when type is null", () => {
    const p = policyForTypeOrDefault(null);
    expect(p.maxBusyChildrenPerParent).toBe(5);
    expect(p.maxDepth).toBe(3);
  });
});

describe("SM_CHILD_MAX_RUNTIME_SEC env override (D8)", () => {
  const prev = process.env.SM_CHILD_MAX_RUNTIME_SEC;

  afterEach(() => {
    if (prev === undefined) delete process.env.SM_CHILD_MAX_RUNTIME_SEC;
    else process.env.SM_CHILD_MAX_RUNTIME_SEC = prev;
  });

  test("overrides DEFAULT_POLICY.maxRuntimeSec for types that inherit it", () => {
    process.env.SM_CHILD_MAX_RUNTIME_SEC = String(45 * 60);
    expect(policyForType("one_shot_delegation").maxRuntimeSec).toBe(45 * 60);
    expect(policyForType("ephemeral_conversation").maxRuntimeSec).toBe(45 * 60);
    expect(policyForTypeOrDefault(null).maxRuntimeSec).toBe(45 * 60);
  });

  test("does not affect types with their own explicit maxRuntimeSec", () => {
    process.env.SM_CHILD_MAX_RUNTIME_SEC = String(45 * 60);
    expect(policyForType("event_awaited_worker").maxRuntimeSec).toBe(60 * 60);
    expect(policyForType("user_voice_reporter").maxRuntimeSec).toBe(10 * 60);
    expect(policyForType("event_publisher").maxRuntimeSec).toBe(10 * 60);
  });

  test("ignores invalid / non-positive values", () => {
    process.env.SM_CHILD_MAX_RUNTIME_SEC = "not-a-number";
    expect(policyForType("one_shot_delegation").maxRuntimeSec).toBe(30 * 60);
    process.env.SM_CHILD_MAX_RUNTIME_SEC = "0";
    expect(policyForType("one_shot_delegation").maxRuntimeSec).toBe(30 * 60);
    process.env.SM_CHILD_MAX_RUNTIME_SEC = "-30";
    expect(policyForType("one_shot_delegation").maxRuntimeSec).toBe(30 * 60);
  });
});
