// src/adapters/backend-kimi/usageWire.ts
//
// Per-turn token usage for kimi sessions, sourced from the kimi CLI's own
// session wire log. ACP carries no usage notifications (verified by probing
// kimi-code 0.26.0 — see scripts/probe-kimi-acp.mjs), but every ACP-driven
// session still writes `<sessionDir>/agents/<agent>/wire.jsonl`, where each
// LLM step appends one record:
//
//   {"type":"usage.record","model":"kimi-code/k3",
//    "usage":{"inputOther":13326,"output":1975,
//             "inputCacheRead":19200,"inputCacheCreation":0},
//    "usageScope":"turn","time":1784362877075}
//
// Records are per-LLM-call (not cumulative), so a turn's total is their sum.
// `session_index.jsonl` in the kimi home maps sessionId → sessionDir, which
// keeps path resolution robust (no reverse-engineering the wd_<hash> layout).
//
// Usage is best-effort: a missing/unreadable wire file or an SM restart
// mid-turn simply yields no usage for that turn; it must never break a run.

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultKimiHome, resolveSessionDir } from "../../domain/kimiSessionIndex.ts";

export type KimiTurnUsage = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  recordCount: number;
};

export type KimiUsageTracker = {
  /** Snapshot wire offsets so earlier turns' records are not re-counted. */
  beginTurn(sessionId: string): Promise<void>;
  /** Aggregate usage.record events appended since the matching beginTurn. */
  collectTurnUsage(sessionId: string): Promise<KimiTurnUsage | null>;
};

type UsageWireDeps = {
  kimiHome: string;
  now?: () => number;
};

async function listWireFiles(sessionDir: string): Promise<string[]> {
  const agentsDir = join(sessionDir, "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const wire = join(agentsDir, entry, "wire.jsonl");
    try {
      if ((await stat(wire)).isFile()) out.push(wire);
    } catch {
      // no wire log for this agent (yet)
    }
  }
  return out;
}

type UsageRecord = {
  type?: unknown;
  model?: unknown;
  usage?: {
    inputOther?: unknown;
    output?: unknown;
    inputCacheRead?: unknown;
    inputCacheCreation?: unknown;
  };
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createKimiUsageTracker(deps?: Partial<UsageWireDeps>): KimiUsageTracker {
  const kimiHome = deps?.kimiHome ?? defaultKimiHome(process.env);
  // Per (sessionId, wire file) byte offset of already-consumed content.
  const offsets = new Map<string, Map<string, number>>();

  async function wireFilesWithOffsets(sessionId: string): Promise<Map<string, number>> {
    let perSession = offsets.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      offsets.set(sessionId, perSession);
    }
    const sessionDir = await resolveSessionDir(kimiHome, sessionId);
    if (!sessionDir) return perSession;
    for (const wire of await listWireFiles(sessionDir)) {
      if (!perSession.has(wire)) perSession.set(wire, 0);
    }
    return perSession;
  }

  return {
    async beginTurn(sessionId: string): Promise<void> {
      const perSession = await wireFilesWithOffsets(sessionId);
      for (const [wire, offset] of perSession) {
        if (offset !== 0) continue; // keep an established position
        try {
          perSession.set(wire, (await stat(wire)).size);
        } catch {
          // file may not exist yet — offset 0 handles its first records
        }
      }
    },

    async collectTurnUsage(sessionId: string): Promise<KimiTurnUsage | null> {
      const perSession = await wireFilesWithOffsets(sessionId);
      const total: KimiTurnUsage = {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        recordCount: 0,
      };
      for (const [wire, offset] of perSession) {
        let size: number;
        try {
          size = (await stat(wire)).size;
        } catch {
          continue;
        }
        if (size <= offset) continue;
        let chunk: string;
        let consumed = offset;
        try {
          const fh = await open(wire, "r");
          try {
            const buf = Buffer.alloc(size - offset);
            await fh.read(buf, 0, buf.length, offset);
            chunk = buf.toString("utf-8");
          } finally {
            await fh.close();
          }
        } catch {
          continue;
        }
        const lastNewline = chunk.lastIndexOf("\n");
        if (lastNewline < 0) continue; // only a partial line so far
        consumed += Buffer.byteLength(chunk.slice(0, lastNewline + 1), "utf-8");
        perSession.set(wire, consumed);
        for (const line of chunk.slice(0, lastNewline + 1).split("\n")) {
          if (!line.includes('"usage.record"')) continue;
          let rec: UsageRecord;
          try {
            rec = JSON.parse(line) as UsageRecord;
          } catch {
            continue;
          }
          if (rec.type !== "usage.record") continue;
          const u = rec.usage ?? {};
          total.inputTokens += num(u.inputOther);
          total.outputTokens += num(u.output);
          total.cacheReadTokens += num(u.inputCacheRead);
          total.cacheWriteTokens += num(u.inputCacheCreation);
          if (typeof rec.model === "string" && rec.model) total.model = rec.model;
          total.recordCount += 1;
        }
      }
      return total.recordCount > 0 ? total : null;
    },
  };
}
