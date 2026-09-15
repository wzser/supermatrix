import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("has no remote identifiers by default and disables Bitable sync", () => {
    const config = loadConfig({});

    expect(config.bitableBaseToken).toBe("");
    expect(config.bitableTableId).toBe("");
    expect(config.bitableSyncEnabled).toBe(false);
    expect(config.apiBase).toBe("http://127.0.0.1:3501");
  });

  it("requires both Bitable identifiers before enabling the mirror", () => {
    expect(() => loadConfig({ WATCHDOG_BITABLE_BASE_TOKEN: "example" })).toThrow(
      "WATCHDOG_BITABLE_BASE_TOKEN and WATCHDOG_BITABLE_TABLE_ID together",
    );

    const config = loadConfig({
      WATCHDOG_BITABLE_BASE_TOKEN: "example-base",
      WATCHDOG_BITABLE_TABLE_ID: "example-table",
      WATCHDOG_DISABLE_SYNC: "1",
    });
    expect(config.bitableSyncEnabled).toBe(false);
    expect(config.bitableBaseToken).toBe("example-base");
  });

  it("uses the selected instance API and session namespace", () => {
    const config = loadConfig({
      SM_API_BASE: "http://127.0.0.1:45123/",
      SM_SESSION_NAME: "isolated-watchdog",
    });

    expect(config.apiBase).toBe("http://127.0.0.1:45123/");
    expect(config.notifySource).toBe("isolated-watchdog");
  });
});
