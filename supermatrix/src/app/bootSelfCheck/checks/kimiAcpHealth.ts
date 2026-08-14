import type { BootCheck } from "../types.ts";

export type KimiVersionProbeResult =
  | { kind: "ok"; version: string }
  | { kind: "fail"; error: string };

export type KimiAcpInitProbeResult =
  | { kind: "ok"; rttMs: number }
  | { kind: "fail"; error: string };

export type KimiAcpHealthCheckDeps = {
  probeVersion: () => Promise<KimiVersionProbeResult>;
  probeAcpInitialize: (opts: { timeoutMs: number }) => Promise<KimiAcpInitProbeResult>;
  /** ACP initialize timeout. Default 5000ms. Override for tests. */
  acpInitTimeoutMs?: number;
  /** RTT > this threshold marks the check as "info" (still ok, but flagged). Default 1500ms. */
  rttSlowThresholdMs?: number;
};

export function parseKimiCliVersion(output: string): string {
  const text = output.trim();
  if (!text) return "unknown";

  return text.match(/^v?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/u)?.[1] ?? "unknown";
}

export function createKimiAcpHealthCheck(
  deps: KimiAcpHealthCheckDeps,
): BootCheck {
  const timeoutMs = deps.acpInitTimeoutMs ?? 5_000;
  const slowThreshold = deps.rttSlowThresholdMs ?? 1_500;

  return {
    name: "kimi-acp-health",
    phases: ["pre-wiring"],
    async run() {
      // Stage 1: version probe
      const versionResult = await deps.probeVersion();
      if (versionResult.kind === "fail") {
        return {
          name: "kimi-acp-health",
          status: "warn",
          message: `kimi CLI 不可用：${versionResult.error}（kimi backend 用户将无法发起对话；不影响 claude/codex）`,
        };
      }

      const version = versionResult.version;

      // Stage 2: ACP initialize probe
      const acpResult = await deps.probeAcpInitialize({ timeoutMs });
      if (acpResult.kind === "fail") {
        return {
          name: "kimi-acp-health",
          status: "warn",
          message: `kimi ACP 协议层无响应：${acpResult.error}（CLI 在但 daemon 未应答 initialize；kimi backend 会卡）`,
          detail: { version },
        };
      }

      const { rttMs } = acpResult;
      if (rttMs > slowThreshold) {
        return {
          name: "kimi-acp-health",
          status: "info",
          message: `kimi ACP 响应缓慢：${rttMs}ms > ${slowThreshold}ms（boot 正常但可能有性能问题）`,
          detail: { version, rttMs },
        };
      }

      return {
        name: "kimi-acp-health",
        status: "ok",
        detail: { version, rttMs },
      };
    },
  };
}
