import type { CheckResult } from "./types.ts";

export function renderStderrFailReport(results: CheckResult[]): string {
  const lines: string[] = ["[supermatrix] boot 自检失败："];
  for (const r of results) {
    if (r.status === "fail") lines.push(`  ❌ ${r.name}: ${r.message}`);
    else if (r.status === "warn") lines.push(`  ⚠️ ${r.name}: ${r.message}`);
    else if (r.status === "info") lines.push(`  ℹ️ ${r.name}: ${r.message}`);
  }
  lines.push("");
  lines.push("[supermatrix] 终止启动。修复以上失败项后重启。");
  return lines.join("\n");
}

export function renderAnnounceCheckSection(results: CheckResult[]): string {
  const total = results.length;
  const warns = results.filter((r) => r.status === "warn");
  const passed = total - warns.length;
  const lines: string[] = [];
  if (warns.length === 0) {
    lines.push("", `✅ 自检 ${total}/${total} 通过`);
  } else {
    lines.push("", `⚠️ 自检 ${passed}/${total} 通过，${warns.length} 告警:`);
    for (const r of warns) {
      lines.push(`• ${r.name}: ${r.message}`);
    }
  }
  return lines.join("\n");
}

export function renderLarkSelfCheckMessage(results: CheckResult[]): string {
  const lines = ["🔍 SuperMatrix 自检报告（runtime / observe）", ""];
  for (const r of results) {
    if (r.status === "ok") lines.push(`✅ ${r.name}: ok`);
    else if (r.status === "info") lines.push(`ℹ️ ${r.name}: ${r.message}`);
    else if (r.status === "warn") lines.push(`⚠️ ${r.name}: ${r.message}`);
    else lines.push(`❌ ${r.name}: ${r.message}`);
  }
  return lines.join("\n");
}
