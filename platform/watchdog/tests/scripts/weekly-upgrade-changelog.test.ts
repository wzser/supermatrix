import { describe, expect, it } from "vitest";
import {
  compareVersions,
  coverageExpectations,
  filterVersionRange,
  formatChangelogSection,
  parseClaudeChangelogMarkdown,
  parseCodexReleases,
  parseKimiReleases,
  parseNpmRegistryVersions,
  versionInRange,
  type CliChangelogCapture,
} from "../../src/scripts/_weekly-upgrade-changelog.js";

describe("version comparison and range", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("2.1.222", "2.1.221")).toBeGreaterThan(0);
    expect(compareVersions("0.146.1", "0.146.1")).toBe(0);
    expect(compareVersions("1.0.9", "1.0.84")).toBeLessThan(0);
    expect(compareVersions("unknown", "0.0.1")).toBeLessThan(0);
  });

  it("uses a half-open range (before, after]", () => {
    expect(versionInRange("2.1.220", "2.1.220", "2.1.222")).toBe(false);
    expect(versionInRange("2.1.221", "2.1.220", "2.1.222")).toBe(true);
    expect(versionInRange("2.1.222", "2.1.220", "2.1.222")).toBe(true);
    expect(versionInRange("2.1.223", "2.1.220", "2.1.222")).toBe(false);
  });
});

describe("changelog source parsers", () => {
  it("parses Claude Code CHANGELOG.md sections and filters the upgrade range", () => {
    const markdown = [
      "# Changelog",
      "",
      "## 2.1.223",
      "- newest thing",
      "",
      "## 2.1.222",
      "- fixed stream-json edge case",
      "- new --foo flag",
      "",
      "## 2.1.221",
      "- internal cleanup",
      "",
      "## 2.1.220",
      "- old",
    ].join("\n");
    const entries = parseClaudeChangelogMarkdown(markdown);
    expect(entries.map((e) => e.version)).toEqual(["2.1.223", "2.1.222", "2.1.221", "2.1.220"]);
    const inRange = filterVersionRange(entries, "2.1.220", "2.1.222");
    expect(inRange.map((e) => e.version)).toEqual(["2.1.221", "2.1.222"]);
    expect(inRange[1]!.body).toContain("--foo");
  });

  it("parses kimi GitHub releases with npm-scoped tags", () => {
    const entries = parseKimiReleases([
      { tag_name: "@moonshot-ai/kimi-code@0.33.0", published_at: "2026-08-05T08:24:45Z", body: "- new stuff" },
      { tag_name: "@moonshot-ai/kimi-code@0.31.1", body: "- fix" },
      { tag_name: "weird-tag", body: "junk" },
    ]);
    expect(entries.map((e: { version: string }) => e.version)).toEqual(["0.33.0", "0.31.1"]);
    expect(filterVersionRange(entries, "0.30.0", "0.33.0").map((e) => e.version)).toEqual(["0.31.1", "0.33.0"]);
  });

  it("parses codex GitHub releases with rust-v tags", () => {
    const entries = parseCodexReleases([
      { tag_name: "rust-v0.146.1", published_at: "2026-08-04T00:00:00Z", body: "- fix exec json" },
      { tag_name: "rust-v0.146.0", body: "" },
      { tag_name: "not-a-version", body: "junk" },
    ]);
    expect(entries.map((e) => e.version)).toEqual(["0.146.1", "0.146.0"]);
    expect(entries[0]).toMatchObject({ publishedAt: "2026-08-04T00:00:00Z", body: "- fix exec json" });
    expect(entries[1]!.body).toBeUndefined();
  });

  it("parses npm registry versions with publish times and no body", () => {
    const entries = parseNpmRegistryVersions({
      versions: { "1.0.83": {}, "1.0.84": {} },
      time: { "1.0.83": "2026-07-30T00:00:00Z", "1.0.84": "2026-08-02T00:00:00Z", created: "x" },
    });
    expect(filterVersionRange(entries, "1.0.80", "1.0.84").map((e) => e.version)).toEqual(["1.0.83", "1.0.84"]);
  });

  it("tolerates malformed payloads", () => {
    expect(parseCodexReleases(null)).toEqual([]);
    expect(parseCodexReleases({ message: "rate limited" })).toEqual([]);
    expect(parseNpmRegistryVersions(null)).toEqual([]);
    expect(parseClaudeChangelogMarkdown("")).toEqual([]);
  });
});

describe("prompt material and coverage expectations", () => {
  const okCapture: CliChangelogCapture = {
    cli: "claude-code", before: "2.1.220", after: "2.1.222", status: "ok",
    source: "https://example/CHANGELOG.md",
    versions: [
      { version: "2.1.221", body: "- cleanup" },
      { version: "2.1.222", body: "- fix" },
    ],
  };
  const failedCapture: CliChangelogCapture = {
    cli: "codex", before: "0.146.0", after: "0.146.1", status: "unavailable",
    source: "fetch-failed", versions: [], reason: "HTTP 403",
  };

  it("formats fetched entries per version and marks failed fetches for root self-sourcing", () => {
    const section = formatChangelogSection([okCapture, failedCapture]);
    expect(section).toContain("#### 2.1.221");
    expect(section).toContain("#### 2.1.222");
    expect(section).toContain("claude-code 2.1.220 → 2.1.222");
    expect(section).toContain("抓取失败：HTTP 403");
    expect(section).toContain("请自行取源核对该区间");
  });

  it("only requires machine-checked coverage for CLIs with fetched version lists", () => {
    expect(coverageExpectations([okCapture, failedCapture])).toEqual([
      { cli: "claude-code", versions: ["2.1.221", "2.1.222"] },
    ]);
    expect(coverageExpectations([failedCapture])).toEqual([]);
  });
});
