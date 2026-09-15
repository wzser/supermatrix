import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const MAIN_PATH = resolve(import.meta.dirname, "../../src/cli/main.ts");

describe("SuperMatrix external signal gate startup order", () => {
  test("installs both signal handlers before bootstrap begins", () => {
    const source = readFileSync(MAIN_PATH, "utf8");
    const bootstrapAt = source.indexOf("await bootstrap(process.env)");
    const bootstrapImportAt = source.indexOf('await import("./bootstrap.ts")');
    const sigintAt = source.indexOf('process.on("SIGINT"');
    const sigtermAt = source.indexOf('process.on("SIGTERM"');

    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(bootstrapImportAt).toBeGreaterThan(-1);
    expect(sigintAt).toBeGreaterThan(-1);
    expect(sigtermAt).toBeGreaterThan(-1);
    expect(sigintAt).toBeLessThan(bootstrapAt);
    expect(sigtermAt).toBeLessThan(bootstrapAt);
    expect(sigintAt).toBeLessThan(bootstrapImportAt);
    expect(sigtermAt).toBeLessThan(bootstrapImportAt);
  });
});
