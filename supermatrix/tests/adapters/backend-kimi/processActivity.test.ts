// tests/adapters/backend-kimi/processActivity.test.ts
import { describe, expect, test } from "vitest";
import {
  collectProcessTreePids,
  isProcessTreeActive,
  parsePsTimeMs,
  sumNettopBytesForPids,
  sumProcessTreeCpuMs,
} from "../../../src/adapters/backend-kimi/processActivity.ts";

describe("parsePsTimeMs", () => {
  test("macOS m:ss.cc (hundredths)", () => {
    expect(parsePsTimeMs("1:00.69")).toBe(60_690);
  });
  test("linux hh:mm:ss", () => {
    expect(parsePsTimeMs("01:02:03")).toBe(3_723_000);
  });
  test("dd-hh:mm:ss", () => {
    expect(parsePsTimeMs("2-03:04:05")).toBe(183_845_000);
  });
  test("zero", () => {
    expect(parsePsTimeMs("0:00.00")).toBe(0);
  });
  test("garbage → null", () => {
    expect(parsePsTimeMs("abc")).toBeNull();
    expect(parsePsTimeMs("")).toBeNull();
  });
});

describe("sumProcessTreeCpuMs", () => {
  const PS = [
    "    1     0   1:00.00",
    "  100     1   0:10.00",
    "  200   100   0:05.00", // child of 100
    "  300   200   0:02.00", // grandchild of 100
    "  400     1   9:00.00", // sibling subtree, not under 100
  ].join("\n");

  test("sums root + all descendants, ignoring unrelated subtrees", () => {
    expect(sumProcessTreeCpuMs(PS, 100)).toBe(10_000 + 5_000 + 2_000);
  });
  test("unknown root → 0", () => {
    expect(sumProcessTreeCpuMs(PS, 999)).toBe(0);
  });
  test("empty output → 0", () => {
    expect(sumProcessTreeCpuMs("", 100)).toBe(0);
  });
});

describe("sumNettopBytesForPids", () => {
  const NETTOP = [
    "                                                              bytes_in       bytes_out",
    "kimi.100                                                                              1000            500",
    "   tcp4 192.168.1.2:60000<->203.0.113.1:443                                             1000            500",
    "com.apple.WebKit.Networking.200                                                         300            700",
    "node.999                                                                                 10             20",
  ].join("\n");

  test("sums in+out over process rows of the given pids only", () => {
    expect(sumNettopBytesForPids(NETTOP, new Set([100, 200]))).toBe(1500 + 1000);
  });
  test("ignores header and indented per-connection rows", () => {
    expect(sumNettopBytesForPids(NETTOP, new Set([999]))).toBe(30);
  });
  test("no matching pid → 0", () => {
    expect(sumNettopBytesForPids(NETTOP, new Set([12345]))).toBe(0);
  });
});

describe("collectProcessTreePids", () => {
  const PS = [
    "    1     0   1:00.00",
    "  100     1   0:10.00",
    "  200   100   0:05.00",
    "  300   200   0:02.00",
    "  400     1   9:00.00",
  ].join("\n");

  test("root + all descendants, no unrelated subtrees", () => {
    expect([...collectProcessTreePids(PS, 100)].sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });
});

describe("isProcessTreeActive", () => {
  const noSleep = async () => {};

  test("CPU advanced during the window → active", async () => {
    const samples = ["  100     1   0:10.00\n", "  100     1   0:10.05\n"];
    let i = 0;
    const exec = async () => ({ stdout: samples[Math.min(i++, samples.length - 1)]! });
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toBe(true);
  });

  test("descendant CPU advance counts as activity", async () => {
    const samples = [
      "  100     1   0:10.00\n  200   100   0:01.00\n",
      "  100     1   0:10.00\n  200   100   0:01.07\n",
    ];
    let i = 0;
    const exec = async () => ({ stdout: samples[Math.min(i++, samples.length - 1)]! });
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toBe(true);
  });

  test("CPU flat → inactive", async () => {
    const exec = async () => ({ stdout: "  100     1   0:10.00\n" });
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toBe(false);
  });

  test("advance below the epsilon → inactive (rounding noise)", async () => {
    const samples = ["  100     1   0:10.00\n", "  100     1   0:10.01\n"];
    let i = 0;
    const exec = async () => ({ stdout: samples[Math.min(i++, samples.length - 1)]! });
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toBe(false);
  });

  test("ps failure → unknown (never implies an idle process tree)", async () => {
    const exec = async () => {
      throw new Error("ps missing");
    };
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toEqual({
      kind: "unknown",
      reason: "ps sample unavailable before CPU probe window",
    });
  });

  test("CPU flat but net bytes grew → active (in-flight LLM streaming)", async () => {
    const netSamples = ["kimi.100   1000   500\n", "kimi.100   5000   900\n"];
    let i = 0;
    const exec = async (cmd: string) => ({
      stdout: cmd === "ps" ? "  100     1   0:10.00\n" : netSamples[Math.min(i++, netSamples.length - 1)]!,
    });
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toBe(true);
  });

  test("CPU flat + net flat → inactive", async () => {
    const exec = async (cmd: string) => ({
      stdout: cmd === "ps" ? "  100     1   0:10.00\n" : "kimi.100   1000   500\n",
    });
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toBe(false);
  });

  test("nettop failure → degrades to CPU-only verdict", async () => {
    const exec = async (cmd: string) => {
      if (cmd === "nettop") throw new Error("nettop missing");
      return { stdout: "  100     1   0:10.00\n" };
    };
    expect(await isProcessTreeActive(100, 0, { exec, sleep: noSleep })).toBe(false);
  });
});
