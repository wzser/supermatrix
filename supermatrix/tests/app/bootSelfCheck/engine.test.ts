import { describe, expect, it, vi } from "vitest";
import { runChecks } from "../../../src/app/bootSelfCheck/index.ts";
import type {
  BootCheck,
  BootCheckContext,
} from "../../../src/app/bootSelfCheck/types.ts";

function fakeCtx(): BootCheckContext {
  return {
    cfg: { larkCliPath: "/nope" } as BootCheckContext["cfg"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({} as never) } as never,
    processLister: { list: vi.fn(), killAll: vi.fn() } as never,
  };
}

describe("runChecks engine", () => {
  it("returns [] when registry is empty", async () => {
    const result = await runChecks("pre-wiring", "execute", fakeCtx(), []);
    expect(result).toEqual([]);
  });

  it("filters checks by phase", async () => {
    const preCheck: BootCheck = {
      name: "pre-only",
      phases: ["pre-wiring"],
      run: async () => ({ name: "pre-only", status: "ok" }),
    };
    const postCheck: BootCheck = {
      name: "post-only",
      phases: ["post-wiring"],
      run: async () => ({ name: "post-only", status: "ok" }),
    };
    const results = await runChecks("pre-wiring", "execute", fakeCtx(), [preCheck, postCheck]);
    expect(results.map((r) => r.name)).toEqual(["pre-only"]);
  });

  it("passes mode through to each check", async () => {
    const captured: string[] = [];
    const check: BootCheck = {
      name: "mode-capture",
      phases: ["runtime"],
      run: async (_ctx, mode) => {
        captured.push(mode);
        return { name: "mode-capture", status: "ok" };
      },
    };
    await runChecks("runtime", "observe", fakeCtx(), [check]);
    expect(captured).toEqual(["observe"]);
  });

  it("short-circuits on fail: subsequent checks in same phase do not run", async () => {
    const ran: string[] = [];
    const failing: BootCheck = {
      name: "failing",
      phases: ["pre-wiring"],
      run: async () => {
        ran.push("failing");
        return { name: "failing", status: "fail", message: "nope" };
      },
    };
    const shouldNotRun: BootCheck = {
      name: "later",
      phases: ["pre-wiring"],
      run: async () => {
        ran.push("later");
        return { name: "later", status: "ok" };
      },
    };
    const results = await runChecks("pre-wiring", "execute", fakeCtx(), [failing, shouldNotRun]);
    expect(ran).toEqual(["failing"]);
    expect(results.map((r) => r.name)).toEqual(["failing"]);
  });

  it("collects all ok+warn results when no fails", async () => {
    const a: BootCheck = { name: "a", phases: ["pre-wiring"], run: async () => ({ name: "a", status: "ok" }) };
    const b: BootCheck = { name: "b", phases: ["pre-wiring"], run: async () => ({ name: "b", status: "warn", message: "meh" }) };
    const c: BootCheck = { name: "c", phases: ["pre-wiring"], run: async () => ({ name: "c", status: "ok" }) };
    const results = await runChecks("pre-wiring", "execute", fakeCtx(), [a, b, c]);
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual(["a:ok", "b:warn", "c:ok"]);
  });
});
