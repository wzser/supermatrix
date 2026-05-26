import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localDepsCheck } from "../../../../src/app/bootSelfCheck/checks/localDeps.ts";
import type { BootCheckContext } from "../../../../src/app/bootSelfCheck/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "sm-localdeps-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeLarkCliStub(at: string) {
  writeFileSync(at, `#!/bin/sh\necho lark-cli 0.0.0-test\nexit 0\n`, { mode: 0o755 });
}

function ctxWith(overrides: Partial<BootCheckContext["cfg"]>): BootCheckContext {
  const cfg = {
    larkCliPath: path.join(tmp, "lark-cli"),
    dbPath: path.join(tmp, "data", "sm.db"),
    workspaceRoot: path.join(tmp, "workspace"),
    ...overrides,
  } as BootCheckContext["cfg"];
  return {
    cfg,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({} as never) } as never,
    processLister: { list: async () => [], killAll: async () => [], getCommand: async () => null, getProcessInfo: async () => null },
  };
}

describe("local-deps check", () => {
  it("returns ok when all probes pass", async () => {
    makeLarkCliStub(path.join(tmp, "lark-cli"));
    mkdirSync(path.join(tmp, "data"));
    mkdirSync(path.join(tmp, "workspace"));
    const ctx = ctxWith({});
    const result = await localDepsCheck.run(ctx, "execute");
    expect(result.status).toBe("ok");
  });

  it("returns fail when lark-cli binary is missing and PATH has none", async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = path.join(tmp, "empty-path"); // nonexistent dir
    try {
      mkdirSync(path.join(tmp, "data"));
      mkdirSync(path.join(tmp, "workspace"));
      const ctx = ctxWith({});
      const result = await localDepsCheck.run(ctx, "execute");
      expect(result.status).toBe("fail");
      if (result.status === "fail") {
        expect(result.message).toMatch(/lark-cli/);
      }
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("auto-creates missing db directory with mkdir -p", async () => {
    makeLarkCliStub(path.join(tmp, "lark-cli"));
    mkdirSync(path.join(tmp, "workspace"));
    // data dir intentionally missing
    const ctx = ctxWith({});
    const result = await localDepsCheck.run(ctx, "execute");
    expect(result.status).not.toBe("fail");
  });

  it("auto-repairs broken primary lark-cli via PATH fallback", async () => {
    const fallbackDir = path.join(tmp, "fallback-bin");
    mkdirSync(fallbackDir);
    makeLarkCliStub(path.join(fallbackDir, "lark-cli"));
    const oldPath = process.env.PATH;
    process.env.PATH = fallbackDir;
    try {
      mkdirSync(path.join(tmp, "data"));
      mkdirSync(path.join(tmp, "workspace"));
      const ctx = ctxWith({ larkCliPath: path.join(tmp, "not-here") });
      const result = await localDepsCheck.run(ctx, "execute");
      expect(result.status).toBe("warn");
      // cfg should have been mutated to the fallback
      expect(ctx.cfg.larkCliPath).toBe(path.join(fallbackDir, "lark-cli"));
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("auto-repairs when primary lark-cli --version hangs past timeout", async () => {
    // Primary lark-cli exists and is executable, but hangs forever on --version.
    // This proves canExec's 2s timeout detects a broken-but-present binary
    // (not just a missing file), which is the whole reason we invoke it
    // rather than relying on access(X_OK) alone.
    const hungStub = path.join(tmp, "lark-cli");
    writeFileSync(hungStub, `#!/bin/sh\nsleep 10\n`, { mode: 0o755 });
    // PATH fallback is a working stub so the check can auto-repair.
    const fallbackDir = path.join(tmp, "fallback-bin");
    mkdirSync(fallbackDir);
    makeLarkCliStub(path.join(fallbackDir, "lark-cli"));
    const oldPath = process.env.PATH;
    process.env.PATH = fallbackDir;
    try {
      mkdirSync(path.join(tmp, "data"));
      mkdirSync(path.join(tmp, "workspace"));
      const ctx = ctxWith({});
      const result = await localDepsCheck.run(ctx, "execute");
      expect(result.status).toBe("warn");
      // cfg mutated to the fallback after the primary timed out
      expect(ctx.cfg.larkCliPath).toBe(path.join(fallbackDir, "lark-cli"));
    } finally {
      process.env.PATH = oldPath;
    }
  }, 10_000); // generous test timeout — the 2s canExec timeout is what's being proved

});
