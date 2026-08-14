import { describe, expect, test } from "vitest";
import { buildCommandRegistry } from "../../src/app/commandRegistry.ts";
import { assertCommandRegistryPolicy } from "../../src/app/commandRegistryPolicy.ts";

describe("commandRegistry", () => {
  test("contains all MVP commands", () => {
    const r = buildCommandRegistry();
    for (const name of [
      "new", "clone", "delete", "list", "cancel", "reset", "restart", "status", "help", "reload",
      "branch", "lock", "unlock",
    ]) {
      expect(r[name]).toBeDefined();
    }
    expect(r.switch).toBeUndefined();
  });

  test("scopes are correct", () => {
    const r = buildCommandRegistry();
    expect(r.new.command.scope).toEqual(["root"]);
    expect(r.clone.command.scope).toEqual(["user"]);
    expect(r.reset.command.scope).toEqual(["root", "user"]);
    expect(r.restart.command.scope).toEqual(["root", "user"]);
    expect(r.reload.command.scope).toEqual(["root"]);
    expect(r.branch.command.scope).toEqual(["root", "user"]);
    expect(r.lock.command.scope).toEqual(["user"]);
    expect(r.unlock.command.scope).toEqual(["user"]);
  });

  test("rank exposes an optional name only in root scope", () => {
    const r = buildCommandRegistry();
    expect(r.rank.command.params).toContainEqual({
      name: "name",
      type: "string",
      required: false,
      kind: "positional",
      scope: ["root"],
    });
  });

  test("does not expose business-specific shipment writeback commands", () => {
    const r = buildCommandRegistry();
    expect(r["sta-writeback"]).toBeUndefined();
    expect(Object.keys(r).join("\n")).not.toMatch(/sta-writeback|shipment|writeback|货件写回/u);
  });

  test("registry entries must be explicitly approved by policy", () => {
    const r = buildCommandRegistry();
    assertCommandRegistryPolicy(r);
    expect(() =>
      assertCommandRegistryPolicy({
        ...r,
        "business-writeback": {
          ...r.help,
          command: {
            ...r.help.command,
            name: "business-writeback",
            description: "业务写回",
          },
        },
      })
    ).toThrow(/not approved/i);
  });

  test("policy records traceable session-repo owners", () => {
    const r = buildCommandRegistry();
    const approvals = assertCommandRegistryPolicy(r);
    for (const approval of Object.values(approvals)) {
      expect(approval.owner).toMatch(/^[a-z0-9][a-z0-9_-]*-[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    }
  });

  test("descriptions are Chinese", () => {
    const r = buildCommandRegistry();
    for (const entry of Object.values(r)) {
      expect(entry.command.description).toMatch(/[\u4e00-\u9fa5]/u);
    }
  });

  test("reset and restart document active branch scope", () => {
    const r = buildCommandRegistry();
    expect(r.reset.command.notes).toContain("active branch");
    expect(r.restart.command.notes).toContain("active branch");
  });

  test("branch help documents create-or-switch behavior", () => {
    const r = buildCommandRegistry();
    const notes = r.branch.command.notes ?? "";
    expect(notes).toContain("/branch <name>：如果 branch 已存在则切换");
    expect(notes).toContain("不存在则从当前 active branch 创建新 branch");
    expect(notes).toContain("/branch main");
    expect(notes).toContain("Codex 会通过 codex exec resume + fork_context 立即准备 branch");
    expect(notes).not.toContain("Codex inherited branch 在非交互 JSON fork 路径被证明前会拒绝创建");
  });

  test("/help model documents the current Opus 5 and Sonnet 5 aliases", () => {
    const r = buildCommandRegistry();
    const notes = r.model.command.notes ?? "";
    expect(notes).toContain("opus   — Claude Opus 5 (claude-opus-5)");
    expect(notes).toContain("sonnet — Claude Sonnet 5 (claude-sonnet-5)");
    expect(notes).toContain("claude-opus-5");
    expect(notes).toContain("claude-sonnet-5");
    expect(notes).toContain("fable  — Claude Fable 5 (claude-fable-5)");
    expect(notes).not.toContain("opus   — Claude Opus 4.8 (claude-opus-4-8)");
    expect(notes).not.toContain("sonnet — Claude Sonnet 4.6 (claude-sonnet-4-6)");
    expect(notes).not.toContain("opus   — Claude Opus 4.7 (claude-opus-4-7)");
  });

  test("/help retires the main-session Fixed/Unfixed feature", () => {
    const r = buildCommandRegistry();
    expect(r.model.command.notes).not.toMatch(/锁定模型|locked sessions|\/model Fixed|\/model Unfixed/u);
    expect(r.effort.command.notes).not.toMatch(/锁定 effort|effort 锁定|\/effort Fixed|\/effort Unfixed/u);
    expect(r.model.command.notes).toContain("Fixed/Unfixed 功能已退役");
    expect(r.effort.command.notes).toContain("Fixed/Unfixed 功能已退役");
    expect(r.model.command.notes).toContain("主model默认值");
    expect(r.effort.command.notes).toContain("主effort默认值");
  });

  test("/help keeps global model and effort commands on their own surfaces", () => {
    const r = buildCommandRegistry();
    expect(r.model.command.notes).toContain("/model global codex gpt-5.4");
    expect(r.model.command.notes).toContain("/model global child gpt-5.5");
    expect(r.effort.command.notes).toContain("/effort global codex high");
    expect(r.effort.command.notes).toContain("/effort global kimi high");
    expect(r.effort.command.notes).toContain("查看 Claude/Codex/Kimi 全局默认 effort");
    expect(r.effort.command.notes).toContain("/effort global child high");
    expect(r.backend.command.notes).toContain("/backend global child codex");
    expect(r.model.command.notes).toContain("所有系统入口新建 child");
    expect(r.effort.command.notes).toContain("所有系统入口新建 child");
    expect(r.backend.command.notes).toContain("所有系统入口新建 child");
    expect(r.backend.command.notes).not.toContain("/effort global");
    expect(r.model.command.params.at(-1)).toMatchObject({ name: "value", scope: ["root"] });
    expect(r.effort.command.params.at(-1)).toMatchObject({ name: "value", scope: ["root"] });
    expect(r.backend.command.params.at(-1)).toMatchObject({ name: "value", scope: ["root"] });
  });

  test("/help effort documents Fable-only ultracode", () => {
    const notes = buildCommandRegistry().effort.command.notes ?? "";
    expect(notes).toContain("Claude Fable 5（claude-fable-5）");
    expect(notes).toContain("ultracode");
    expect(notes).toContain("Claude 全局默认");
    // Kimi is model-aware (kimi-code 0.30.0): K3 takes levels mapped to the
    // native low/high/max; K2.7 is fixed-on. The help must not claim kimi has
    // no effort dimension at all.
    expect(notes).toContain("K3 模型（k3）支持 low / medium / high / xhigh / max / ultra");
    expect(notes).toContain("K2.7 模型（kimi-for-coding / -highspeed）thinking 固定 on");
    expect(notes).not.toContain("Kimi: 不支持具体 effort");
  });

  test("command notes advertise the accepted input aliases", () => {
    const r = buildCommandRegistry();
    expect(r.model.command.notes).toContain("sol");
    expect(r.model.command.notes).toContain("默认");
    expect(r.model.command.notes).toMatch(/大小写|不区分大小写|case/);
    expect(r.backend.command.notes).toContain("k2");
    expect(r.effort.command.notes).toContain("默认");
    expect(r.heartbeat.command.notes).toContain("开启");
    expect(r.heartbeat.command.notes).toContain("状态");
    expect(r.timeout.command.notes).toContain("关闭");
    expect(r.reload.command.notes).toContain("强制");
    expect(r.cancel.command.notes).toMatch(/大小写|不区分大小写/);
  });
});
