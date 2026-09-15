import { afterEach, describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST,
  buildShipmentTypeV2InitialApplyEnv,
  executeShipmentTypeV2InitialApply,
  parseShipmentTypeV2InitialApplyRequest,
  type FixedChildSpawnOptions,
} from "../../scripts/lib/shipmentTypeV2InitialApplyRunner.mjs";

const TARGET_SCRIPT = "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/huojianwang2hao/rules/shipment-type-v2/runtime/shipment-judge.mjs";
const approvedReportRef = `shipment-type-v2-approved:${"a".repeat(64)}`;
const validRequest = {
  command_id: "shipment_type_v2.initial_apply.v1",
  idempotency_key: "shipment_type_v2.initial_apply.v1:first-backfill-20260805",
  approved_report_ref: approvedReportRef,
} as const;

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function childThatExits(exitCode: number): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("close", exitCode));
  return child;
}

async function testPaths() {
  const root = await mkdtemp(join(tmpdir(), "sm-shipment-initial-apply-"));
  temporaryPaths.push(root);
  return {
    ledgerPath: join(root, "runs.sqlite"),
    reportDir: join(root, "reports"),
  };
}

describe("shipment_type_v2.initial_apply.v1 narrow runner", () => {
  test("rejects arbitrary command, owner, alias, argv, and env fields", () => {
    for (const invalid of [
      { ...validRequest, command_id: "anything.else" },
      { ...validRequest, owner: "somebody-else" },
      { ...validRequest, secret_alias: "anything-else" },
      { ...validRequest, argv: ["sh", "-c", "anything"] },
      { ...validRequest, env: { SM_SESSION_NAME: "attacker" } },
    ]) {
      expect(() => parseShipmentTypeV2InitialApplyRequest(invalid)).toThrow("invalid narrow command request");
    }
  });

  test("does not trust an internal caller that bypasses the request parser", async () => {
    const paths = await testPaths();
    let spawnCount = 0;

    await expect(executeShipmentTypeV2InitialApply(
      { ...validRequest, command_id: "anything.else" } as never,
      {
        ...paths,
        sourceEnv: { SHIPMENT_JUDGE_BASE_TOKEN: "test-only-secret" },
        spawnChild() {
          spawnCount += 1;
          return childThatExits(0);
        },
      },
    )).rejects.toThrow("invalid narrow command request");

    expect(spawnCount).toBe(0);
  });

  test("uses the frozen manifest and ignores caller-controlled environment", () => {
    expect(SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST).toMatchObject({
      commandId: "shipment_type_v2.initial_apply.v1",
      ownerSession: "huojianwang2hao",
      secretAlias: "replenishment_execution",
      secretEnv: "SHIPMENT_JUDGE_BASE_TOKEN",
      argv: ["node", TARGET_SCRIPT, "--mode", "apply", "--all"],
    });

    const childEnv = buildShipmentTypeV2InitialApplyEnv({
      PATH: "/attacker/bin",
      HOME: "/attacker/home",
      SM_SESSION_NAME: "attacker",
      SHIPMENT_JUDGE_BASE_TOKEN: "test-only-secret",
      AUTOBITABLE_BASE_TOKENS_BY_ALIAS: "must-not-reach-child",
      ARBITRARY_CALLER_ENV: "must-not-reach-child",
    });

    expect(childEnv).toEqual({
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/LOCAL_USER",
      SM_RUNTIME_ROOT: "/Users/LOCAL_USER/SuperMatrixRuntime",
      SM_SESSION_NAME: "huojianwang2hao",
      SHIPMENT_JUDGE_BASE_TOKEN: "test-only-secret",
    });
  });

  test("executes only the fixed argv and returns a sanitized receipt", async () => {
    const paths = await testPaths();
    const calls: Array<{ file: string; argv: string[]; options: FixedChildSpawnOptions }> = [];

    const receipt = await executeShipmentTypeV2InitialApply(
      parseShipmentTypeV2InitialApplyRequest(validRequest),
      {
        ...paths,
        sourceEnv: { PATH: "/attacker/bin", HOME: "/attacker/home", SHIPMENT_JUDGE_BASE_TOKEN: "test-only-secret" },
        createRunId: () => "run-initial-apply-1",
        spawnChild(file, argv, options) {
          calls.push({ file, argv, options });
          return childThatExits(0);
        },
      },
    );

    expect(calls).toEqual([{
      file: "node",
      argv: [TARGET_SCRIPT, "--mode", "apply", "--all"],
      options: {
        cwd: "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/huojianwang2hao",
        env: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          HOME: "/Users/LOCAL_USER",
          SM_RUNTIME_ROOT: "/Users/LOCAL_USER/SuperMatrixRuntime",
          SM_SESSION_NAME: "huojianwang2hao",
          SHIPMENT_JUDGE_BASE_TOKEN: "test-only-secret",
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    }]);
    expect(receipt).toEqual({
      run_id: "run-initial-apply-1",
      status: "succeeded",
      report_path: expect.any(String),
      report_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      error_phase: null,
    });
    expect(JSON.stringify(receipt)).not.toContain("test-only-secret");
    const report = await readFile(receipt.report_path!, "utf8");
    expect(report).not.toContain("test-only-secret");
    expect(report).not.toContain("must-not-reach-child");
  });

  test("returns the original receipt without re-running a duplicate idempotency key", async () => {
    const paths = await testPaths();
    let spawnCount = 0;
    const deps = {
      ...paths,
      sourceEnv: { PATH: "/test/bin", SHIPMENT_JUDGE_BASE_TOKEN: "test-only-secret" },
      createRunId: () => "run-initial-apply-duplicate",
      spawnChild() {
        spawnCount += 1;
        return childThatExits(0);
      },
    };

    const first = await executeShipmentTypeV2InitialApply(parseShipmentTypeV2InitialApplyRequest(validRequest), deps);
    const duplicate = await executeShipmentTypeV2InitialApply(parseShipmentTypeV2InitialApplyRequest(validRequest), deps);

    expect(spawnCount).toBe(1);
    expect(duplicate).toEqual(first);
  });

  test("fails closed when the controlled alias injection is absent", async () => {
    const paths = await testPaths();
    let spawnCount = 0;

    const receipt = await executeShipmentTypeV2InitialApply(
      parseShipmentTypeV2InitialApplyRequest(validRequest),
      {
        ...paths,
        sourceEnv: { PATH: "/test/bin" },
        createRunId: () => "run-initial-apply-missing-secret",
        spawnChild() {
          spawnCount += 1;
          return childThatExits(0);
        },
      },
    );

    expect(spawnCount).toBe(0);
    expect(receipt).toEqual({
      run_id: "run-initial-apply-missing-secret",
      status: "failed",
      report_path: expect.any(String),
      report_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      error_phase: "secret_alias_unavailable",
    });
  });

  test("reports a fixed child-exit phase without exposing child output", async () => {
    const paths = await testPaths();

    const receipt = await executeShipmentTypeV2InitialApply(
      parseShipmentTypeV2InitialApplyRequest(validRequest),
      {
        ...paths,
        sourceEnv: { SHIPMENT_JUDGE_BASE_TOKEN: "test-only-secret" },
        createRunId: () => "run-initial-apply-child-failure",
        spawnChild() {
          return childThatExits(17);
        },
      },
    );

    expect(receipt).toEqual({
      run_id: "run-initial-apply-child-failure",
      status: "failed",
      report_path: expect.any(String),
      report_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      error_phase: "child_exit",
    });
    expect(await readFile(receipt.report_path!, "utf8")).not.toContain("test-only-secret");
  });
});
