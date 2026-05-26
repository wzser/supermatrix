import { describe, expect, it } from "vitest";
import { supervisorPresenceCheck } from "../../../../src/app/bootSelfCheck/checks/supervisorPresence.ts";
import { createFakeProcessLister } from "../../../fakes/fakeProcessLister.ts";
import type { BootCheckContext } from "../../../../src/app/bootSelfCheck/types.ts";

function ctx(
  parentPid: number,
  commandByPid: Record<number, string>,
  ppidByPid: Record<number, number> = {},
): BootCheckContext {
  return {
    cfg: {} as BootCheckContext["cfg"],
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}) as never,
    } as never,
    processLister: createFakeProcessLister({ commandByPid, ppidByPid }),
    __fakePpid: parentPid,
  } as BootCheckContext & { __fakePpid: number };
}

describe("supervisor-presence", () => {
  it("classifies direct dev-loop parent as ok", async () => {
    const c = ctx(1000, { 1000: "/bin/zsh /repo/scripts/dev-loop.sh" });
    const result = await supervisorPresenceCheck.run(c, "execute");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail).toMatchObject({ supervisor: "dev-loop", depth: 0 });
    }
  });

  it("walks up through tsx wrapper to find dev-loop.sh as grandparent", async () => {
    // Simulate the real chain: main.ts (fake self pid 2000)
    //   -> tsx wrapper (pid 1500, cmd "node .../tsx .../main.ts")
    //        -> dev-loop.sh (pid 1000, cmd "/bin/zsh .../dev-loop.sh")
    const c = ctx(
      1500, // parent of us: tsx wrapper
      {
        1500: "node /repo/node_modules/.bin/tsx /repo/src/cli/main.ts",
        1000: "/bin/zsh /repo/scripts/dev-loop.sh",
      },
      {
        1500: 1000, // tsx wrapper's parent is dev-loop
        1000: 31324, // dev-loop's parent doesn't matter — walk finds match before it
      },
    );
    const result = await supervisorPresenceCheck.run(c, "execute");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail).toMatchObject({
        supervisor: "dev-loop",
        ancestorPid: 1000,
        depth: 1,
      });
    }
  });

  it("classifies PM2 as ok (direct parent)", async () => {
    const c = ctx(1000, { 1000: "PM2 v6.0.14: God Daemon" });
    const result = await supervisorPresenceCheck.run(c, "execute");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail).toMatchObject({ supervisor: "pm2" });
    }
  });

  it("classifies bare shell as warn", async () => {
    const c = ctx(1000, { 1000: "-zsh" }, { 1000: 500 });
    const result = await supervisorPresenceCheck.run(c, "execute");
    expect(result.status).toBe("warn");
    if (result.status === "warn") {
      expect(result.message).toMatch(/没有 supervisor/);
    }
  });

  it("returns warn when the walk hits PPID=1 without finding a supervisor", async () => {
    // tsx wrapper whose parent is init (1). No supervisor found.
    const c = ctx(
      1500,
      { 1500: "node /repo/node_modules/.bin/tsx /repo/src/cli/main.ts" },
      { 1500: 1 },
    );
    const result = await supervisorPresenceCheck.run(c, "execute");
    expect(result.status).toBe("warn");
    if (result.status === "warn") {
      expect(result.message).toMatch(/PPID=1/);
    }
  });

  it("stops walking after MAX_WALK_DEPTH to avoid loops", async () => {
    // Build a 10-deep chain of node-looking parents, all pointing up
    // to each other. Walk should stop at depth 5.
    const commandByPid: Record<number, string> = {};
    const ppidByPid: Record<number, number> = {};
    for (let i = 2000; i < 2010; i++) {
      commandByPid[i] = `node /fake/path/tsx /fake/main.ts (loop ${i})`;
      ppidByPid[i] = i + 1;
    }
    const c = ctx(2000, commandByPid, ppidByPid);
    const result = await supervisorPresenceCheck.run(c, "execute");
    expect(result.status).toBe("warn");
    // Should report "bare run" since no match was found within the depth.
    if (result.status === "warn") {
      expect(result.message).toMatch(/没有 supervisor/);
    }
  });
});
