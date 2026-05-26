#!/usr/bin/env tsx
/**
 * Ensure the scheduler task Bitable has the required columns.
 *
 * Usage:
 *   SCHEDULER_BITABLE_BASE_TOKEN=xxx SCHEDULER_BITABLE_TABLE_ID=yyy \
 *     npm run bitable:ensure-fields
 *
 * Missing fields are created. Existing fields are left alone (their type is NOT
 * checked, since lark-cli's field-update is destructive and out of scope).
 *
 * Lark-cli field types used:
 *   1 = 文本 (text)
 *   2 = 数字 (number)
 *   5 = 日期时间 (datetime, stored as int ms)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type FieldType = "text" | "number" | "datetime" | "single_select";
type FieldSpec = { name: string; type: FieldType; options?: string[] };

const REQUIRED_FIELDS: FieldSpec[] = [
  { name: "任务分类", type: "text" },
  {
    name: "业务分类",
    type: "single_select",
    options: ["数据采集", "数据加工", "报告产出", "业务巡检", "跨会话委派", "平台运维", "一次性补跑", "已完成", "已废弃", "未标"],
  },
  { name: "预期时长(分钟)", type: "number" },
  { name: "Owner session", type: "text" },
  { name: "并发策略", type: "text" },
  { name: "覆盖配置", type: "text" },
  { name: "迁移阶段", type: "number" },
  { name: "最近触发状态", type: "text" },
  { name: "最近验证状态", type: "text" },
  { name: "最近运行状态", type: "text" },
  { name: "最近触发时间", type: "datetime" },
];

async function listExistingFields(
  cliPath: string,
  baseToken: string,
  tableId: string
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    cliPath,
    ["base", "+field-list", "--base-token", baseToken, "--table-id", tableId, "-q", ".data.fields[].name"],
    { timeout: 15_000, maxBuffer: 512 * 1024 }
  );
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function createField(
  cliPath: string,
  baseToken: string,
  tableId: string,
  spec: FieldSpec
): Promise<void> {
  const payload: Record<string, unknown> = { name: spec.name, type: spec.type };
  if (spec.type === "single_select" && spec.options) {
    payload.options = spec.options.map((name) => ({ name }));
  }
  const body = JSON.stringify(payload);
  await execFileAsync(
    cliPath,
    ["base", "+field-create", "--base-token", baseToken, "--table-id", tableId, "--json", body],
    { timeout: 15_000, maxBuffer: 512 * 1024 }
  );
}

async function main(): Promise<void> {
  const cliPath = process.env.SCHEDULER_LARK_CLI_PATH ?? "lark-cli";
  const baseToken = process.env.SCHEDULER_BITABLE_BASE_TOKEN;
  const tableId = process.env.SCHEDULER_BITABLE_TABLE_ID;
  if (!baseToken || !tableId) {
    console.error("SCHEDULER_BITABLE_BASE_TOKEN and SCHEDULER_BITABLE_TABLE_ID must be set");
    process.exit(2);
  }

  const existing = new Set(await listExistingFields(cliPath, baseToken, tableId));
  const missing = REQUIRED_FIELDS.filter((f) => !existing.has(f.name));

  if (missing.length === 0) {
    console.log(`[bitable] All ${REQUIRED_FIELDS.length} required fields already present.`);
    return;
  }
  console.log(`[bitable] Creating ${missing.length} missing field(s): ${missing.map((m) => m.name).join(", ")}`);
  for (const spec of missing) {
    process.stdout.write(`  + ${spec.name} (type=${spec.type}) ... `);
    try {
      await createField(cliPath, baseToken, tableId, spec);
      console.log("OK");
    } catch (err) {
      console.log(`FAILED: ${String(err)}`);
      process.exit(1);
    }
  }
  console.log("[bitable] Done.");
}

main().catch((err) => {
  console.error("[bitable] Fatal:", err);
  process.exit(1);
});
