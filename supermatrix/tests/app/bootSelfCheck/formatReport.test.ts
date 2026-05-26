import { describe, expect, it } from "vitest";
import {
  renderStderrFailReport,
  renderAnnounceCheckSection,
  renderLarkSelfCheckMessage,
} from "../../../src/app/bootSelfCheck/formatReport.ts";
import type { CheckResult } from "../../../src/app/bootSelfCheck/types.ts";

const results: CheckResult[] = [
  { name: "local-deps", status: "fail", message: "lark-cli missing" },
  { name: "supervisor-presence", status: "warn", message: "bare run under zsh" },
  { name: "scheduler-health", status: "ok", detail: { tasks: 10 } },
];

describe("formatReport", () => {
  it("renders stderr fail report with fails and warns", () => {
    const s = renderStderrFailReport(results);
    expect(s).toContain("boot 自检失败");
    expect(s).toContain("❌ local-deps: lark-cli missing");
    expect(s).toContain("⚠️ supervisor-presence: bare run under zsh");
  });

  it("renders announce check section with warns and pass count", () => {
    const mixed: CheckResult[] = [
      { name: "local-deps", status: "ok" },
      { name: "supervisor-presence", status: "warn", message: "bare run under zsh" },
      { name: "scheduler-health", status: "ok" },
      { name: "reconcile-backend-processes", status: "warn", message: "killed 1 orphan(s)" },
    ];
    const s = renderAnnounceCheckSection(mixed);
    expect(s).toContain("⚠️ 自检 2/4 通过，2 告警");
    expect(s).toContain("• supervisor-presence");
    expect(s).toContain("• reconcile-backend-processes");
  });

  it("renders all-pass summary when no warns", () => {
    const allOk: CheckResult[] = [
      { name: "local-deps", status: "ok" },
      { name: "scheduler-health", status: "ok" },
    ];
    const s = renderAnnounceCheckSection(allOk);
    expect(s).toContain("✅ 自检 2/2 通过");
  });

  it("renders lark /selfcheck message with all statuses", () => {
    const s = renderLarkSelfCheckMessage(results);
    expect(s).toContain("SuperMatrix 自检报告");
    expect(s).toContain("✅ scheduler-health");
    expect(s).toContain("⚠️ supervisor-presence");
    expect(s).toContain("❌ local-deps");
  });
});
