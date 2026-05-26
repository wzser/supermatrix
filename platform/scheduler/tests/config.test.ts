import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads config from env vars", () => {
    const env = {
      SCHEDULER_PORT: "4000",
      SCHEDULER_DB_PATH: "/tmp/test-scheduler.db",
    };
    const config = loadConfig(env);
    expect(config.port).toBe(4000);
    expect(config.dbPath).toBe("/tmp/test-scheduler.db");
  });

  it("uses defaults when optional vars are missing", () => {
    const env = {
      SCHEDULER_DB_PATH: "/tmp/test.db",
    };
    const config = loadConfig(env);
    expect(config.port).toBe(3500);
    expect(config.notifyGroupId).toBeUndefined();
  });

  it("throws on missing required vars", () => {
    expect(() => loadConfig({})).toThrow();
  });

  it("defaults host to 127.0.0.1", () => {
    const env = { SCHEDULER_DB_PATH: "/tmp/test.db" };
    const config = loadConfig(env);
    expect(config.host).toBe("127.0.0.1");
  });

  it("accepts custom host from env", () => {
    const env = { SCHEDULER_DB_PATH: "/tmp/test.db", SCHEDULER_HOST: "0.0.0.0" };
    const config = loadConfig(env);
    expect(config.host).toBe("0.0.0.0");
  });

  it("rejects empty dbPath", () => {
    const env = { SCHEDULER_DB_PATH: "" };
    expect(() => loadConfig(env)).toThrow();
  });

  it("defaults transient retry policy to 2 retries / 15s", () => {
    const env = { SCHEDULER_DB_PATH: "/tmp/test.db" };
    const config = loadConfig(env);
    expect(config.transientRetryCount).toBe(2);
    expect(config.transientRetryDelayMs).toBe(15_000);
  });

  it("allows overriding transient retry policy via env", () => {
    const env = {
      SCHEDULER_DB_PATH: "/tmp/test.db",
      SCHEDULER_TRANSIENT_RETRY_COUNT: "4",
      SCHEDULER_TRANSIENT_RETRY_DELAY_MS: "30000",
    };
    const config = loadConfig(env);
    expect(config.transientRetryCount).toBe(4);
    expect(config.transientRetryDelayMs).toBe(30_000);
  });
});
