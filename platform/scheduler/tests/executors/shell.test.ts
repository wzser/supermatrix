import { describe, it, expect } from "vitest";
import { executeShell } from "../../src/executors/shell.js";

describe("executeShell", () => {
  it("runs a command and captures stdout", async () => {
    const result = await executeShell({
      command: "echo hello",
      cwd: "/tmp",
      timeout: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("captures stderr on failure", async () => {
    const result = await executeShell({
      command: "node -e \"process.stderr.write('err'); process.exit(1)\"",
      cwd: "/tmp",
      timeout: 5000,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("err");
  });

  it("times out long-running commands", async () => {
    const result = await executeShell({
      command: "sleep 10",
      cwd: "/tmp",
      timeout: 500,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });
});
