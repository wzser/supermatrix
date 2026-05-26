import { describe, it, expect } from "vitest";
import { resolveMigrationOwner } from "../../src/migration/ownerResolve.js";
import type { Task } from "../../src/db/taskStore.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "t1", name: "x", description: "", cron: "0 * * * *",
    executor: "shell", config: {}, enabled: true, oneshot: false,
    notifyOnFailure: false, nextRunAt: null, lastSuccessAt: null,
    createdBy: "", createdAt: 0, updatedAt: 0, class: null,
    expectedDurationMs: null, overlapPolicy: null, ownerSession: null,
    overrides: null, migrationEscalationStage: 0, ...overrides,
  };
}

describe("resolveMigrationOwner", () => {
  it("prefers ownerSession when set", () => {
    expect(resolveMigrationOwner(makeTask({ ownerSession: "amz-sql", createdBy: "someone-else" })))
      .toBe("amz-sql");
  });

  it("falls back to createdBy when ownerSession is null", () => {
    expect(resolveMigrationOwner(makeTask({ ownerSession: null, createdBy: "amzdata" })))
      .toBe("amzdata");
  });

  it("falls back to createdBy when ownerSession is empty string", () => {
    expect(resolveMigrationOwner(makeTask({ ownerSession: "", createdBy: "amzdata" })))
      .toBe("amzdata");
  });

  it("returns null when both are null", () => {
    expect(resolveMigrationOwner(makeTask({ ownerSession: null, createdBy: "" })))
      .toBeNull();
  });

  it("treats the string '未知' as no-owner (matches Bitable fallback)", () => {
    expect(resolveMigrationOwner(makeTask({ ownerSession: null, createdBy: "未知" })))
      .toBeNull();
  });
});
