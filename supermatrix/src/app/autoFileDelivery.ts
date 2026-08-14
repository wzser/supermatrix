import { realpath, stat } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import type { LarkGroupId, MessageRunId } from "../domain/ids.ts";

export type AutoFileDeliveryFlag = "file" | "image" | "video" | "audio";

export type AutoFileDeliverySendInput = {
  groupId: LarkGroupId;
  absolutePath: string;
  flag: AutoFileDeliveryFlag;
  idempotencyKey: string;
};

export type AutoFileDeliveryInput = {
  groupId: LarkGroupId;
  sessionName: string;
  runId: MessageRunId;
  finalMessage: string;
  runStartedAtMs?: number;
};

export type AutoFileDelivery = {
  deliver(input: AutoFileDeliveryInput): Promise<void>;
};

export type AutoFileDeliveryDeps = {
  sendFile: (input: AutoFileDeliverySendInput) => Promise<boolean>;
  enabled?: boolean;
  maxBytes?: number;
  maxFiles?: number;
  mtimeWindowMs?: number;
  now?: () => number;
  // Resolve a session's workdir so RELATIVE artifact paths in the final message
  // (e.g. `sop/x.md`, `evidence/x.png` — how agents most often reference their
  // own outputs) can be made absolute against it. Without this, only absolute
  // /Users|/tmp paths are deliverable and every relative reference silently
  // drops (the sopmaster SOP漏发 incident). Returns null → relative paths are
  // skipped (absolute paths still work). Wired by bootstrap via BindingStore.
  resolveSessionWorkdir?: (sessionName: string) => Promise<string | null>;
};

type PathHit = {
  path: string;
  pos: number;
  // true = a workdir-relative path (sop/x.md); needs workdir to resolve.
  // false = an absolute /Users|/tmp path.
  relative: boolean;
};

type DeliverablePath = {
  realPath: string;
  flag: AutoFileDeliveryFlag;
};

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_MAX_FILES = 6;
const DEFAULT_MTIME_WINDOW_MS = 30 * 60 * 1000;

const PATH_RE = /(?:\/Users\/[^\s'"`)\]<>，。、；：！）】|]+|\/private\/tmp\/[^\s'"`)\]<>，。、；：！）】|]+|\/tmp\/[^\s'"`)\]<>，。、；：！）】|]+)/gu;
const TRAILING_PUNCTUATION_RE = /[.,;:、，。）)\]}>!！?？*`]+$/u;
const DELIVER_EXTS = new Set([
  "md", "markdown", "txt", "rtf", "pdf", "csv", "tsv", "xlsx", "xls",
  "docx", "doc", "pptx", "ppt", "html", "htm",
  "png", "jpg", "jpeg", "gif", "webp",
  "bmp", "svg", "zip", "mp4", "mov", "mp3", "m4a", "wav",
]);
// Relative artifact paths like `sop/x.md` or `evidence/shot.png`. Constrained
// to a deliverable extension at match time (keeps noise low — a bare `a/b` or a
// `scripts/x.py` won't match) and to NOT being preceded by a word/`/`/`.`/`~`
// char, so segments of an absolute path (/Users/LOCAL_USER/sop/x.md) are never
// re-matched here. Requires ≥1 directory segment; bare `x.md` is handled by
// BARE_PATH_RE below. Resolved against the source session's workdir downstream;
// then run through the SAME safety floor (allowlist + denylist + realpath +
// mtime + size) as absolute paths.
const REL_PATH_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.~/-])((?:[\\p{L}\\p{N}_.-]+/)+[\\p{L}\\p{N}_.-]+\\.(?:${[...DELIVER_EXTS].join("|")}))`,
  "giu",
);
const BARE_PATH_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.~/-])([\\p{L}\\p{N}_.-]+\\.(?:${[...DELIVER_EXTS].join("|")}))`,
  "giu",
);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "mov"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "wav"]);
const SENSITIVE = [
  ".env", "/.ssh/", "id_rsa", ".pem", ".pub", ".key", "/.aws/", "credential",
  "secret", "password", "/library/keychains", ".sqlite", ".db", "/.config/",
  "/.git/", "apikey", "api_key", "token", ".p12", ".keystore", ".netrc",
];
const ALLOW_ROOTS = [
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/",
  "/Users/LOCAL_USER/SuperMatrix/",
  "/Users/LOCAL_USER/CodexProjects/",
  "/Users/LOCAL_USER/CodexSkills/",
  "/tmp/",
  "/private/tmp/",
  "/private/var/folders/",
];

const NEG_PTR_RE = /((?:^|（|\()source[:：]|(?:^|（|\()位置[:：]|(?:^|（|\()来源[:：]|^见|\s见\s|详见|参见|Read\s|located|比如|例如|e\.g\.|示例|样例|(?:^|（|\()input[:：]|(?:^|（|\()输入[:：]|(?:^|（|\()description[:：])/imu;
const PATH_LABEL_PTR_RE = /(路径是|路径[:：])/iu;
const PATH_LABEL_DELIVERY_CONTEXT_RE = /(已写好|写好|已更新|更新了|新写|新建|生成|产出|输出|保存|落在|完成|交付|plan|spec|sop|文档|报告|created|updated|generated|wrote|saved)/iu;

export function createAutoFileDelivery(deps: AutoFileDeliveryDeps): AutoFileDelivery {
  const enabled = deps.enabled ?? readEnabledEnv();
  const maxBytes = deps.maxBytes ?? readPositiveIntEnv("SM_AUTODELIVER_MAX_BYTES", DEFAULT_MAX_BYTES);
  const maxFiles = deps.maxFiles ?? readPositiveIntEnv("SM_AUTODELIVER_MAX_FILES", DEFAULT_MAX_FILES);
  const mtimeWindowMs =
    deps.mtimeWindowMs ?? readPositiveIntEnv("SM_AUTODELIVER_MTIME_WINDOW_MS", DEFAULT_MTIME_WINDOW_MS);
  const now = deps.now ?? (() => Date.now());

  return {
    async deliver(input) {
      if (!enabled || maxFiles <= 0) return;
      const sinceMs = input.runStartedAtMs ?? now() - mtimeWindowMs;
      // Resolve the source session's workdir so relative artifact paths can be
      // made absolute. Best-effort: a failure (or no resolver) just means
      // relative paths are skipped — absolute paths still deliver.
      let workdir: string | undefined;
      if (deps.resolveSessionWorkdir) {
        try {
          workdir = (await deps.resolveSessionWorkdir(input.sessionName)) ?? undefined;
        } catch {
          workdir = undefined;
        }
      }
      const deliverables = await resolveDeliverablePaths(input.finalMessage, {
        sinceMs,
        maxBytes,
        maxFiles,
        ...(workdir !== undefined ? { workdir } : {}),
      });
      for (const [idx, item] of deliverables.entries()) {
        try {
          await deps.sendFile({
            groupId: input.groupId,
            absolutePath: item.realPath,
            flag: item.flag,
            idempotencyKey: buildIdempotencyKey(input.sessionName, input.runId, item.realPath, idx),
          });
        } catch {
          // Auto delivery is best-effort; the final message has already landed.
        }
      }
    },
  };
}

export async function resolveDeliverablePaths(
  text: string,
  opts: { sinceMs: number; maxBytes?: number; maxFiles?: number; workdir?: string },
): Promise<DeliverablePath[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const seen = new Set<string>();
  const out: DeliverablePath[] = [];

  for (const hit of extractPathHits(text)) {
    if (out.length >= maxFiles) break;
    const mdLink = isMarkdownLink(text, hit.pos, hit.path.length);
    // Relative hits must be resolved against the session workdir before any
    // safety check — without a workdir we cannot know what they point at, so
    // skip (never guess process.cwd(), it's the framework's, not the session's).
    let candidate = hit.path;
    if (hit.relative) {
      if (!opts.workdir) continue;
      candidate = resolvePath(opts.workdir, hit.path);
    }
    candidate = candidate.replace(/:\d+(?::\d+)?$/u, "");
    const ext = extensionOf(candidate);
    if (!ext || !DELIVER_EXTS.has(ext)) continue;
    if (!isSafePath(candidate)) continue;
    if (!mdLink && isReadPointerNear(text, hit.pos)) continue;

    let realPath: string;
    try {
      realPath = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isSafePath(realPath)) continue;
    if (seen.has(realPath)) continue;

    let fileStat;
    try {
      fileStat = await stat(realPath);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    if (!mdLink && fileStat.mtimeMs < opts.sinceMs) continue;
    if (fileStat.size > maxBytes) continue;

    seen.add(realPath);
    out.push({ realPath, flag: flagForExt(ext) });
  }

  return out;
}

export function extractPathHits(text: string): PathHit[] {
  const hits: PathHit[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const raw = match[0];
    const stripped = raw.replace(TRAILING_PUNCTUATION_RE, "");
    if (!stripped) continue;
    hits.push({ path: stripped, pos: match.index ?? 0, relative: false });
  }
  for (const match of text.matchAll(REL_PATH_RE)) {
    const stripped = match[1].replace(TRAILING_PUNCTUATION_RE, "");
    if (!stripped) continue;
    hits.push({ path: stripped, pos: match.index ?? 0, relative: true });
  }
  for (const match of text.matchAll(BARE_PATH_RE)) {
    const stripped = match[1].replace(TRAILING_PUNCTUATION_RE, "");
    if (!stripped) continue;
    hits.push({ path: stripped, pos: match.index ?? 0, relative: true });
  }
  return hits.sort((left, right) => left.pos - right.pos);
}

function extensionOf(pathname: string): string | undefined {
  const ext = extname(pathname).slice(1).toLowerCase();
  return ext || undefined;
}

function isSafePath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (SENSITIVE.some((needle) => lower.includes(needle))) return false;
  return ALLOW_ROOTS.some((root) => pathname.startsWith(root));
}

function isReadPointerNear(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const lineEndRaw = text.indexOf("\n", pos);
  const lineEnd = lineEndRaw >= 0 ? lineEndRaw : text.length;
  const window = text.slice(Math.max(lineStart, pos - 40), lineEnd);
  if (NEG_PTR_RE.test(window)) return true;
  if (!PATH_LABEL_PTR_RE.test(window)) return false;
  return !PATH_LABEL_DELIVERY_CONTEXT_RE.test(window);
}

function isMarkdownLink(text: string, pos: number, pathLen: number): boolean {
  const before8 = text.slice(Math.max(0, pos - 8), pos);
  const after5 = text.slice(pos + pathLen, pos + pathLen + 5);
  return /\]\(<?\s*$/u.test(before8) && /[>)]/u.test(after5);
}

function flagForExt(ext: string): AutoFileDeliveryFlag {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "file";
}

function buildIdempotencyKey(
  sessionName: string,
  runId: MessageRunId,
  realPath: string,
  index: number,
): string {
  // larkcli `--idempotency-key` maps to Feishu's IM message `uuid` field, which
  // REJECTS long values: empirically >~50 chars fail with code 99992402 and the
  // file send silently returns ok:false (larkcli footgun §3.9). The old key
  // inlined session + runId + hash + the FULL filename and sliced to 180 — for
  // a long png name that produced an 84-char key, so every such artifact was
  // dropped (the woniu screenshot漏发 incident). Keep the key compact: runId
  // (globally unique, kept readable for log tracing) + a short hash over the
  // identifying tuple. Stays ≤32 chars — well under the uuid cap — for any
  // filename length. NEVER inline the filename here again.
  const h = hashString(`${sessionName}\0${realPath}\0${index}`);
  return `ad-${sanitizeIdPart(runId)}-${h}`.slice(0, 32);
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/gu, "_");
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readEnabledEnv(): boolean {
  const raw = process.env["SM_AUTODELIVER_ENABLED"];
  if (raw === undefined || raw.trim() === "") return true;
  return !/^(0|false|off|no)$/iu.test(raw.trim());
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
