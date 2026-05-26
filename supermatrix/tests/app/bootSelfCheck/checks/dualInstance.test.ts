import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dualInstanceCheck } from "../../../../src/app/bootSelfCheck/checks/dualInstance.ts";
import {
  createFakeProcessLister,
  type FakeProcessListerOpts,
} from "../../../fakes/fakeProcessLister.ts";
import type { BootCheckContext } from "../../../../src/app/bootSelfCheck/types.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "sm-dual-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctxWith(listerOpts: FakeProcessListerOpts = {}): BootCheckContext {
  return {
    cfg: { dbPath: path.join(tmp, "sm.db") } as BootCheckContext["cfg"],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}) as never,
    } as never,
    processLister: createFakeProcessLister(listerOpts),
  };
}

describe("dual-instance check", () => {
  it("writes PID file and returns ok when no prior instance", async () => {
    const ctx = ctxWith({ processes: [] });
    const result = await dualInstanceCheck.run(ctx, "execute");
    expect(result.status).toBe("ok");
    const pidFile = path.join(tmp, ".bootstrap.pid");
    expect(existsSync(pidFile)).toBe(true);
    expect(Number(readFileSync(pidFile, "utf-8"))).toBe(process.pid);
  });

  it("overwrites stale PID file when pid is dead", async () => {
    writeFileSync(path.join(tmp, ".bootstrap.pid"), "999999", "utf-8"); // very unlikely to exist
    // getCommand returns null for dead pid
    const ctx = ctxWith({ commandByPid: {} });
    const result = await dualInstanceCheck.run(ctx, "execute");
    expect(result.status).toBe("ok");
  });

  it("overwrites PID file with garbage content", async () => {
    writeFileSync(path.join(tmp, ".bootstrap.pid"), "not-a-pid", "utf-8");
    const ctx = ctxWith({ processes: [] });
    const result = await dualInstanceCheck.run(ctx, "execute");
    expect(result.status).toBe("ok");
    // And verify the file now contains our PID
    expect(
      Number(readFileSync(path.join(tmp, ".bootstrap.pid"), "utf-8")),
    ).toBe(process.pid);
  });

  it("fails when a live matching instance is in the PID file", async () => {
    writeFileSync(path.join(tmp, ".bootstrap.pid"), "4242", "utf-8");
    const ctx = ctxWith({
      commandByPid: { 4242: "tsx /repo/src/cli/main.ts" },
    });
    const result = await dualInstanceCheck.run(ctx, "execute");
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.message).toMatch(/4242/);
    }
  });

  it("fails via ps fallback scan even if PID file is absent", async () => {
    const ctx = ctxWith({
      processes: [
        {
          pid: 8080,
          ppid: 1,
          cmd: "tsx /repo/src/cli/main.ts",
          cwd: "/repo",
          backendSessionId: null,
        },
      ],
    });
    const result = await dualInstanceCheck.run(ctx, "execute");
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.message).toMatch(/8080/);
    }
  });

  it("filters out both process.pid and process.ppid so tsx wrapper is not self-detected", async () => {
    // tsx runs main.ts via a child node process. Both the wrapper (parent)
    // and the child (us) match the MAIN_CMD_PATTERN and appear in `ps`.
    // The check must exclude both, otherwise every boot under tsx would
    // fail dual-instance by self-detection.
    const ctx = ctxWith({
      processes: [
        {
          pid: process.pid,
          ppid: process.ppid,
          cmd: "tsx /repo/src/cli/main.ts",
          cwd: "/repo",
          backendSessionId: null,
        },
        {
          pid: process.ppid,
          ppid: 1,
          cmd: "tsx /repo/src/cli/main.ts",
          cwd: "/repo",
          backendSessionId: null,
        },
      ],
    });
    const result = await dualInstanceCheck.run(ctx, "execute");
    expect(result.status).toBe("ok");
  });
});
