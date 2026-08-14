import { describe, expect, test } from "vitest";
import { logClosureEvent } from "../../../src/app/spawnClosure/closureLog.ts";
import type { Logger } from "../../../src/ports/Logger.ts";

function captureLogger() {
  const rows: Array<{ level: "info" | "warn"; message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    info(message, fields) {
      rows.push(fields === undefined ? { level: "info", message } : { level: "info", message, fields });
    },
    warn(message, fields) {
      rows.push(fields === undefined ? { level: "warn", message } : { level: "warn", message, fields });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, rows };
}

describe("closureLog", () => {
  test("writes closure events with a comm_id field", () => {
    const { logger, rows } = captureLogger();

    logClosureEvent(logger, {
      event: "phase_check",
      commId: "comm_log_test",
      targetSession: "target",
      callerSession: "caller",
      mode: "sync_inline",
      attempt: "retry",
      phase: "execution",
      passed: false,
      reason: "child final message is empty",
      failureKind: "empty_output",
      deliveryAddressKinds: ["chat_post"],
    });

    expect(rows).toEqual([
      {
        level: "warn",
        message: "spawn closure",
        fields: {
          closure_event: "phase_check",
          comm_id: "comm_log_test",
          target_session: "target",
          caller_session: "caller",
          mode: "sync_inline",
          attempt: "retry",
          phase: "execution",
          passed: false,
          reason: "child final message is empty",
          failure_kind: "empty_output",
          delivery_address_kinds: ["chat_post"],
        },
      },
    ]);
  });

  test("writes state transitions with ref and comm_id", () => {
    const { logger, rows } = captureLogger();

    logClosureEvent(logger, {
      event: "state_transition",
      commId: "comm_state_test",
      targetSession: "target",
      callerSession: "caller",
      ref: "async_comm_state_test",
      fromStatus: "pending",
      toStatus: "waiting_child",
      reason: "caller stopped waiting",
    });

    expect(rows[0]).toMatchObject({
      level: "info",
      fields: {
        closure_event: "state_transition",
        comm_id: "comm_state_test",
        ref: "async_comm_state_test",
        from_status: "pending",
        to_status: "waiting_child",
        reason: "caller stopped waiting",
      },
    });
  });

  test("keeps comm_id present on admission rejections before a child exists", () => {
    const { logger, rows } = captureLogger();

    logClosureEvent(logger, {
      event: "admission_validation",
      commId: null,
      targetSession: "target",
      callerSession: "caller",
      mode: "sync_inline",
      result: "rejected",
      reason: "invalid delivery address",
    });

    expect(rows[0]).toMatchObject({
      level: "warn",
      fields: {
        closure_event: "admission_validation",
        comm_id: null,
        result: "rejected",
      },
    });
  });
});
