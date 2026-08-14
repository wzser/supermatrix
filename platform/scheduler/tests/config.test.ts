import { describe, it, expect } from "vitest";
import { loadConfig, assertAdminToken } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults port to 3502 and uses scheduler-v2.db", () => {
    const c = loadConfig({});
    expect(c.port).toBe(3502);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dbPath).toContain("scheduler-v2.db");
    expect(c.smDbPath).toContain("supermatrix.db");
    expect(c.smBaseUrl).toBe("http://localhost:3501");
  });

  it("overrides from env", () => {
    const c = loadConfig({ SCHEDULER_V2_PORT: "4000", SCHEDULER_V2_DB: "/tmp/x.db", SM_DB: "/tmp/sm.db" });
    expect(c.port).toBe(4000);
    expect(c.dbPath).toBe("/tmp/x.db");
    expect(c.smDbPath).toBe("/tmp/sm.db");
  });

  it("derives smDbPath from SM_RUNTIME_ROOT when SM_DB is absent", () => {
    const c = loadConfig({ SM_RUNTIME_ROOT: "/tmp/runtime" });
    expect(c.smDbPath).toBe("/tmp/runtime/data/supermatrix.db");
  });

});

describe("v2 config adminToken", () => {
  it("loadConfig reads SCHEDULER_ADMIN_TOKEN from env", () => {
    const cfg = loadConfig({ SCHEDULER_ADMIN_TOKEN: "tok-123" } as NodeJS.ProcessEnv);
    expect(cfg.adminToken).toBe("tok-123");
  });

  it("loadConfig leaves adminToken undefined when env unset", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.adminToken).toBeUndefined();
  });

  it("assertAdminToken throws when token missing", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(() => assertAdminToken(cfg)).toThrow(/SCHEDULER_ADMIN_TOKEN/);
  });

  it("assertAdminToken passes when token present", () => {
    const cfg = loadConfig({ SCHEDULER_ADMIN_TOKEN: "tok-123" } as NodeJS.ProcessEnv);
    expect(() => assertAdminToken(cfg)).not.toThrow();
  });
});
