import type { BootCheck } from "../types.ts";

export type KimiProbeResult =
  | { kind: "ok"; version: string }
  | { kind: "fail"; error: string };

export type KimiAcpHealthCheckDeps = {
  probe: () => Promise<KimiProbeResult>;
};

export function createKimiAcpHealthCheck(
  deps: KimiAcpHealthCheckDeps,
): BootCheck {
  return {
    name: "kimi-acp-health",
    phases: ["pre-wiring"],
    async run() {
      const result = await deps.probe();
      if (result.kind === "ok") {
        return {
          name: "kimi-acp-health",
          status: "ok",
          detail: { version: result.version },
        };
      }
      return {
        name: "kimi-acp-health",
        status: "warn",
        message: `kimi CLI 不可用：${result.error}（kimi backend 用户将无法发起对话；不影响 claude/codex）`,
      };
    },
  };
}
