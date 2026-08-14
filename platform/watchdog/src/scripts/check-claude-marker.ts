import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

type StaticStatus = "patched" | "needs_repair" | "unknown";
type CheckStatus = "pass" | "repaired" | "fail";

type StaticCheck = {
  status: StaticStatus;
  hasMarkerNames: boolean;
  hasCnTimezoneMarkers: boolean;
  hasOldP8d: boolean;
  hasOldRYi: boolean;
  hasPatchedP8d: boolean;
  hasPatchedRYi: boolean;
  hasBadApostropheReturns: boolean;
  hasDateSlashReplace: boolean;
};

type DynamicCapture = {
  label: string;
  dateLine: string | null;
  ok: boolean;
  reason?: string;
  codePoints?: string[];
};

type MarkerCheckResult = {
  status: CheckStatus;
  claudeBin: string;
  versionFile: string;
  claudeVersion: string;
  staticCheck: StaticCheck;
  dynamic: DynamicCapture[];
  backupPath?: string;
  repaired?: boolean;
  error?: string;
};

const OLD_P8D = String.raw`function P8d(e,t){if(!e&&!t)return"'";if(e&&!t)return"\u2019";if(!e&&t)return"\u02BC";return"\u02B9"}`;
const PATCHED_P8D = String.raw`function P8d(e,t){return"'";/*xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx*/}`;
const OLD_RYI = String.raw`function RYi(e){let t=D8d(),n=P8d(t?.known??!1,t?.labKw??!1),r=t?.cnTZ?e.replaceAll("-","/"):e;return` + "`Today${n}s date is ${r}.`}";
const PATCHED_RYI = String.raw`function RYi(e){let n="'",r=e;/*xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx*/return` + "`Today${n}s date is ${r}.`}";

function assertEqualLength(oldText: string, newText: string): void {
  if (Buffer.byteLength(oldText) !== Buffer.byteLength(newText)) {
    throw new Error(`patch length mismatch for ${oldText.slice(0, 20)}`);
  }
}

export function locateClaude(): { claudeBin: string; versionFile: string; claudeVersion: string } {
  const claudeBin = execFileSync("which", ["claude"], { encoding: "utf-8", timeout: 10000 }).trim();
  const versionFile = realpathSync(claudeBin);
  const claudeVersion = execFileSync(claudeBin, ["--version"], { encoding: "utf-8", timeout: 10000 }).trim();
  return { claudeBin, versionFile, claudeVersion };
}

export function inspectClaudeVersionFile(versionFile: string): StaticCheck {
  const text = readFileSync(versionFile).toString("utf-8");
  const hasOldP8d = text.includes(OLD_P8D);
  const hasOldRYi = text.includes(OLD_RYI);
  const hasPatchedP8d = text.includes(PATCHED_P8D);
  const hasPatchedRYi = text.includes(PATCHED_RYI);
  const hasBadApostropheReturns =
    /return"\\u(?:2019|02BC|02B9)"/.test(text) || /return["'][\u2019\u02bc\u02b9]["']/.test(text);
  const hasDateSlashReplace = text.includes('replaceAll("-","/")');
  const hasMarkerNames = ["P8d", "RYi", "D8d"].every((marker) => text.includes(marker));
  const hasCnTimezoneMarkers = text.includes("Asia/Shanghai") && text.includes("Asia/Urumqi");
  const status: StaticStatus = hasPatchedP8d && hasPatchedRYi && !hasBadApostropheReturns && !hasDateSlashReplace
    ? "patched"
    : hasOldP8d && hasOldRYi
      ? "needs_repair"
      : "unknown";

  return {
    status,
    hasMarkerNames,
    hasCnTimezoneMarkers,
    hasOldP8d,
    hasOldRYi,
    hasPatchedP8d,
    hasPatchedRYi,
    hasBadApostropheReturns,
    hasDateSlashReplace,
  };
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function repairClaudeVersionFile(versionFile: string): string {
  assertEqualLength(OLD_P8D, PATCHED_P8D);
  assertEqualLength(OLD_RYI, PATCHED_RYI);
  const before = readFileSync(versionFile);
  const text = before.toString("utf-8");
  const backupPath = `${versionFile}.pre-marker-patch-${timestamp()}`;
  copyFileSync(versionFile, backupPath);
  const after = Buffer.from(patchClaudeMarkerText(text), "utf-8");
  if (after.length !== before.length) {
    throw new Error("patched file byte length changed; refusing to write");
  }
  writeFileSync(versionFile, after, { mode: 0o755 });
  execFileSync("codesign", ["--force", "--sign", "-", versionFile], {
    encoding: "utf-8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return backupPath;
}

export function patchClaudeMarkerText(text: string): string {
  assertEqualLength(OLD_P8D, PATCHED_P8D);
  assertEqualLength(OLD_RYI, PATCHED_RYI);
  if (!text.includes(OLD_P8D) || !text.includes(OLD_RYI)) {
    throw new Error("known old P8d/RYi marker fragments not found; refusing blind patch");
  }
  return text.replace(OLD_P8D, PATCHED_P8D).replace(OLD_RYI, PATCHED_RYI);
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function findDateLine(body: string): string | null {
  const matches = body.match(/Today[\u0027\u2019\u02bc\u02b9]s date is \d{4}[-/]\d{2}[-/]\d{2}\./g);
  return matches?.[0] ?? null;
}

function codePoints(value: string): string[] {
  return [...value].map((char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
}

function validateDateLine(label: string, body: string): DynamicCapture {
  const dateLine = findDateLine(body);
  if (!dateLine) return { label, dateLine: null, ok: false, reason: "date line missing" };
  const cps = codePoints(dateLine);
  const ok =
    /^Today's date is \d{4}-\d{2}-\d{2}\.$/.test(dateLine) &&
    cps.includes("U+0027") &&
    cps.includes("U+002D") &&
    !cps.some((cp) => ["U+2019", "U+02BC", "U+02B9"].includes(cp));
  return {
    label,
    dateLine,
    ok,
    codePoints: cps,
    ...(ok ? {} : { reason: "date line contains hidden marker apostrophe or slash date" }),
  };
}

function sendAnthropicResponse(body: string, res: ServerResponse): void {
  let stream = false;
  try {
    const parsed = JSON.parse(body) as { stream?: unknown };
    stream = parsed.stream === true;
  } catch {
    stream = false;
  }
  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const events = [
      ["message_start", {
        type: "message_start",
        message: {
          id: "msg_watchdog_marker_check",
          type: "message",
          role: "assistant",
          model: "claude-marker-check-local",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }],
      ["content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }],
      ["content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }],
      ["message_stop", { type: "message_stop" }],
    ] as const;
    for (const [event, data] of events) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_watchdog_marker_check",
    type: "message",
    role: "assistant",
    model: "claude-marker-check-local",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}

async function runOneDynamicCase(
  claudeBin: string,
  label: string,
  envPatch: Record<string, string>,
): Promise<DynamicCapture> {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const body = await collectBody(req);
    if (body) bodies.push(body);
    sendAnthropicResponse(body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local marker server did not expose a port");
  const port = address.port;
  try {
    const baseUrl = envPatch.ANTHROPIC_BASE_URL?.replace("<local-port>", String(port)) ?? `http://127.0.0.1:${port}`;
    const useLocalProxy = /\/\/deepseek(?::|\/)/.test(baseUrl);
    const proxyUrl = useLocalProxy ? `http://127.0.0.1:${port}` : "";
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: "watchdog-local-fake-key",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: "",
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: "",
      NO_PROXY: "",
      no_proxy: "",
      CLAUDE_CODE_SIMPLE: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...envPatch,
      ANTHROPIC_BASE_URL: baseUrl,
    };
    const result = await runClaudeForDynamicCheck(claudeBin, [
      "--bare",
      "-p", "reply ok",
      "--model", "claude-sonnet-4-5-20250929",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--tools", "",
    ], env);
    if (result.status !== 0) {
      return {
        label,
        dateLine: null,
        ok: false,
        reason: `claude local fake request failed: exit ${result.status}; stdout=${result.stdout.slice(0, 240)} stderr=${result.stderr.slice(0, 240)}`,
      };
    }
  } catch (err) {
    return { label, dateLine: null, ok: false, reason: `claude local fake request failed: ${(err as Error).message.slice(0, 180)}` };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const body = bodies.join("\n");
  return validateDateLine(label, body);
}

function runClaudeForDynamicCheck(
  claudeBin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 30000);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

export async function runDynamicChecks(claudeBin: string): Promise<DynamicCapture[]> {
  return [
    await runOneDynamicCase(claudeBin, "tz-asia-shanghai", {
      TZ: "Asia/Shanghai",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:<local-port>",
    }),
    await runOneDynamicCase(claudeBin, "lab-host-via-local-proxy", {
      TZ: "UTC",
      ANTHROPIC_BASE_URL: "http://deepseek:<local-port>",
    }),
  ];
}

export async function checkClaudeMarker(options: { repair: boolean; dynamic: boolean }): Promise<MarkerCheckResult> {
  const located = locateClaude();
  let staticCheck = inspectClaudeVersionFile(located.versionFile);
  let backupPath: string | undefined;
  let repaired = false;

  if (staticCheck.status === "needs_repair" && options.repair) {
    backupPath = repairClaudeVersionFile(located.versionFile);
    repaired = true;
    execFileSync(located.claudeBin, ["--version"], { encoding: "utf-8", timeout: 10000 });
    staticCheck = inspectClaudeVersionFile(located.versionFile);
  }

  const dynamic = options.dynamic ? await runDynamicChecks(located.claudeBin) : [];
  const dynamicOk = dynamic.every((item) => item.ok);
  const pass = staticCheck.status === "patched" && (!options.dynamic || dynamicOk);
  return {
    status: pass ? (repaired ? "repaired" : "pass") : "fail",
    ...located,
    staticCheck,
    dynamic,
    ...(backupPath ? { backupPath } : {}),
    ...(repaired ? { repaired } : {}),
    ...(!pass && staticCheck.status === "needs_repair" && !options.repair ? { error: "marker regression detected; rerun with --repair" } : {}),
  };
}

function parseArgs(argv: string[]): { repair: boolean; json: boolean; dynamic: boolean } {
  return {
    repair: argv.includes("--repair"),
    json: argv.includes("--json"),
    dynamic: !argv.includes("--static-only"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await checkClaudeMarker({ repair: args.repair, dynamic: args.dynamic });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Claude marker check: ${result.status}`);
    console.log(`- claude: ${result.claudeBin} -> ${result.versionFile}`);
    console.log(`- version: ${result.claudeVersion}`);
    console.log(`- static: ${result.staticCheck.status}`);
    for (const item of result.dynamic) {
      console.log(`- dynamic ${item.label}: ${item.ok ? "pass" : "fail"}${item.dateLine ? ` (${item.dateLine})` : ""}${item.reason ? ` - ${item.reason}` : ""}`);
    }
    if (result.backupPath) console.log(`- backup: ${result.backupPath}`);
    if (result.error) console.log(`- error: ${result.error}`);
  }
  if (result.status === "fail") process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? basename(import.meta.url)).href) {
  await main();
}
