import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, rename, rm, stat, lstat, realpath, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SqliteBindingStore } from "../adapters/store-sqlite/index.ts";
import { NodeWorkspaceFs } from "../adapters/workspace-node/index.ts";
import { createPinoLogger } from "../adapters/logger-pino/index.ts";
import { LarkCliGateway } from "../adapters/lark-cli/index.ts";
import { createRealLarkClient } from "../adapters/lark-cli/realClient.ts";
import { createSessionLifecycle, type SessionTableSyncMode } from "../app/sessionLifecycle.ts";
import type { SessionRuntimeSettingsSyncResult } from "../app/sessionRuntimeSettings.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp, type LarkGroupId } from "../domain/ids.ts";
import type { BackendKind } from "../domain/session.ts";
import type { LarkGateway } from "../ports/LarkGateway.ts";

const execFileAsync = promisify(execFile);
const ROOT_MANIFEST = path.resolve("config/onboarding-v1/platform-manifest.json");
const PERMISSION_MANIFEST = path.resolve("config/onboarding-v1/permissions.json");
const SKILLS_MANIFEST = path.resolve("config/onboarding-v1/skills.json");
const ASSET_PROVENANCE = path.resolve("config/onboarding-v1/asset-provenance.json");
const STATE_VERSION = 1;
export type OnboardingOptions = {
  sourceRoot: string;
  runtimeRoot: string;
  workspaceRoot: string;
  dbPath: string;
  profile: string;
  appId?: string | undefined;
  ownerOpenId?: string | undefined;
  backend: BackendKind;
  apiPort: number;
  schedulerPort: number;
  apply: boolean;
  verify: boolean;
  rollback: boolean;
  statePath?: string | undefined;
};

export type OnboardingChildEnvironment = {
  home: string;
  xdgConfigHome: string;
  codexHome: string;
  path: string;
  nodePath: string;
  npmPath: string;
  pythonPath: string;
  larkCliPath: string;
  backendPath: string;
};

type Role = {
  name: string;
  purpose: string;
  workdir: "source" | "workspace" | "module";
  modulePath?: string;
  run?: string;
  requiredFiles?: string[];
  env?: Record<string, string>;
  packagePaths?: string[];
};
type StateRole = Omit<Role, "workdir"> & {
  workdirKind: Role["workdir"];
  phase: "planned" | "group_created" | "session_ready";
  groupId?: string;
  sessionId?: string;
  workdir?: string;
  groupOwned?: boolean;
  sessionOwned?: boolean;
  modulePath?: string;
};
export type OnboardingState = {
  version: 1;
  installId: string;
  createdAt: string;
  profile: string;
  backend: BackendKind;
  appId: string;
  ownerOpenId: string;
  sourceRoot: string;
  runtimeRoot: string;
  workspaceRoot: string;
  dbPath: string;
  statePath: string;
  apiPort: number;
  schedulerPort: number;
  childEnv?: OnboardingChildEnvironment;
  instanceSecretSha256?: string;
  appSecretSha256?: string;
  schedulerSecretSha256?: string;
  servicePid?: number;
  schedulerPid?: number;
  profileIdentity?: { appId: string; ownerOpenId: string; botAppId?: string };
  rootGroupId?: string;
  roles: StateRole[];
  status: "planned" | "provisioning" | "configured" | "ready" | "live_verified" | "blocked" | "rolled_back";
  blocked?: string[];
};

export type LocalWatchOwnerReceipt = {
  version: 1;
  kind: "localwatch-owner";
  status: "active" | "stopped";
  pid: number;
  processStart: string;
  bootId: string;
  repoDir: string;
  scriptPath: string;
  cwd: string;
  installationNamespace: string;
  launcherPath: string;
  healthEndpoints: { api: string; scheduler: string };
  publishedAt: string;
  stoppedAt?: string;
};

export type LocalWatchProcessIdentity = Pick<LocalWatchOwnerReceipt, "pid" | "processStart" | "bootId" | "cwd"> & {
  command: string;
};

export type OnboardingWorkflowDeps = {
  gateway?: LarkGateway;
  startService?: (options: OnboardingOptions, state: OnboardingState, startPath: string) => Promise<number>;
  assetProvenancePath?: string;
};

type CliResult = {
  ok: boolean;
  verified?: boolean;
  data?: unknown;
  error?: { type?: string; subtype?: string; message?: string };
  raw: string;
};

function validateAbsolutePath(value: string, label: string): void {
  if (!value || !path.isAbsolute(value) || value.includes("\0") || path.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  if (value.split(path.sep).includes("..")) throw new Error(`${label} must not contain ..`);
}

function validateChildEnvironment(environment: OnboardingChildEnvironment, runtimeRoot: string): void {
  const expected = {
    home: path.join(runtimeRoot, "home"),
    xdgConfigHome: path.join(runtimeRoot, "xdg-config"),
    codexHome: path.join(runtimeRoot, "codex-home"),
  };
  for (const [name, value] of Object.entries(environment)) {
    if (name === "path") continue;
    validateAbsolutePath(value, `child environment ${name}`);
  }
  for (const entry of environment.path.split(path.delimiter)) validateAbsolutePath(entry, "child environment PATH entry");
  for (const key of ["home", "xdgConfigHome", "codexHome"] as const) {
    if (environment[key] !== expected[key]) throw new Error(`child environment ${key} must be ${expected[key]}`);
  }
}

function fallbackChildEnvironment(options: OnboardingOptions, state: OnboardingState): OnboardingChildEnvironment {
  const sourceBin = path.join(state.sourceRoot, "node_modules", ".bin");
  const nodeDir = path.dirname(process.execPath);
  return {
    home: path.join(state.runtimeRoot, "home"),
    xdgConfigHome: path.join(state.runtimeRoot, "xdg-config"),
    codexHome: path.join(state.runtimeRoot, "codex-home"),
    path: process.env.PATH ?? `${nodeDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    nodePath: process.execPath,
    npmPath: process.env.SM_ONBOARD_NPM ?? path.join(nodeDir, "npm"),
    pythonPath: process.env.SM_ONBOARD_PYTHON ?? path.join("/usr", "bin", "python3"),
    larkCliPath: process.env.SM_LARK_CLI_PATH ?? path.join(sourceBin, "lark-cli"),
    backendPath: process.env[`SM_${options.backend.toUpperCase()}_CLI_PATH`] ?? path.join(sourceBin, options.backend),
  };
}

function childProcessEnv(environment: OnboardingChildEnvironment): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (["CI", "LANG", "TERM", "TMP", "TEMP", "TMPDIR", "TZ"].includes(key)
      || key.startsWith("LC_")
      || key.startsWith("SM_ONBOARD_TEST_")
      || key.startsWith("TEST_")) {
      inherited[key] = value;
    }
  }
  return {
    ...inherited,
    HOME: environment.home,
    XDG_CONFIG_HOME: environment.xdgConfigHome,
    CODEX_HOME: environment.codexHome,
    PATH: environment.path,
    SM_ONBOARD_NODE: environment.nodePath,
    SM_ONBOARD_NPM: environment.npmPath,
    SM_ONBOARD_PYTHON: environment.pythonPath,
    SM_LARK_CLI_PATH: environment.larkCliPath,
    SM_CLAUDE_CLI_PATH: environment.backendPath,
    SM_CODEX_CLI_PATH: environment.backendPath,
    SM_KIMI_CLI_PATH: environment.backendPath,
    LARK_CLI_NO_PROXY: "1",
  };
}

type AuthPreflight = {
  failures: string[];
  summary: Record<string, unknown>;
  userOpenId?: string;
  appSecret?: string;
  botAppId?: string;
};

export function parseOnboardingArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): OnboardingOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      values.set(arg.slice(2), argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--")) {
      flags.add(arg.slice(2));
    } else {
      throw new Error(`unknown onboarding argument: ${arg}`);
    }
  }
  const backend = values.get("backend") ?? env.SM_BACKEND ?? "codex";
  if (backend !== "claude" && backend !== "codex" && backend !== "kimi") {
    throw new Error(`unsupported backend: ${backend}`);
  }
  const sourceRoot = path.resolve(values.get("source-root") ?? process.cwd());
  const runtimeRoot = path.resolve(
    values.get("runtime-root")
      ?? env.SM_ONBOARD_RUNTIME_ROOT
      ?? path.join(os.homedir(), "SuperMatrixRuntime-onboarding-v1"),
  );
  const workspaceRoot = path.resolve(values.get("workspace-root") ?? path.join(runtimeRoot, "workspaces"));
  const dbPath = path.resolve(values.get("db") ?? path.join(runtimeRoot, "data", "supermatrix.db"));
  const apiPort = Number(values.get("port") ?? env.SM_API_PORT ?? "3511");
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) {
    throw new Error("--port must be an integer in 1024..65535");
  }
  const schedulerPort = Number(values.get("scheduler-port") ?? env.SM_SCHEDULER_PORT ?? String(apiPort + 1));
  if (!Number.isInteger(schedulerPort) || schedulerPort < 1024 || schedulerPort > 65535 || schedulerPort === apiPort) {
    throw new Error("--scheduler-port must be an integer in 1024..65535 and differ from --port");
  }
  if (flags.has("apply") && flags.has("rollback")) throw new Error("--apply and --rollback are mutually exclusive");
  if (flags.has("apply") && flags.has("verify")) throw new Error("--apply and --verify are mutually exclusive");
  return {
    sourceRoot,
    runtimeRoot,
    workspaceRoot,
    dbPath,
    profile: values.get("profile") ?? env.SM_ONBOARD_PROFILE ?? "onboarding-v1",
    ...(values.get("app-id") ? { appId: values.get("app-id") } : {}),
    ...(values.get("owner-open-id") ? { ownerOpenId: values.get("owner-open-id") } : {}),
    backend: backend as BackendKind,
    apiPort,
    schedulerPort,
    apply: flags.has("apply"),
    verify: flags.has("verify"),
    rollback: flags.has("rollback"),
    ...(values.get("state") ? { statePath: path.resolve(values.get("state") as string) } : {}),
  };
}

export function resolveStatePath(options: Pick<OnboardingOptions, "runtimeRoot" | "statePath">): string {
  return options.statePath ?? path.join(options.runtimeRoot, "onboarding-v1", "state.json");
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`symlink path is not allowed: ${target}`);
      const existing = await stat(cursor);
      if (!existing.isDirectory() && cursor !== absolute) {
        throw new Error(`path parent is not a directory: ${cursor}`);
      }
      const root = await realpath(cursor);
      return path.join(root, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`cannot resolve path: ${target}`);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function validatePathLayout(options: Pick<OnboardingOptions, "sourceRoot" | "runtimeRoot" | "workspaceRoot" | "dbPath" | "statePath">): void {
  const sourceRoot = path.resolve(options.sourceRoot);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const dbPath = path.resolve(options.dbPath);
  const statePath = path.resolve(resolveStatePath(options));
  if (isWithin(sourceRoot, runtimeRoot) || isWithin(runtimeRoot, sourceRoot)) {
    throw new Error("source root and onboarding runtime root must be disjoint");
  }
  if (!isWithin(runtimeRoot, workspaceRoot)) throw new Error("workspace root must be inside runtime root");
  if (!isWithin(runtimeRoot, dbPath)) throw new Error("database path must be inside runtime root");
  if (!isWithin(runtimeRoot, statePath)) throw new Error("state path must be inside runtime root");
  if (path.basename(dbPath).startsWith(".")) throw new Error("database path must be a named database file");
}

async function normalizeOptions(options: OnboardingOptions): Promise<OnboardingOptions> {
  validatePathLayout(options);
  const sourceRoot = await canonicalPath(options.sourceRoot);
  const runtimeRoot = await canonicalPath(options.runtimeRoot);
  const workspaceRoot = await canonicalPath(options.workspaceRoot);
  const dbPath = await canonicalPath(options.dbPath);
  const statePath = await canonicalPath(resolveStatePath(options));
  const normalized = { ...options, sourceRoot, runtimeRoot, workspaceRoot, dbPath, statePath };
  validatePathLayout(normalized);
  return normalized;
}

export function redact(text: string): string {
  return text
    .replace(/(["'])(app[_-]?secret|access[_-]?token|refresh[_-]?token|device[_-]?code|authorization|LARK_APP_SECRET|SM_INTERNAL_[A-Z0-9_]+)\1(\s*:\s*)(["'])[^"']*\4/giu, "$1$2$1$3$4[redacted]$4")
    .replace(/(app[_-]?secret|access[_-]?token|refresh[_-]?token|device[_-]?code|authorization|LARK_APP_SECRET|SM_INTERNAL_[A-Z0-9_]+)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'}]+)/giu, "$1$2[redacted]");
}

export async function runCli(
  cliPath: string,
  profile: string,
  args: string[],
  timeoutMs = 15_000,
  environment?: OnboardingChildEnvironment,
): Promise<CliResult> {
  try {
    const result = await execFileAsync(cliPath, ["--profile", profile, ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: environment ? childProcessEnv(environment) : { ...process.env, LARK_CLI_NO_PROXY: "1" },
    });
    const raw = redact(result.stdout);
    const parsed = JSON.parse(result.stdout) as CliResult;
    return { ...parsed, ok: true, raw };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const raw = redact(e.stdout ?? e.stderr ?? e.message ?? String(error));
    try {
      const parsed = JSON.parse(e.stdout ?? "") as CliResult;
      const exitCode = typeof e.code === "number" ? e.code : undefined;
      return { ...parsed, ok: parsed.ok === true || exitCode === 0, raw };
    } catch {
      return { ok: false, error: { type: e.code === "ETIMEDOUT" ? "timeout" : "cli" }, raw };
    }
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number; interactive?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const interactive = options.interactive === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? { ...process.env, LARK_CLI_NO_PROXY: "1" },
      stdio: [interactive ? "inherit" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (interactive) output.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (interactive) process.stderr.write(chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 30_000}ms`));
    }, options.timeoutMs ?? 30_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (!interactive) {
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    }
  });
}

async function promptSecret(label: string): Promise<string | undefined> {
  if (!input.isTTY || !output.isTTY) return undefined;
  const terminalInput = input as typeof input & { setRawMode?: (mode: boolean) => void };
  output.write(`${label}: `);
  terminalInput.setRawMode?.(true);
  terminalInput.resume();
  return await new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (text === "\u0003") {
        terminalInput.setRawMode?.(false);
        terminalInput.off("data", onData);
        output.write("\n");
        resolve(undefined);
        return;
      }
      if (text.includes("\r") || text.includes("\n")) {
        terminalInput.setRawMode?.(false);
        terminalInput.off("data", onData);
        output.write("\n");
        resolve(value);
      } else if (text === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += text;
      }
    };
    terminalInput.on("data", onData);
  });
}

async function promptLine(label: string): Promise<string | undefined> {
  if (!input.isTTY || !output.isTTY) return undefined;
  const rl = createInterface({ input, output });
  try { return (await rl.question(`${label}: `)).trim() || undefined; } finally { rl.close(); }
}

async function commandVersion(command: string, environment?: OnboardingChildEnvironment): Promise<{ ok: boolean; version: string }> {
  try {
    const result = await execFileAsync(command, ["--version"], {
      timeout: 5_000,
      maxBuffer: 1_000_000,
      ...(environment ? { env: childProcessEnv(environment) } : {}),
    });
    return { ok: true, version: redact(result.stdout.trim() || result.stderr.trim()) };
  } catch (error) {
    return { ok: false, version: redact(error instanceof Error ? error.message : String(error)) };
  }
}

async function resolveExecutable(command: string, label: string): Promise<string> {
  if (path.isAbsolute(command)) {
    validateAbsolutePath(command, label);
    return command;
  }
  const result = await execFileAsync("which", [command], { timeout: 5_000, maxBuffer: 100_000 });
  const resolved = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (!resolved) throw new Error(`${label} did not resolve to an absolute executable: ${command}`);
  validateAbsolutePath(resolved, label);
  return resolved;
}

async function captureChildEnvironment(options: OnboardingOptions): Promise<OnboardingChildEnvironment> {
  const nodePath = await resolveExecutable(process.env.SM_ONBOARD_NODE ?? process.execPath, "child environment nodePath");
  const npmPath = await resolveExecutable(process.env.SM_ONBOARD_NPM ?? "npm", "child environment npmPath");
  const pythonPath = await resolveExecutable(process.env.SM_ONBOARD_PYTHON ?? "python3", "child environment pythonPath");
  const larkCliPath = await resolveExecutable(
    process.env.SM_LARK_CLI_PATH ?? path.join(options.sourceRoot, "node_modules", ".bin", "lark-cli"),
    "child environment larkCliPath",
  );
  const backendPath = await resolveExecutable(
    process.env[`SM_${options.backend.toUpperCase()}_CLI_PATH`] ?? options.backend,
    `child environment ${options.backend}Path`,
  );
  const inheritedPath = process.env.SM_ONBOARD_PATH ?? process.env.PATH ?? "";
  const inheritedEntries = inheritedPath.split(path.delimiter);
  for (const entry of inheritedEntries) validateAbsolutePath(entry, "configured child environment PATH entry");
  const pathEntries = [...new Set([
    path.dirname(pythonPath),
    path.dirname(backendPath),
    path.dirname(nodePath),
    path.dirname(larkCliPath),
    ...inheritedEntries,
  ])];
  const environment: OnboardingChildEnvironment = {
    home: path.join(options.runtimeRoot, "home"),
    xdgConfigHome: path.join(options.runtimeRoot, "xdg-config"),
    codexHome: path.join(options.runtimeRoot, "codex-home"),
    path: pathEntries.join(path.delimiter),
    nodePath,
    npmPath,
    pythonPath,
    larkCliPath,
    backendPath,
  };
  validateChildEnvironment(environment, options.runtimeRoot);
  return environment;
}

async function assertWritableDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await access(target, fsConstants.W_OK);
}

export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => {
      server.close();
      reject(new Error(`port ${port} is already in use`));
    });
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

export function scopeList(manifest: { identities: Record<string, { required: string[] }> }): string[] {
  return [...new Set(Object.values(manifest.identities).flatMap((identity) => identity.required))].sort();
}

export function buildAuthLoginArgs(scopes: string[]): string[] {
  const requestedScopes = [...new Set(scopes)].sort().join(",");
  return ["auth", "login", "--no-wait", "--json", "--scope", requestedScopes];
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temp, filePath);
    await chmod(filePath, mode);
  } finally {
    await rm(temp, { force: true });
  }
}

async function writeTextAtomic(filePath: string, value: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { mode });
    await rename(temp, filePath);
    await chmod(filePath, mode);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function copyTree(source: string, destination: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error(`asset directory is not a real directory: ${source}`);
  try {
    const destinationInfo = await lstat(destination);
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()) {
      throw new Error(`onboarding destination is not a real directory: ${destination}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(destination, { recursive: true });
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink asset is not allowed: ${from}`);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      const existingDestination = await lstat(to).catch(() => undefined);
      if (existingDestination?.isSymbolicLink() || (existingDestination && !existingDestination.isFile())) {
        throw new Error(`onboarding destination is not a regular file: ${to}`);
      }
      const sourceFile = await lstat(from);
      if (sourceFile.isSymbolicLink() || !sourceFile.isFile()) throw new Error(`asset entry is not a regular file: ${from}`);
      const mode = sourceFile.mode & 0o777;
      await writeFile(to, await readFile(from), { mode });
      await chmod(to, mode);
    } else throw new Error(`unsupported asset entry: ${from}`);
  }
}

function includePatternMatches(relativePath: string, pattern: string): boolean {
  const relative = relativePath.replaceAll(path.sep, "/");
  const normalized = pattern.replaceAll(path.sep, "/");
  if (normalized === "**" || normalized === relative) return true;
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3).replace(/\/$/u, "");
    return relative === prefix || relative.startsWith(`${prefix}/`);
  }
  return false;
}

function includePatternMayContain(relativePath: string, pattern: string): boolean {
  const relative = relativePath.replaceAll(path.sep, "/");
  const normalized = pattern.replaceAll(path.sep, "/");
  if (normalized === "**" || normalized === relative || normalized.startsWith(`${relative}/`)) return true;
  if (!normalized.endsWith("/**")) return false;
  const prefix = normalized.slice(0, -3).replace(/\/$/u, "");
  return relative === prefix || prefix.startsWith(`${relative}/`) || relative.startsWith(`${prefix}/`);
}

async function copyTreeSelected(source: string, destination: string, include: string[], relativeRoot = ""): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error(`asset directory is not a real directory: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const relative = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlink asset is not allowed: ${from}`);
    if (entry.isDirectory()) {
      if (include.some((pattern) => includePatternMayContain(relative, pattern))) {
        await copyTreeSelected(from, to, include, relative);
      }
    } else if (entry.isFile() && include.some((pattern) => includePatternMatches(relative, pattern))) {
      const existingDestination = await lstat(to).catch(() => undefined);
      if (existingDestination?.isSymbolicLink() || (existingDestination && !existingDestination.isFile())) {
        throw new Error(`onboarding destination is not a regular file: ${to}`);
      }
      const fileInfo = await lstat(from);
      const mode = fileInfo.mode & 0o777;
      await writeFile(to, await readFile(from), { mode });
      await chmod(to, mode);
    } else if (!entry.isFile()) {
      throw new Error(`unsupported asset entry: ${from}`);
    }
  }
}

type AssetProvenance = {
  version: 1;
  sources: {
    skills: { root: string; owner: "skill-master"; commit: string; files: Record<string, AssetDigest> };
    templates: { root: string; owner: "first-principle"; commit: string; files: Record<string, AssetDigest> };
  };
  modules?: ModuleProvenance[];
};

type AssetDigest = { bytes: number; sha256: string };

type ModuleProvenance = {
  name: string;
  owner: string;
  commit: string;
  sourceRoot: string;
  destinationRoot: string;
  reviewStatus?: string;
  include: string[];
  archiveSha256?: string;
  files?: Record<string, AssetDigest>;
};

async function resolvePublicSourceRoot(options: OnboardingOptions, relativeRoot: string): Promise<string> {
  const candidates = [path.join(options.sourceRoot, relativeRoot), path.resolve(options.sourceRoot, "..", relativeRoot)];
  for (const candidate of candidates) {
    if (await lstat(candidate).then((info) => info.isDirectory() && !info.isSymbolicLink()).catch(() => false)) return candidate;
  }
  throw new Error(`owner-approved public asset source is missing: ${relativeRoot}`);
}

async function validateAssetSources(options: OnboardingOptions, provenancePath = ASSET_PROVENANCE): Promise<string[]> {
  const failures: string[] = [];
  let provenance: AssetProvenance;
  try {
    provenance = await readJson<AssetProvenance>(provenancePath);
  } catch (error) {
    return [`asset provenance cannot be read: ${redact(error instanceof Error ? error.message : String(error))}`];
  }
  for (const [kind, source] of Object.entries(provenance.sources) as Array<["skills" | "templates", AssetProvenance["sources"]["skills"]]>) {
    let root: string;
    try { root = await resolvePublicSourceRoot(options, source.root); }
    catch (error) { failures.push(redact(error instanceof Error ? error.message : String(error))); continue; }
    for (const [relative, expected] of Object.entries(source.files)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
        failures.push(`${kind} asset path is unsafe: ${source.owner}/${relative}`);
        continue;
      }
      if (!Number.isInteger(expected.bytes) || expected.bytes < 0 || !/^[0-9a-f]{64}$/u.test(expected.sha256)) {
        failures.push(`${kind} asset digest schema is invalid: ${source.owner}/${relative}`);
        continue;
      }
      const file = path.join(root, relative);
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
        const bytes = await readFile(file);
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (info.size !== expected.bytes) failures.push(`${kind} asset byte count mismatch: ${source.owner}/${relative}`);
        if (actualHash !== expected.sha256) failures.push(`${kind} asset hash mismatch: ${source.owner}/${relative}`);
      } catch (error) {
        failures.push(`${kind} owner asset missing: ${source.owner}/${relative} (${redact(error instanceof Error ? error.message : String(error))})`);
      }
    }
  }
  return failures;
}

export function validateModuleProvenance(
  manifest: { publicRoles: Role[]; supportModules?: Role[] },
  provenance: Pick<AssetProvenance, "modules">,
): string[] {
  const failures: string[] = [];
  const expected = [...manifest.publicRoles, ...(manifest.supportModules ?? [])]
    .filter((role) => role.workdir === "module");
  const entries = provenance.modules ?? [];
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const role of expected) {
    const entry = byName.get(role.name);
    if (!entry) {
      failures.push(`module provenance is missing: ${role.name}`);
      continue;
    }
    if (entry.destinationRoot !== role.modulePath) failures.push(`module provenance destination mismatch: ${role.name}`);
    if (!/^[0-9a-f]{7,40}$/u.test(entry.commit)) failures.push(`module provenance commit is invalid: ${role.name}`);
    if (!entry.include.length) failures.push(`module provenance include is empty: ${role.name}`);
    for (const pattern of entry.include) {
      if (!pattern || path.isAbsolute(pattern) || pattern.split(/[\\/]/u).includes("..")) {
        failures.push(`module provenance include path is unsafe: ${role.name}/${pattern}`);
      }
    }
    if (entry.archiveSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(entry.archiveSha256)) {
      failures.push(`module provenance archive digest is invalid: ${role.name}`);
    }
    for (const [relative, digest] of Object.entries(entry.files ?? {})) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
        failures.push(`module provenance file path is unsafe: ${role.name}/${relative}`);
      }
      if (!Number.isInteger(digest.bytes) || digest.bytes < 0 || !/^[0-9a-f]{64}$/u.test(digest.sha256)) {
        failures.push(`module provenance file digest is invalid: ${role.name}/${relative}`);
      }
    }
  }
  for (const entry of entries) {
    if (!expected.some((role) => role.name === entry.name)) failures.push(`module provenance has no manifest entry: ${entry.name}`);
  }
  return [...new Set(failures)];
}

async function ensureBundledRuntime(options: OnboardingOptions, provenancePath = ASSET_PROVENANCE): Promise<void> {
  const provenance = await readJson<AssetProvenance>(provenancePath);
  const skillRoot = await resolvePublicSourceRoot(options, provenance.sources.skills.root);
  const templateRoot = await resolvePublicSourceRoot(options, provenance.sources.templates.root);
  const assets = path.join(options.runtimeRoot, "onboarding-v1", "assets");
  await mkdir(assets, { recursive: true });
  const skillFiles = Object.keys(provenance.sources.skills.files);
  const skillNames = [...new Set(skillFiles.map((file) => file.split(/[\\/]/u)[0]))];
  for (const name of skillNames) {
    const include = skillFiles
      .filter((file) => file.startsWith(`${name}/`))
      .map((file) => file.slice(name.length + 1));
    await copyTreeSelected(path.join(skillRoot, name), path.join(assets, "skills", name), include);
  }
  const templates = path.join(options.workspaceRoot, "first-principle", "templates");
  await mkdir(templates, { recursive: true });
  for (const name of Object.keys(provenance.sources.templates.files)) {
    await writeFile(path.join(templates, name), await readFile(path.join(templateRoot, name)));
  }
  for (const name of skillNames) {
    const include = skillFiles
      .filter((file) => file.startsWith(`${name}/`))
      .map((file) => file.slice(name.length + 1));
    await copyTreeSelected(path.join(skillRoot, name), path.join(options.runtimeRoot, "onboarding-v1", "skills", name), include);
  }

  const manifest = await readJson<{ supportModules?: Role[] }>(ROOT_MANIFEST);
  for (const role of manifest.supportModules ?? []) {
    if (role.workdir !== "module" || !role.modulePath) throw new Error(`support module ${role.name} has no modulePath`);
    const source = await resolveModuleSource(options, role.modulePath);
    const destination = path.join(options.runtimeRoot, "onboarding-v1", "modules", role.name);
    if (!await access(path.join(destination, ".onboarding-module"), fsConstants.R_OK).then(() => true).catch(() => false)) {
      const entry = (provenance.modules ?? []).find((candidate) => candidate.name === role.name);
      if (!entry) throw new Error(`support module provenance is missing: ${role.name}`);
      await copyTreeSelected(source, destination, entry.include);
      await writeTextAtomic(path.join(destination, ".onboarding-module"), `${role.name}\n`, 0o600);
    }
  }
}

async function resolveModuleSource(options: OnboardingOptions, modulePath: string): Promise<string> {
  const candidates = [
    path.join(options.sourceRoot, modulePath),
    path.resolve(options.sourceRoot, "..", modulePath),
  ];
  for (const candidate of candidates) {
    if (await stat(candidate).then((info) => info.isDirectory()).catch(() => false)) return candidate;
  }
  throw new Error(`public module source is missing: ${modulePath}; expected ${candidates.join(" or ")}`);
}

export async function validateManifestSources(options: OnboardingOptions, roles: Role[]): Promise<string[]> {
  const failures: string[] = [];
  for (const role of roles) {
    try {
      if (role.workdir === "module" && !role.modulePath) throw new Error("public module role has no modulePath");
      const source = role.workdir === "module"
        ? await resolveModuleSource(options, role.modulePath ?? "")
        : options.sourceRoot;
      const entrypointFailure = await validateRunContract(source, role.run, role.requiredFiles);
      if (entrypointFailure) failures.push(`${role.name} ${entrypointFailure}`);
    } catch (error) {
      failures.push(redact(error instanceof Error ? error.message : String(error)));
    }
  }
  return failures;
}

type InventoryDisposition = { name: string; disposition: string; of?: string };

export function validateManifestInventory(manifest: {
  publicRoles: Role[];
  supportModules?: Role[];
  inventory: { platformNames: string[]; distributionNames?: string[] };
  inventoryDisposition: InventoryDisposition[];
}): string[] {
  const failures: string[] = [];
  const roleNames = manifest.publicRoles.map((role) => role.name);
  const supportNames = (manifest.supportModules ?? []).map((role) => role.name);
  const inventoryNames = manifest.inventory.platformNames;
  const dispositionNames = manifest.inventoryDisposition.map((entry) => entry.name);
  const knownNames = new Set([...manifest.inventory.platformNames, ...(manifest.inventory.distributionNames ?? [])]);
  if (new Set(inventoryNames).size !== inventoryNames.length) failures.push("platform inventory contains duplicate names");
  if (new Set(dispositionNames).size !== dispositionNames.length) failures.push("platform inventory disposition contains duplicate names");
  for (const name of inventoryNames) {
    if (!dispositionNames.includes(name)) failures.push(`platform inventory has no disposition: ${name}`);
  }
  for (const entry of manifest.inventoryDisposition) {
    if (!knownNames.has(entry.name)) failures.push(`platform disposition is not in inventory: ${entry.name}`);
    if (entry.disposition === "public-export" && !roleNames.includes(entry.name)) {
      failures.push(`public-export inventory entry has no onboarding role: ${entry.name}`);
    }
    if (entry.disposition === "support-export" && !supportNames.includes(entry.name)) {
      failures.push(`support-export inventory entry has no support module: ${entry.name}`);
    }
  }
  for (const role of manifest.publicRoles) {
    const entry = manifest.inventoryDisposition.find((candidate) => candidate.name === role.name);
    if (!entry || entry.disposition !== "public-export") failures.push(`onboarding role is not public-export inventory: ${role.name}`);
  }
  return [...new Set(failures)];
}

async function validateRunContract(root: string, run: string | undefined, requiredFiles: string[] = []): Promise<string | undefined> {
  for (const requiredFile of requiredFiles) {
    if (!await access(path.join(root, requiredFile), fsConstants.R_OK).then(() => true).catch(() => false)) {
      return `public module required file is missing: ${requiredFile}`;
    }
  }
  if (!run) return undefined;
  const tokens = run.split(/\s+/u);
  const commandTokens = tokens.filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
  const pathToken = commandTokens.slice(1).find((token) => token.includes("/") && !token.startsWith("-"));
  if (pathToken && !await access(path.join(root, pathToken), fsConstants.R_OK).then(() => true).catch(() => false)) {
    return `public module entrypoint is missing: ${pathToken}`;
  }
  if (commandTokens[0] === "npm") {
    try {
      const prefixIndex = commandTokens.indexOf("--prefix");
      const packageRoot = prefixIndex >= 0 && commandTokens[prefixIndex + 1]
        ? path.join(root, commandTokens[prefixIndex + 1])
        : root;
      const packageJson = await readJson<{ scripts?: Record<string, unknown> }>(path.join(packageRoot, "package.json"));
      const commandIndex = prefixIndex >= 0 ? prefixIndex + 2 : 1;
      const scriptName = commandTokens[commandIndex] === "run" ? commandTokens[commandIndex + 1] : commandTokens[commandIndex];
      if (!scriptName || typeof packageJson.scripts?.[scriptName] !== "string") {
        return `public module has no npm script ${scriptName ?? "<missing>"} for ${run}`;
      }
    } catch {
      return `public module has no package.json for ${run}`;
    }
  }
  const isPythonCommand = commandTokens[0] === "python3" || commandTokens[0].endsWith("/python") || commandTokens[0].endsWith("\\python");
  if (isPythonCommand) {
    try {
      const pyproject = await readFile(path.join(root, "pyproject.toml"), "utf8");
      if (!/^\s*requires-python\s*=\s*["'][^"']+["']/mu.test(pyproject)) {
        return `public Python module has no requires-python metadata for ${run}`;
      }
      const version = (await readFile(path.join(root, ".python-version"), "utf8")).trim();
      if (version !== "3.11.15") return `public Python module requires .python-version=3.11.15, got ${version || "<missing>"}`;
    } catch {
      return `public Python module is missing pyproject.toml or .python-version for ${run}`;
    }
  }
  return undefined;
}

async function loadState(options: OnboardingOptions): Promise<OnboardingState | undefined> {
  try {
    const state = await readJson<OnboardingState>(resolveStatePath(options));
    if (!state || state.version !== STATE_VERSION || typeof state.installId !== "string" || !Array.isArray(state.roles)) {
      throw new Error(`invalid onboarding state at ${resolveStatePath(options)}`);
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error(`corrupt onboarding state at ${resolveStatePath(options)}`);
    throw error;
  }
}

async function saveState(options: OnboardingOptions, state: OnboardingState): Promise<void> {
  await writeJsonAtomic(resolveStatePath(options), state);
}

async function processCommand(pid: number): Promise<string> {
  const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 });
  return result.stdout.trim();
}

async function processStart(pid: number): Promise<string> {
  const result = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
    timeout: 5_000,
    env: { ...process.env, LC_ALL: "C" },
  });
  return result.stdout.trim().replace(/\s+/gu, " ");
}

async function processCwd(pid: number): Promise<string> {
  const result = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 5_000 });
  const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1).trim();
  if (!cwd) throw new Error(`process ${pid} cwd is unavailable`);
  return path.resolve(cwd);
}

async function currentBootId(): Promise<string | undefined> {
  try {
    const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (value) return value;
  } catch { /* macOS has no procfs boot id */ }
  try {
    const result = await execFileAsync("sysctl", ["-n", "kern.boottime"], { timeout: 5_000 });
    const value = result.stdout.trim();
    if (value) {
      const digest = createHash("md5").update(value).digest("hex");
      return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    }
  } catch { /* fail closed when the platform cannot expose boot identity */ }
  return undefined;
}

export async function readProcessIdentity(pid: number): Promise<LocalWatchProcessIdentity | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    const [command, processStartValue, cwd, bootId] = await Promise.all([
      processCommand(pid),
      processStart(pid),
      processCwd(pid),
      currentBootId(),
    ]);
    if (!command || !processStartValue || !cwd || !bootId) return undefined;
    return { pid, command, processStart: processStartValue, bootId, cwd };
  } catch {
    return undefined;
  }
}

type ProcessRecord = { pid: number; ppid: number; pgid: number; command: string };

async function processTable(): Promise<ProcessRecord[]> {
  const result = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { timeout: 5_000 });
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }];
  });
}

function isMissingProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code as string | number | undefined;
  return code === "ESRCH" || code === 1 || code === "1";
}

function descendantRecords(records: readonly ProcessRecord[], rootPid: number): ProcessRecord[] {
  const owned = new Map<number, ProcessRecord>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if ((record.pid === rootPid || owned.has(record.ppid)) && !owned.has(record.pid)) {
        owned.set(record.pid, record);
        changed = true;
      }
    }
  }
  return [...owned.values()];
}

async function waitForOwnedTreeExit(
  initial: readonly ProcessRecord[],
  pgid: number | undefined,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const records = await processTable();
    if (pgid && !records.some((record) => record.pgid === pgid)) return;
    const currentByPid = new Map(records.map((record) => [record.pid, record]));
    const alive = new Map<number, ProcessRecord>();
    for (const owned of initial) {
      const current = currentByPid.get(owned.pid);
      if (current && current.command === owned.command && current.pgid === owned.pgid) alive.set(current.pid, current);
    }
    let changed = true;
    while (!pgid && changed) {
      changed = false;
      for (const record of records) {
        if (alive.has(record.ppid) && !alive.has(record.pid)) {
          alive.set(record.pid, record);
          changed = true;
        }
      }
    }
    if (pgid ? !records.some((record) => record.pgid === pgid) : alive.size === 0) return;
    if (Date.now() >= deadline) throw new Error(`owned process tree did not exit after termination`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopOwnedProcessTree(pid: number | undefined, markers: readonly string[], label: string): Promise<void> {
  if (!pid) return;
  const records = await processTable();
  const root = records.find((entry) => entry.pid === pid);
  if (!root) return;
  const command = root.command;
  if (!markers.some((marker) => command.includes(marker))) {
    throw new Error(`${label} process ${pid} is not owned by this onboarding install`);
  }
  const pgid = root.pgid === root.pid ? root.pgid : undefined;
  const owned = pgid ? records.filter((entry) => entry.pgid === pgid) : descendantRecords(records, pid);
  if (!owned.length) return;
  try {
    if (pgid) process.kill(-pgid, "SIGTERM");
    else for (const entry of [...owned].sort((a, b) => b.pid - a.pid)) process.kill(entry.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  try {
    await waitForOwnedTreeExit(owned, pgid);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !/did not exit after termination/u.test(error.message)) throw error;
  }
  try {
    if (pgid) process.kill(-pgid, "SIGKILL");
    else for (const entry of [...owned].sort((a, b) => b.pid - a.pid)) process.kill(entry.pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  await waitForOwnedTreeExit(owned, pgid);
}

async function readPidFile(filePath: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(filePath, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readPidFileEventually(filePath: string, timeoutMs = 1_000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const pid = await readPidFile(filePath);
    if (pid) return pid;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function localwatchScriptPath(options: OnboardingOptions): string {
  return path.join(path.resolve(options.sourceRoot), "scripts", "localwatch.sh");
}

export function localwatchOwnerReceiptPath(options: OnboardingOptions): string {
  return path.join(path.resolve(options.runtimeRoot), "onboarding-v1", "owner-receipt.json");
}

function expectedOwnerReceipt(options: OnboardingOptions): Pick<LocalWatchOwnerReceipt, "repoDir" | "scriptPath" | "cwd" | "installationNamespace" | "launcherPath" | "healthEndpoints"> {
  const onboardingRoot = path.join(path.resolve(options.runtimeRoot), "onboarding-v1");
  return {
    repoDir: path.resolve(options.sourceRoot),
    scriptPath: localwatchScriptPath(options),
    cwd: path.resolve(options.sourceRoot),
    installationNamespace: onboardingRoot,
    launcherPath: path.join(onboardingRoot, "start.sh"),
    healthEndpoints: {
      api: `http://127.0.0.1:${options.apiPort}/api/health`,
      scheduler: `http://127.0.0.1:${options.schedulerPort}/health`,
    },
  };
}

function isOwnerReceipt(value: unknown): value is LocalWatchOwnerReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<LocalWatchOwnerReceipt>;
  return receipt.version === 1
    && receipt.kind === "localwatch-owner"
    && (receipt.status === "active" || receipt.status === "stopped")
    && Number.isInteger(receipt.pid) && (receipt.pid ?? 0) > 0
    && typeof receipt.processStart === "string" && receipt.processStart.length > 0
    && typeof receipt.bootId === "string" && receipt.bootId.length > 0
    && typeof receipt.repoDir === "string"
    && typeof receipt.scriptPath === "string"
    && typeof receipt.cwd === "string"
    && typeof receipt.installationNamespace === "string"
    && typeof receipt.launcherPath === "string"
    && typeof receipt.healthEndpoints?.api === "string"
    && typeof receipt.healthEndpoints?.scheduler === "string"
    && typeof receipt.publishedAt === "string";
}

export async function readLocalWatchOwnerReceipt(options: OnboardingOptions): Promise<LocalWatchOwnerReceipt | undefined> {
  try {
    const value = await readJson<unknown>(localwatchOwnerReceiptPath(options));
    return isOwnerReceipt(value) ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function ownerReceiptStaticFailures(options: OnboardingOptions, receipt: LocalWatchOwnerReceipt): Promise<string[]> {
  const expected = expectedOwnerReceipt(options);
  const failures: string[] = [];
  for (const key of ["repoDir", "scriptPath", "cwd", "installationNamespace", "launcherPath"] as const) {
    const [actualPath, expectedPath] = await Promise.all([canonicalPath(receipt[key]).catch(() => path.resolve(receipt[key])), canonicalPath(expected[key]).catch(() => path.resolve(expected[key]))]);
    if (actualPath !== expectedPath) failures.push(`LocalWatch owner receipt ${key} mismatch`);
  }
  for (const key of ["api", "scheduler"] as const) {
    if (receipt.healthEndpoints[key] !== expected.healthEndpoints[key]) failures.push(`LocalWatch owner receipt ${key} health endpoint mismatch`);
  }
  return failures;
}

async function readCurrentLocalWatchOwner(options: OnboardingOptions): Promise<{ receipt: LocalWatchOwnerReceipt; identity?: LocalWatchProcessIdentity } | undefined> {
  const receipt = await readLocalWatchOwnerReceipt(options);
  if (!receipt || receipt.status !== "active" || (await ownerReceiptStaticFailures(options, receipt)).length) return undefined;
  const identity = await readProcessIdentity(receipt.pid);
  if (!identity) return undefined;
  const receiptCwd = await canonicalPath(receipt.cwd).catch(() => path.resolve(receipt.cwd));
  if (identity.processStart !== receipt.processStart || identity.bootId !== receipt.bootId || identity.cwd !== receiptCwd) return undefined;
  const [scriptPath, launcherPath] = await Promise.all([
    canonicalPath(receipt.scriptPath).catch(() => path.resolve(receipt.scriptPath)),
    canonicalPath(receipt.launcherPath).catch(() => path.resolve(receipt.launcherPath)),
  ]);
  if (![receipt.scriptPath, receipt.launcherPath, scriptPath, launcherPath].some((candidate) => identity.command.includes(candidate))) return undefined;
  return { receipt, identity };
}

async function readCurrentLocalWatchOwnerEventually(options: OnboardingOptions, timeoutMs = 1_000): Promise<{ receipt: LocalWatchOwnerReceipt; identity?: LocalWatchProcessIdentity } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const owner = await readCurrentLocalWatchOwner(options);
    if (owner) return owner;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readOwnerReceiptForRollback(options: OnboardingOptions): Promise<{ receipt: LocalWatchOwnerReceipt; identity?: LocalWatchProcessIdentity }> {
  const receipt = await readLocalWatchOwnerReceipt(options);
  if (!receipt) throw new Error(`rollback stopped: LocalWatch owner receipt is missing: ${localwatchOwnerReceiptPath(options)}`);
  const staticFailures = await ownerReceiptStaticFailures(options, receipt);
  if (staticFailures.length) throw new Error(`rollback stopped: ${staticFailures.join("; ")}`);
  const identity = await readProcessIdentity(receipt.pid);
  if (!identity) return { receipt };
  const receiptCwd = await canonicalPath(receipt.cwd).catch(() => path.resolve(receipt.cwd));
  if (identity.processStart !== receipt.processStart || identity.bootId !== receipt.bootId || identity.cwd !== receiptCwd) {
    throw new Error(`rollback stopped: LocalWatch owner PID ${receipt.pid} has been reused or changed`);
  }
  const [scriptPath, launcherPath] = await Promise.all([
    canonicalPath(receipt.scriptPath).catch(() => path.resolve(receipt.scriptPath)),
    canonicalPath(receipt.launcherPath).catch(() => path.resolve(receipt.launcherPath)),
  ]);
  if (![receipt.scriptPath, receipt.launcherPath, scriptPath, launcherPath].some((candidate) => identity.command.includes(candidate))) {
    throw new Error(`rollback stopped: LocalWatch owner PID ${receipt.pid} command identity mismatch`);
  }
  return { receipt, identity };
}

export async function isOwnedHealthyInstance(options: OnboardingOptions, state: OnboardingState): Promise<boolean> {
  if (!["ready", "live_verified"].includes(state.status)) return false;
  if (state.profile !== options.profile
    || state.backend !== options.backend
    || state.sourceRoot !== path.resolve(options.sourceRoot)
    || state.runtimeRoot !== path.resolve(options.runtimeRoot)
    || state.workspaceRoot !== path.resolve(options.workspaceRoot)
    || state.dbPath !== path.resolve(options.dbPath)
    || state.apiPort !== options.apiPort
    || state.schedulerPort !== options.schedulerPort) return false;
  try {
    const owner = await readCurrentLocalWatchOwner(options);
    if (!owner) return false;
    const healthy = async (url: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try { return await fetch(url, { signal: controller.signal }); }
      finally { clearTimeout(timer); }
    };
    const [api, scheduler] = await Promise.all([
      healthy(owner.receipt.healthEndpoints.api),
      healthy(owner.receipt.healthEndpoints.scheduler),
    ]);
    if (!api.ok || !scheduler.ok) return false;
    // The LocalWatch receipt is the durable owner identity. The listeners
    // normally belong to supervisor children, so checking lsof ownership here
    // would reject a healthy owned instance.
    return true;
  } catch {
    return false;
  }
}

async function localPreflight(
  options: OnboardingOptions,
  requireFreePort = true,
  createDirs = true,
  existing?: OnboardingState,
  provenancePath = ASSET_PROVENANCE,
): Promise<string[]> {
  const failures: string[] = [];
  try {
    validatePathLayout(options);
    await canonicalPath(options.sourceRoot);
    await canonicalPath(options.runtimeRoot);
    await canonicalPath(options.workspaceRoot);
    await canonicalPath(options.dbPath);
  } catch (error) {
    failures.push(`onboarding path isolation failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  try {
    await access(options.sourceRoot, fsConstants.R_OK);
  } catch {
    failures.push(`source root is not readable: ${options.sourceRoot}`);
  }
  try {
    if (createDirs) {
      await assertWritableDirectory(options.runtimeRoot);
      await assertWritableDirectory(options.workspaceRoot);
      await assertWritableDirectory(path.dirname(options.dbPath));
    } else {
      await Promise.all([options.runtimeRoot, options.workspaceRoot, path.dirname(options.dbPath)].map((target) => access(target, fsConstants.R_OK | fsConstants.W_OK)));
    }
  } catch (error) {
    failures.push(`onboarding paths are not writable: ${error instanceof Error ? error.message : String(error)}`);
  }
  failures.push(...await validateAssetSources(options, provenancePath));
  for (const manifest of [ROOT_MANIFEST, PERMISSION_MANIFEST, SKILLS_MANIFEST, ASSET_PROVENANCE]) {
    try { await access(manifest, fsConstants.R_OK); } catch { failures.push(`onboarding manifest is missing: ${manifest}`); }
  }
  try {
    const manifest = await readJson<{ publicRoles: Role[]; supportModules?: Role[]; inventory: { platformNames: string[]; distributionNames?: string[] }; inventoryDisposition: InventoryDisposition[] }>(ROOT_MANIFEST);
    failures.push(...validateManifestInventory(manifest));
    const provenance = await readJson<AssetProvenance>(provenancePath);
    failures.push(...validateModuleProvenance(manifest, provenance));
    failures.push(...await validateManifestSources(options, [...manifest.publicRoles, ...(manifest.supportModules ?? [])]));
  } catch (error) {
    failures.push(`platform manifest cannot be validated: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  if (requireFreePort && !(existing && await isOwnedHealthyInstance(options, existing))) {
    try {
      await assertPortAvailable(options.apiPort);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await assertPortAvailable(options.schedulerPort);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

function profileWasNotFound(result: { stdout: string; stderr: string }): boolean {
  return /not_configured|profile\s+["']?[^"'\s]+["']?\s+not found/iu.test(`${result.stdout}\n${result.stderr}`);
}

function appIdFromText(text: string): string | undefined {
  return text.match(/\bcli_[A-Za-z0-9_-]+\b/u)?.[0];
}

export async function ensureProfile(
  cli: string,
  options: OnboardingOptions,
  environment?: OnboardingChildEnvironment,
): Promise<{ appId?: string; appSecret?: string; failure?: string }> {
  const selected = await runProcess(cli, ["--profile", options.profile, "config", "show"], { timeoutMs: 10_000, ...(environment ? { env: childProcessEnv(environment) } : {}) });
  if (selected.code === 0) return {};
  if (!profileWasNotFound(selected)) {
    return { failure: `lark-cli isolated profile probe failed: ${redact(selected.stderr || selected.stdout)}` };
  }

  if (!options.appId) {
    const initialized = await runProcess(cli, ["config", "init", "--new", "--name", options.profile], {
      timeoutMs: 120_000,
      interactive: true,
      ...(environment ? { env: childProcessEnv(environment) } : {}),
    });
    if (initialized.code !== 0) {
      return {
        failure: `lark-cli config init --new --name ${options.profile} failed: ${redact(initialized.stderr || initialized.stdout)}`,
      };
    }
    const appSecret = process.env.SM_ONBOARD_APP_SECRET ?? await promptSecret(
      "Enter the new isolated Lark app secret for the runtime (hidden; config init does not expose it to the SDK)",
    );
    if (!appSecret) {
      return {
        failure: `profile ${options.profile} was created by lark-cli config init --new, but its app secret is not exposed to the SDK; enter it at the prompt or set SM_ONBOARD_APP_SECRET`,
      };
    }
    const appId = appIdFromText(`${initialized.stdout}\n${initialized.stderr}`);
    return { ...(appId ? { appId } : {}), appSecret };
  }

  const appId = options.appId;
  if (!appId) return { failure: `profile ${options.profile} does not exist; supply an isolated app ID and create it with lark-cli profile add` };
  const appSecret = await promptSecret("Enter the isolated Lark app secret (hidden)");
  if (!appSecret) return { failure: `profile ${options.profile} is missing; an isolated app secret is required once to create it` };
  const added = await runProcess(cli, [
    "profile", "add", "--name", options.profile, "--app-id", appId, "--app-secret-stdin",
  ], { input: `${appSecret}\n`, timeoutMs: 30_000, ...(environment ? { env: childProcessEnv(environment) } : {}) });
  if (added.code !== 0) return { failure: `lark-cli profile add failed: ${redact(added.stderr || added.stdout)}` };
  return { appId, appSecret };
}

function authChallenge(result: CliResult): { verificationUrl?: string; deviceCode?: string } {
  const data = resultPayload(result);
  const verificationUrl = [data.verificationUrl, data.verification_url, data.url]
    .find((value): value is string => typeof value === "string" && /^https?:\/\//u.test(value));
  const deviceCode = [data.deviceCode, data.device_code]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return { ...(verificationUrl ? { verificationUrl } : {}), ...(deviceCode ? { deviceCode } : {}) };
}

async function startUserAuthorization(cli: string, options: OnboardingOptions, scopes: string[], summary: Record<string, unknown>, environment?: OnboardingChildEnvironment): Promise<string | undefined> {
  const login = await runCli(cli, options.profile, buildAuthLoginArgs(scopes), 20_000, environment);
  const challenge = authChallenge(login);
  if (challenge.verificationUrl) {
    summary.authorization = { verificationUrl: challenge.verificationUrl, qr: "generated by lark-cli; not persisted" };
    if (input.isTTY && output.isTTY && challenge.deviceCode) {
      try {
        const qr = await execFileAsync(cli, ["--profile", options.profile, "auth", "qrcode", challenge.verificationUrl, "--ascii"], {
          timeout: 15_000, maxBuffer: 1_000_000,
          ...(environment ? { env: childProcessEnv(environment) } : {}),
        });
        output.write(`\nOpen this Lark authorization link or scan the QR code:\n${challenge.verificationUrl}\n${qr.stdout}\n`);
      } catch {
        output.write(`\nOpen this Lark authorization link:\n${challenge.verificationUrl}\n`);
      }
      await promptLine("After approving the isolated app, press Enter to continue");
      const completed = await runCli(cli, options.profile, ["auth", "login", "--device-code", challenge.deviceCode, "--json"], 120_000, environment);
      if (!completed.ok) return "user authorization did not complete after the approval prompt";
      return undefined;
    }
    return "user authorization is pending; open the returned verification URL and rerun onboarding";
  }
  return "lark-cli auth login did not return a verification URL/device code";
}

async function authPreflight(options: OnboardingOptions, appId: string | undefined, environment: OnboardingChildEnvironment): Promise<AuthPreflight> {
  const cli = environment.larkCliPath;
  const failures: string[] = [];
  const summary: Record<string, unknown> = { profile: options.profile, cliPath: cli };
  const version = await commandVersion(cli, environment);
  summary.cliVersion = version.version;
  if (!version.ok) failures.push(`lark-cli unavailable: ${version.version}`);

  let createdAppSecret: string | undefined;
  if (version.ok) {
    const profile = await ensureProfile(cli, options, environment);
    if (profile.failure) failures.push(profile.failure);
    if (profile.appId) summary.appId = profile.appId;
    createdAppSecret = profile.appSecret;
  }

  const userStatus = await runCli(cli, options.profile, ["auth", "status", "--json", "--verify"], 15_000, environment);
  summary.userStatus = sanitizeAuthStatus(userStatus);
  if (!userStatus.ok || userStatus.verified !== true) {
    const permissionManifest = await readJson<{ identities: Record<string, { required: string[] }> }>(PERMISSION_MANIFEST);
    const requiredUserScopes = permissionManifest.identities.user?.required ?? [];
    const authorizationFailure = await startUserAuthorization(cli, options, requiredUserScopes, summary, environment);
    if (authorizationFailure) failures.push(authorizationFailure);
  }

  const botStatus = await runCli(cli, options.profile, ["whoami", "--as", "bot"], 15_000, environment);
  summary.botStatus = sanitizeAuthStatus(botStatus);
  const botIdentity = identityFromPayload(resultPayload(botStatus));
  if (botIdentity.appId) summary.botAppId = botIdentity.appId;
  if (!botStatus.ok || !Object.keys(resultPayload(botStatus)).some((key) => ["appId", "app_id", "identity", "identities", "profile"].includes(key))) {
    failures.push("application/bot authorization is not readable; tenant/admin approval is not proven");
  }

  const scopes = await runCli(cli, options.profile, ["auth", "scopes", "--json"], 15_000, environment);
  const scopeData = resultPayload(scopes);
  const granted = Array.isArray(scopeData.userScopes)
    ? scopeData.userScopes.filter((value): value is string => typeof value === "string")
    : [];
  const permissionManifest = await readJson<{ identities: Record<string, { required: string[] }> }>(PERMISSION_MANIFEST);
  const requiredUserScopes = permissionManifest.identities.user?.required ?? [];
  const requiredBotScopes = permissionManifest.identities.bot?.required ?? [];
  const missingUserScopes = requiredUserScopes.filter((scope) => !granted.includes(scope));
  summary.scopeCheck = {
    requiredCount: requiredUserScopes.length,
    observedGrantCount: granted.length,
    missingUserScopes,
  };
  if (missingUserScopes.length > 0) {
    failures.push(`user grant is missing ${missingUserScopes.length} required scope(s): ${missingUserScopes.join(", ")}`);
  }

  const applicationScopes = await runCli(cli, options.profile, [
    "api", "GET", "/open-apis/application/v6/scopes", "--as", "bot",
  ], 15_000, environment);
  const applicationScopeRows = scopeRows(resultPayload(applicationScopes));
  const grantedApplicationScopes = applicationScopeRows
    .filter((row) => row.grantStatus === 1 || row.grantStatus === "1" || row.grantStatus === true)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
  const missingApplicationScopes = requiredBotScopes.filter((scope) => !grantedApplicationScopes.includes(scope));
  summary.applicationScopeCheck = {
    ok: applicationScopes.ok,
    requiredCount: requiredBotScopes.length,
    observedGrantCount: grantedApplicationScopes.length,
    missingApplicationScopes,
  };
  if (!applicationScopes.ok) {
    failures.push("application scope readback failed; tenant/admin approval is not proven");
  } else if (missingApplicationScopes.length > 0) {
    failures.push(`application grant is missing ${missingApplicationScopes.length} required scope(s): ${missingApplicationScopes.join(", ")}`);
  }

  const who = await runCli(cli, options.profile, ["whoami", "--as", "user"], 15_000, environment);
  const identityData = resultPayload(who);
  const identity = identityFromPayload(identityData);
  const resolvedAppId = appId ?? identity.appId;
  const resolvedUserOpenId = identity.openId;
  if (appId && identity.appId && appId !== identity.appId) {
    failures.push("isolated profile user identity belongs to a different app id");
  }
  if (!resolvedAppId) failures.push("app id is unavailable; create/select an isolated lark-cli profile first");
  if (!resolvedUserOpenId) failures.push("user open_id is unavailable; complete user OAuth before provisioning");
  summary.appId = resolvedAppId ?? "<missing>";
  summary.userOpenIdPresent = Boolean(resolvedUserOpenId);
  return {
    failures,
    summary,
    ...(resolvedUserOpenId ? { userOpenId: resolvedUserOpenId } : {}),
    ...(createdAppSecret ? { appSecret: createdAppSecret } : {}),
    ...(botIdentity.appId ? { botAppId: botIdentity.appId } : {}),
  };
}

function sanitizeAuthStatus(result: CliResult): Record<string, unknown> {
  const data = resultPayload(result);
  return {
    ok: result.ok,
    profile: typeof data.profile === "string" ? data.profile : undefined,
    identity: typeof data.identity === "string" ? data.identity : undefined,
    tokenStatus: typeof data.tokenStatus === "string" ? data.tokenStatus : undefined,
    verified: typeof (result as { verified?: unknown }).verified === "boolean"
      ? (result as { verified: boolean }).verified
      : undefined,
    errorType: result.error?.type,
    errorSubtype: result.error?.subtype,
  };
}

function resultPayload(result: CliResult): Record<string, unknown> {
  if (typeof result.data === "object" && result.data !== null && !Array.isArray(result.data)) {
    return result.data as Record<string, unknown>;
  }
  return result as unknown as Record<string, unknown>;
}

function identityFromPayload(payload: Record<string, unknown>): { appId?: string; openId?: string } {
  const nested = payload.onBehalfOf && typeof payload.onBehalfOf === "object" && !Array.isArray(payload.onBehalfOf)
    ? payload.onBehalfOf as Record<string, unknown>
    : {};
  const appId = [payload.appId, payload.app_id, nested.appId, nested.app_id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const openId = [payload.openId, payload.open_id, nested.openId, nested.open_id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return { ...(appId ? { appId } : {}), ...(openId ? { openId } : {}) };
}

function scopeRows(payload: Record<string, unknown>): Array<{ name: string | undefined; grantStatus: unknown }> {
  const nested = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload;
  const rows = nested.scopes ?? nested.items ?? nested.scope_list;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (typeof row === "string") return [{ name: row, grantStatus: 1 }];
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const item = row as Record<string, unknown>;
    const name = item.scope_name ?? item.scopeName ?? item.name;
    return [{
      name: typeof name === "string" ? name : undefined,
      grantStatus: item.grant_status ?? item.grantStatus ?? item.status,
    }];
  });
}

export function parseBackendProbeOutput(backend: BackendKind, stdout: string): { ok: boolean; structured: boolean; marker: boolean } {
  const lines = stdout.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  let structured = false;
  let marker = false;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        structured = true;
        if (JSON.stringify(parsed).includes("SM_ONBOARDING_PROBE_OK")) marker = true;
      }
    } catch {
      if (backend === "claude" && line.includes("SM_ONBOARDING_PROBE_OK")) marker = true;
    }
  }
  return { ok: structured && marker, structured, marker };
}

export function buildBackendProbeArgs(backend: BackendKind, prompt: string): string[] {
  return backend === "claude"
    ? ["-p", "--output-format", "json", "--no-session-persistence", "--max-budget-usd", "0.25", prompt]
    : backend === "codex"
      ? ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", prompt]
      : ["-p", "--output-format", "stream-json", prompt];
}

export async function backendPreflight(options: OnboardingOptions, environment: OnboardingChildEnvironment): Promise<{
  failures: string[];
  summary: Record<string, unknown>;
}> {
  const command = environment.backendPath;
  const version = await commandVersion(command, environment);
  const summary: Record<string, unknown> = {
    backend: options.backend,
    command,
    version: version.version,
    probe: { attempted: false, marker: "SM_ONBOARDING_PROBE_OK", cost: "one minimal authenticated request" },
  };
  const failures = version.ok ? [] : [`selected backend ${command} is unavailable: ${version.version}`];
  if (!version.ok) return { failures, summary };
  const prompt = "Reply with exactly SM_ONBOARDING_PROBE_OK and no other text. Do not use tools.";
  const args = buildBackendProbeArgs(options.backend, prompt);
  try {
    const result = await execFileAsync(command, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: childProcessEnv(environment) });
    const parsed = parseBackendProbeOutput(options.backend, result.stdout);
    summary.probe = { attempted: true, ...parsed, marker: "SM_ONBOARDING_PROBE_OK", cost: "one minimal authenticated request" };
    if (!parsed.ok) failures.push(`selected ${options.backend} backend did not return a structured authenticated probe marker`);
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const output = e.stdout ?? e.stderr ?? e.message ?? String(error);
    const parsed = parseBackendProbeOutput(options.backend, e.stdout ?? "");
    summary.probe = { attempted: true, ...parsed, marker: "SM_ONBOARDING_PROBE_OK", error: redact(output).slice(0, 300), cost: "one minimal authenticated request" };
    failures.push(`selected ${options.backend} backend probe failed: ${redact(output).slice(0, 300)}`);
  }
  return { failures, summary };
}

function shellEnv(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}

export function buildEnv(options: OnboardingOptions, state: OnboardingState): string {
  const onboardingRoot = path.join(state.runtimeRoot, "onboarding-v1");
  const environment = state.childEnv ?? fallbackChildEnvironment(options, state);
  const backendPathVariable = {
    claude: "SM_CLAUDE_CLI_PATH",
    codex: "SM_CODEX_CLI_PATH",
    kimi: "SM_KIMI_CLI_PATH",
  }[options.backend];
  validateChildEnvironment(environment, state.runtimeRoot);
  const localwatchScript = path.join(state.sourceRoot, "scripts", "localwatch.sh");
  return [
    "# Generated by SuperMatrix onboarding V1. Review before use.",
    "# Secrets are read from mode-0600 files by start.sh and are not stored here.",
    shellEnv("LARK_APP_ID", state.appId),
    shellEnv("LARK_CLI_PROFILE", state.profile),
    shellEnv("SM_ROOT_GROUP_ID", state.rootGroupId ?? ""),
    shellEnv("SM_ROOT_USER_ID", state.ownerOpenId),
    shellEnv("SM_WORKSPACE_ROOT", state.workspaceRoot),
    shellEnv("SM_DB_PATH", state.dbPath),
    shellEnv("SM_BACKEND", options.backend),
    "SM_LOG_LEVEL=info",
    `SM_API_PORT=${options.apiPort}`,
    shellEnv("SM_LARK_CLI_PATH", environment.larkCliPath),
    shellEnv(backendPathVariable, environment.backendPath),
    shellEnv("SM_CARD_ASK_MCP_SERVER_PATH", path.join(onboardingRoot, "modules", "larkc", "card-callback", "src", "mcpAskServer.js")),
    shellEnv("SM_RUNTIME_ROOT", state.runtimeRoot),
    shellEnv("SM_ONBOARDING_STATE", state.statePath),
    shellEnv("SM_ONBOARD_SOURCE_ROOT", state.sourceRoot),
    shellEnv("SM_ONBOARDING_ROOT", onboardingRoot),
    shellEnv("SM_LOCALWATCH_SCRIPT", localwatchScript),
    shellEnv("SM_LOCALWATCH_REPO_DIR", state.sourceRoot),
    shellEnv("SM_LOCALWATCH_ENV_FILE", path.join(onboardingRoot, ".env.local.generated")),
    shellEnv("SM_LOCALWATCH_LOG_DIR", path.join(onboardingRoot, "logs")),
    shellEnv("SM_LOCALWATCH_LOCK_DIR", path.join(onboardingRoot, "localwatch.lock")),
    shellEnv("SM_LOCALWATCH_OWNER_RECEIPT_PATH", localwatchOwnerReceiptPath(options)),
    shellEnv("SM_LOCALWATCH_INSTALLATION_NAMESPACE", onboardingRoot),
    shellEnv("SM_LOCALWATCH_LAUNCHER_PATH", path.join(onboardingRoot, "start.sh")),
    shellEnv("SM_LOCALWATCH_SCHEDULER_PID_FILE", path.join(onboardingRoot, "scheduler.pid")),
    shellEnv("LOCALWATCH_MANAGED_COMPONENTS", "core,scheduler-v2"),
    shellEnv("SM_SCHEDULER_START", path.join(onboardingRoot, "scheduler-start.sh")),
    shellEnv("SM_SCHEDULER_PORT", String(options.schedulerPort)),
    shellEnv("SM_ONBOARD_NODE", environment.nodePath),
    shellEnv("SM_ONBOARD_NPM", environment.npmPath),
    shellEnv("SM_ONBOARD_PYTHON", environment.pythonPath),
    shellEnv("HOME", environment.home),
    shellEnv("XDG_CONFIG_HOME", environment.xdgConfigHome),
    shellEnv("CODEX_HOME", environment.codexHome),
    shellEnv("PATH", environment.path),
    "SM_DRIVE_COMMENT_SUBSCRIPTION_ENABLED=0",
    shellEnv("SM_SCHEDULER_BASE_URL", `http://127.0.0.1:${options.schedulerPort}`),
    shellEnv("SM_SCHEDULER_HEALTH_URL", `http://127.0.0.1:${options.schedulerPort}/health`),
    shellEnv("SCHEDULER_V2_PORT", String(options.schedulerPort)),
    shellEnv("SCHEDULER_V2_DB", path.join(state.runtimeRoot, "data", "scheduler-v2.db")),
    shellEnv("SM_DB", state.dbPath),
    shellEnv("SM_BASE_URL", `http://127.0.0.1:${options.apiPort}`),
    shellEnv("LARK_APP_SECRET_FILE", path.join(state.runtimeRoot, "onboarding-v1", "lark-app.secret")),
    shellEnv("SCHEDULER_ADMIN_TOKEN_FILE", path.join(state.runtimeRoot, "onboarding-v1", "scheduler-admin.secret")),
    shellEnv("SM_ONBOARD_SKILLS_DIR", path.join(state.runtimeRoot, "onboarding-v1", "skills")),
    shellEnv("SM_KIMI_SKILLS_DIR", path.join(state.runtimeRoot, "onboarding-v1", "skills")),
    "",
  ].join("\n");
}

async function ensureSecretFile(options: OnboardingOptions, name: string, value: string): Promise<string> {
  const secretPath = path.join(options.runtimeRoot, "onboarding-v1", name);
  await writeTextAtomic(secretPath, `${value}\n`, 0o600);
  return createHash("sha256").update(value).digest("hex");
}

async function findGroup(cli: string, profile: string, name: string, environment?: OnboardingChildEnvironment): Promise<string | undefined> {
  const result = await runCli(cli, profile, [
    "im", "+chat-search", "--as", "user", "--query", name,
    "--search-types", "private", "--format", "json",
  ], 15_000, environment);
  if (!result.ok) throw new Error(`group search failed for ${name}: ${result.error?.type ?? result.raw.slice(0, 200)}`);
  const data = resultPayload(result);
  const rawItems = data.items ?? data.chats ?? data.chat_list ?? (data.data && typeof data.data === "object" ? (data.data as Record<string, unknown>).items : undefined);
  if (!Array.isArray(rawItems)) throw new Error(`group search returned an unreadable result for ${name}`);
  const matches = rawItems.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item) && item.name === name),
  );
  if (matches.length > 1) throw new Error(`ambiguous existing onboarding group name: ${name}`);
  const id = matches[0]?.chat_id;
  return typeof id === "string" ? id : undefined;
}

function adoptingGateway(gateway: LarkGateway, groupId: LarkGroupId): LarkGateway {
  return new Proxy(gateway, {
    get(target, property, receiver) {
      if (property === "createGroup") return async () => groupId;
      if (property === "dissolveGroup") return async () => {};
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LarkGateway;
}

export function isolatedSessionTableSync(
  _mode: SessionTableSyncMode = "full",
  _sessionNames: readonly string[] = [],
): Promise<SessionRuntimeSettingsSyncResult> {
  // Onboarding owns an isolated SQLite/runtime tree.  It must not invoke the
  // framework's default synchronizer, whose fallback path is production.
  return Promise.resolve({ ok: true });
}

export function lifecycleFor(options: OnboardingOptions, state: OnboardingState, fs: NodeWorkspaceFs, store: SqliteBindingStore, lark: LarkGateway) {
  return createSessionLifecycle({
    store,
    fs,
    lark,
    clock: { now: () => asTimestamp(Date.now()) },
    workspaceRoot: asAbsolutePath(options.workspaceRoot),
    catalogPath: asAbsolutePath(path.join(options.workspaceRoot, "session-catalog.json")),
    principlesTemplatesDir: asAbsolutePath(path.join(options.workspaceRoot, "first-principle", "templates")),
    claudeMdTemplatePath: asAbsolutePath(path.join(options.sourceRoot, "templates", "claude-md-base.md")),
    agentsMdTemplatePath: asAbsolutePath(path.join(options.sourceRoot, "templates", "agents-md-base.md")),
    gitignorePath: asAbsolutePath(path.join(options.sourceRoot, "templates", "gitignore.default")),
    ownerUserId: state.ownerOpenId,
    idFactory: () => `sess_${randomUUID().slice(0, 8)}`,
    requestSessionTableSync: isolatedSessionTableSync,
  });
}

async function materializeRoleWorkdir(
  options: OnboardingOptions,
  role: Role,
  entry: StateRole,
  environment?: OnboardingChildEnvironment,
  provenancePath = ASSET_PROVENANCE,
): Promise<string | undefined> {
  if (role.workdir === "source") return options.sourceRoot;
  if (role.workdir === "workspace") return path.join(options.workspaceRoot, role.name);
  const modulePath = role.modulePath;
  if (!modulePath) throw new Error(`module role ${role.name} has no modulePath`);
  const source = await resolveModuleSource(options, modulePath);
  const provenance = await readJson<AssetProvenance>(provenancePath);
  const provenanceEntry = (provenance.modules ?? []).find((candidate) => candidate.name === role.name);
  if (!provenanceEntry) throw new Error(`module provenance is missing: ${role.name}`);
  const destination = entry.workdir ?? path.join(options.runtimeRoot, "onboarding-v1", "modules", role.name);
  if (!entry.workdir) {
    try { await access(path.join(destination, ".onboarding-module"), fsConstants.R_OK); }
    catch {
      await copyTreeSelected(source, destination, provenanceEntry.include);
      await writeTextAtomic(path.join(destination, ".onboarding-module"), `${role.name}\n`, 0o600);
    }
  }
  entry.workdir = destination;
  entry.modulePath = modulePath;
  // packagePaths describes an entrypoint prefix, not an authorization to
  // install nested packages. Support exports are materialized copy-only; any
  // nested runtime closure must be supplied by the owner module's documented
  // entrypoint or an existing tool configuration.
  for (const packagePath of [""]) {
    const packageRoot = path.join(destination, packagePath);
    if (await access(path.join(packageRoot, "package.json"), fsConstants.R_OK).then(() => true).catch(() => false)
      && !await access(path.join(packageRoot, "node_modules"), fsConstants.R_OK).then(() => true).catch(() => false)) {
      const hasLock = await access(path.join(packageRoot, "package-lock.json"), fsConstants.R_OK).then(() => true).catch(() => false);
      await execFileAsync(environment?.npmPath ?? process.env.SM_ONBOARD_NPM ?? "npm", [hasLock ? "ci" : "install", "--no-audit", "--no-fund"], {
        cwd: packageRoot,
        timeout: 300_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(environment ? { env: childProcessEnv(environment) } : {}),
      });
    }
  }
  if (role.run && (role.run.startsWith("python3 ") || role.run.startsWith(".venv/bin/python "))) {
    const python = path.join(destination, ".venv", "bin", "python");
    if (!await access(python, fsConstants.X_OK).then(() => true).catch(() => false)) {
      await execFileAsync(environment?.pythonPath ?? process.env.SM_ONBOARD_PYTHON ?? "python3", ["-m", "venv", path.join(destination, ".venv")], {
        cwd: destination,
        timeout: 60_000,
        maxBuffer: 1_000_000,
        ...(environment ? { env: childProcessEnv(environment) } : {}),
      });
    }
    await execFileAsync(python, ["--version"], { cwd: destination, timeout: 5_000, maxBuffer: 100_000, ...(environment ? { env: childProcessEnv(environment) } : {}) });
    const commandTokens = role.run.split(/\s+/u).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
    const pythonArgs = commandTokens.slice(1);
    await execFileAsync(python, pythonArgs, { cwd: destination, timeout: 30_000, maxBuffer: 1_000_000, ...(environment ? { env: childProcessEnv(environment) } : {}) });
  }
  return destination;
}

async function provision(options: OnboardingOptions, state: OnboardingState, roles: Role[], gateway: LarkGateway, provenancePath = ASSET_PROVENANCE): Promise<void> {
  const store = new SqliteBindingStore(options.dbPath);
  await store.init();
  const fs = new NodeWorkspaceFs({
    gitActorSessionName: "onboarding-v1",
    gitUserName: "SuperMatrix Onboarding",
    gitUserEmail: "onboarding@supermatrix.local",
  });
  try {
    state.status = "provisioning";
    await saveState(options, state);
    for (const role of roles) {
      const entry = state.roles.find((candidate) => candidate.name === role.name);
      if (!entry || entry.phase === "session_ready") continue;
      const groupName = `sm-onboard-v1-${state.installId.slice(0, 8)}-${role.name}-${options.backend}`;
      let groupId = entry.groupId;
      if (!groupId) {
        const cli = state.childEnv?.larkCliPath ?? process.env.SM_LARK_CLI_PATH ?? "lark-cli";
        groupId = await findGroup(cli, options.profile, groupName, state.childEnv);
        if (groupId) entry.groupOwned = false;
        else {
          groupId = await gateway.createGroup({ name: groupName, ownerUserId: state.ownerOpenId });
          entry.groupOwned = true;
        }
        entry.groupId = groupId;
        entry.phase = "group_created";
        await saveState(options, state);
      }
      const existing = await store.findSessionByName(role.name);
      if (existing) {
        const binding = await store.findBySession(existing.id);
        if (!binding || binding.groupId !== groupId) throw new Error(`existing session ${role.name} does not match onboarding group`);
        entry.sessionId = existing.id;
        entry.workdir = existing.workdir;
        entry.phase = "session_ready";
      } else {
        const workdir = await materializeRoleWorkdir(options, role, entry, state.childEnv, provenancePath);
        const lifecycle = lifecycleFor(options, state, fs, store, adoptingGateway(gateway, asLarkGroupId(groupId)));
        const result = await lifecycle.create({
          backend: options.backend,
          name: role.name,
          purpose: role.purpose,
          category: "平台",
          ...(workdir ? { workdir: asAbsolutePath(workdir) } : {}),
          chatName: `sm-onboard-v1-${state.installId.slice(0, 8)}`,
        });
        entry.sessionId = result.session.id;
        entry.sessionOwned = true;
        entry.workdir = result.session.workdir;
        entry.phase = "session_ready";
      }
      if (role.name === "supermatrix-root") state.rootGroupId = groupId;
      await saveState(options, state);
    }
    state.status = "provisioning";
    await saveState(options, state);
  } catch (error) {
    state.status = "blocked";
    state.blocked = [redact(error instanceof Error ? error.message : String(error))];
    await saveState(options, state);
    throw error;
  } finally {
    await store.close();
  }
}

export function renderStartScript(options: OnboardingOptions, _state: OnboardingState, schedulerStartPath: string | undefined): string {
  const envPath = path.join(options.runtimeRoot, "onboarding-v1", ".env.local.generated");
  const appSecretPath = path.join(options.runtimeRoot, "onboarding-v1", "lark-app.secret");
  const schedulerSecretPath = path.join(options.runtimeRoot, "onboarding-v1", "scheduler-admin.secret");
  const lines = [
    "#!/bin/sh",
    "set -eu",
    `ENV_FILE=${shellQuote(envPath)}`,
    `[ -r "$ENV_FILE" ] || { echo 'generated environment is missing; rerun onboarding' >&2; exit 2; }`,
    "set -a",
    '. "$ENV_FILE"',
    "set +a",
    `[ -r ${shellQuote(appSecretPath)} ] || { echo 'isolated Lark app secret is missing; enter it during onboarding' >&2; exit 2; }`,
    `[ -r ${shellQuote(schedulerSecretPath)} ] || { echo 'scheduler admin secret is missing; rerun onboarding' >&2; exit 2; }`,
    `mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$CODEX_HOME" "$SM_ONBOARDING_ROOT"`,
    `LARK_APP_SECRET=$(cat ${shellQuote(appSecretPath)})`,
    `SCHEDULER_ADMIN_TOKEN=$(cat ${shellQuote(schedulerSecretPath)})`,
    "export LARK_APP_SECRET SCHEDULER_ADMIN_TOKEN",
    `[ -r "$SM_LOCALWATCH_SCRIPT" ] || { echo 'existing LocalWatch script is missing; rerun onboarding' >&2; exit 2; }`,
    ...(schedulerStartPath ? [`[ -r "$SM_SCHEDULER_START" ] || { echo 'scheduler start artifact is missing; rerun onboarding' >&2; exit 2; }`] : ["echo 'scheduler module not included; scheduled tasks are unavailable' >&2"]),
    `exec bash "$SM_LOCALWATCH_SCRIPT"`,
    "",
  ];
  return lines.join("\n");
}

export function renderSchedulerStartScript(
  modulePath: string,
  state: Pick<OnboardingState, "runtimeRoot" | "dbPath">,
  schedulerPort: number,
): string {
  const packageLock = path.join(modulePath, "package-lock.json");
  return [
    "#!/bin/sh",
    "set -eu",
    `cd ${shellQuote(modulePath)}`,
    `if [ ! -d node_modules ]; then if [ -r ${shellQuote(packageLock)} ]; then \"\${SM_ONBOARD_NPM:-npm}\" ci --no-audit --no-fund; else \"\${SM_ONBOARD_NPM:-npm}\" install --no-audit --no-fund; fi; fi`,
    "if [ ! -f dist/main.js ]; then \"${SM_ONBOARD_NPM:-npm}\" run build; fi",
    `exec env SCHEDULER_V2_HOST=127.0.0.1 SCHEDULER_V2_PORT=${schedulerPort} SCHEDULER_V2_DB=${shellQuote(path.join(state.runtimeRoot, "data", "scheduler-v2.db"))} SM_DB=${shellQuote(state.dbPath)} SM_BASE_URL=\"http://127.0.0.1:$SM_API_PORT\" \"\${SM_ONBOARD_NPM:-npm}\" start`,
    "",
  ].join("\n");
}

async function writeServiceArtifacts(options: OnboardingOptions, state: OnboardingState, roles: Role[]): Promise<{ envPath: string; startPath: string }> {
  const root = path.join(options.runtimeRoot, "onboarding-v1");
  await mkdir(root, { recursive: true });
  const scheduler = state.roles.find((entry) => entry.name === "scheduler");
  const schedulerStartPath = scheduler?.workdir ? path.join(root, "scheduler-start.sh") : undefined;
  if (schedulerStartPath && scheduler?.workdir) {
    await writeTextAtomic(schedulerStartPath, renderSchedulerStartScript(scheduler.workdir, state, options.schedulerPort), 0o700);
  }
  const envPath = path.join(root, ".env.local.generated");
  const startPath = path.join(root, "start.sh");
  await writeTextAtomic(envPath, buildEnv(options, state), 0o600);
  await writeTextAtomic(startPath, renderStartScript(options, state, schedulerStartPath), 0o700);
  await writeJsonAtomic(path.join(root, "service.json"), {
    version: 1,
    api: { host: "127.0.0.1", port: options.apiPort },
    scheduler: schedulerStartPath ? { host: "127.0.0.1", port: options.schedulerPort, start: schedulerStartPath } : { status: "missing-module" },
    modules: roles.map((role) => ({
      name: role.name,
      workdir: role.workdir,
      run: role.run,
      ...(role.env ? { env: role.env } : {}),
      groupId: state.roles.find((entry) => entry.name === role.name)?.groupId,
    })),
    nativeOS: {
      autoStart: true,
      command: startPath,
      cwd: options.sourceRoot,
      environmentFile: envPath,
      registration: "external",
      launchAgent: {
        label: `com.supermatrix.onboarding.${state.installId}`,
        programArguments: ["/bin/sh", startPath],
        runAtLoad: true,
        keepAlive: true,
        workingDirectory: options.sourceRoot,
        standardOutPath: path.join(root, "service.log"),
        standardErrorPath: path.join(root, "service.log"),
        readback: "launchctl print gui/$UID/<label> and then read ownerReceiptPath",
      },
    },
    ownerReceipt: {
      path: localwatchOwnerReceiptPath(options),
      format: "localwatch-owner-v1",
      requiredFields: ["pid", "processStart", "bootId", "repoDir", "scriptPath", "cwd", "installationNamespace", "launcherPath", "healthEndpoints", "status"],
    },
    restart: { command: startPath, persistence: [state.dbPath, path.join(state.runtimeRoot, "data", "scheduler-v2.db")] },
    profile: state.profile,
    status: "written",
  });
  return { envPath, startPath };
}

export async function startService(
  options: OnboardingOptions,
  state: OnboardingState,
  startPath: string,
  startupTimeoutMs = 30_000,
): Promise<number> {
  const root = path.join(options.runtimeRoot, "onboarding-v1");
  const pidPath = path.join(root, "service.pid");
  if (await isOwnedHealthyInstance(options, state)) {
    const owner = await readCurrentLocalWatchOwner(options);
    if (owner) {
      state.servicePid = owner.receipt.pid;
      await writeTextAtomic(pidPath, `${owner.receipt.pid}\n`, 0o600);
      return owner.receipt.pid;
    }
  }
  await assertPortAvailable(options.apiPort);
  await assertPortAvailable(options.schedulerPort);
  const logPath = path.join(root, "service.log");
  const log = await open(logPath, "a");
  let servicePid: number | undefined;
  const schedulerPidPath = path.join(root, "scheduler.pid");
  const cleanupErrors: string[] = [];
  try {
    const child = spawn(startPath, [], { cwd: options.sourceRoot, detached: true, stdio: ["ignore", log.fd, log.fd] });
    child.unref();
    if (!child.pid) throw new Error("isolated service did not return a pid");
    servicePid = child.pid;
    state.servicePid = servicePid;
    state.status = "provisioning";
    // Persist the owner receipt before probing health. This write is inside
    // the cleanup boundary so a persistence failure still reaps the spawn.
    await writeTextAtomic(pidPath, `${servicePid}\n`, 0o600);
    await saveState(options, state);
    const deadline = Date.now() + startupTimeoutMs;
    let lastError = "health endpoints did not become ready";
    while (Date.now() < deadline) {
      const schedulerPid = await readPidFile(schedulerPidPath);
      if (schedulerPid && schedulerPid !== state.schedulerPid) {
        state.schedulerPid = schedulerPid;
        await saveState(options, state);
      }
      try {
        const owner = await readCurrentLocalWatchOwner(options);
        if (!owner) {
          lastError = "current LocalWatch owner receipt is missing or contradictory";
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        state.servicePid = owner.receipt.pid;
        await writeTextAtomic(pidPath, `${owner.receipt.pid}\n`, 0o600);
        const health = async (url: string): Promise<Response> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(2_000, deadline - Date.now())));
          try { return await fetch(url, { signal: controller.signal }); }
          finally { clearTimeout(timer); }
        };
        const [api, scheduler] = await Promise.all([
          health(owner.receipt.healthEndpoints.api),
          health(owner.receipt.healthEndpoints.scheduler),
        ]);
        if (api.ok && scheduler.ok) {
          const servicePath = path.join(root, "service.json");
          const service = await readJson<Record<string, unknown>>(servicePath);
          await writeJsonAtomic(servicePath, { ...service, status: "ready", pid: owner.receipt.pid, ownerReceiptPath: localwatchOwnerReceiptPath(options) });
          return owner.receipt.pid;
        }
        lastError = `health status api=${api.status} scheduler=${scheduler.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`isolated service startup failed: ${lastError}; log=${logPath}`);
  } catch (error) {
    if (servicePid) {
      try {
        const schedulerPid = await readPidFileEventually(schedulerPidPath);
        if (schedulerPid) state.schedulerPid = schedulerPid;
      } catch (readError) {
        cleanupErrors.push(redact(readError instanceof Error ? readError.message : String(readError)));
      }
      try {
        await saveState(options, state);
      } catch (receiptError) {
        cleanupErrors.push(`owner receipt persistence failed: ${redact(receiptError instanceof Error ? receiptError.message : String(receiptError))}`);
      }
      try {
        const owner = await readCurrentLocalWatchOwnerEventually(options, 100);
        await stopOwnedProcessTree(owner?.receipt.pid ?? servicePid, [startPath, localwatchScriptPath(options)], "isolated service");
      } catch (cleanupError) {
        cleanupErrors.push(redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)));
      }
    }
    if (state.schedulerPid) {
      try {
        await stopOwnedProcessTree(state.schedulerPid, [path.join(root, "scheduler-start.sh")], "isolated scheduler");
      } catch (cleanupError) {
        cleanupErrors.push(redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)));
      }
    }
    if (cleanupErrors.length) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; startup cleanup failed: ${cleanupErrors.join("; ")}`);
    }
    throw error;
  } finally {
    await log.close();
  }
}

async function verifyArtifacts(options: OnboardingOptions, state: OnboardingState): Promise<string[]> {
  const failures: string[] = [];
  const root = path.join(options.runtimeRoot, "onboarding-v1");
  for (const [name, mode] of [[".env.local.generated", 0o600], ["start.sh", 0o700], ["service.json", 0o600]] as const) {
    try {
      const info = await stat(path.join(root, name));
      if ((info.mode & 0o777) !== mode) failures.push(`${name} has unsafe mode ${(info.mode & 0o777).toString(8)}`);
    } catch { failures.push(`startup artifact is missing: ${path.join(root, name)}`); }
  }
  try {
    const text = await readFile(path.join(root, ".env.local.generated"), "utf8");
    if (!text.includes("LARK_CLI_PROFILE=") || !text.includes("SM_SCHEDULER_BASE_URL=")) failures.push("generated environment is missing isolated profile or scheduler wiring");
    if (text.includes("LARK_APP_SECRET=")) failures.push("generated environment contains an app secret");
    if (!text.includes("HOME=") || !text.includes("XDG_CONFIG_HOME=") || !text.includes("CODEX_HOME=") || !text.includes("SM_DRIVE_COMMENT_SUBSCRIPTION_ENABLED=0")) failures.push("generated environment is missing isolated runtime namespace or subscription guard");
    if (!state.childEnv) {
      failures.push("onboarding state has no recorded child environment");
    } else {
      const expectedEnvironment = [
        ["HOME", state.childEnv.home],
        ["XDG_CONFIG_HOME", state.childEnv.xdgConfigHome],
        ["CODEX_HOME", state.childEnv.codexHome],
        ["PATH", state.childEnv.path],
        ["SM_ONBOARD_NODE", state.childEnv.nodePath],
        ["SM_ONBOARD_NPM", state.childEnv.npmPath],
        ["SM_ONBOARD_PYTHON", state.childEnv.pythonPath],
        ["SM_LARK_CLI_PATH", state.childEnv.larkCliPath],
        [{ claude: "SM_CLAUDE_CLI_PATH", codex: "SM_CODEX_CLI_PATH", kimi: "SM_KIMI_CLI_PATH" }[state.backend], state.childEnv.backendPath],
      ] as const;
      for (const [name, value] of expectedEnvironment) {
        if (!text.includes(`${name}=${shellQuote(value)}`)) failures.push(`generated environment does not preserve recorded ${name}`);
      }
    }
  } catch { /* reported above */ }
  try {
    const service = await readJson<{
      nativeOS?: { registration?: string; command?: string };
      ownerReceipt?: { path?: string; format?: string };
    }>(path.join(root, "service.json"));
    if (service.nativeOS?.registration !== "external" || service.nativeOS?.command !== path.join(root, "start.sh")) {
      failures.push("service.json native OS registration does not point to generated start.sh");
    }
    if (service.ownerReceipt?.path !== localwatchOwnerReceiptPath(options)
      || service.ownerReceipt?.format !== "localwatch-owner-v1") {
      failures.push("service.json LocalWatch owner receipt contract is missing or mismatched");
    }
  } catch { /* startup artifact absence is reported above */ }
  const secrets: Array<[string, string | undefined]> = [
    ["scheduler-admin.secret", state.schedulerSecretSha256],
    ["lark-app.secret", state.appSecretSha256],
  ];
  for (const [name, expectedHash] of secrets) {
    if (!expectedHash) {
      if (name === "scheduler-admin.secret") failures.push(`${name} hash is missing from onboarding state`);
      continue;
    }
    try {
      const value = (await readFile(path.join(root, name), "utf8")).trim();
      if (!value || createHash("sha256").update(value).digest("hex") !== expectedHash) {
        failures.push(`${name} hash readback mismatch`);
      }
    } catch {
      failures.push(`secret file is missing: ${path.join(root, name)}`);
    }
  }
  return failures;
}

export function validateStateOwnership(options: OnboardingOptions, state: OnboardingState): void {
  const expected = {
    profile: options.profile,
    sourceRoot: path.resolve(options.sourceRoot),
    runtimeRoot: path.resolve(options.runtimeRoot),
    workspaceRoot: path.resolve(options.workspaceRoot),
    dbPath: path.resolve(options.dbPath),
    statePath: path.resolve(resolveStatePath(options)),
  };
  for (const key of ["profile", "sourceRoot", "runtimeRoot", "workspaceRoot", "dbPath", "statePath"] as const) {
    if (state[key] !== expected[key]) throw new Error(`onboarding state ownership mismatch: ${key}`);
  }
  if (state.backend !== options.backend || state.apiPort !== options.apiPort || state.schedulerPort !== options.schedulerPort) throw new Error("onboarding state ownership mismatch: backend or port");
  if (state.childEnv) validateChildEnvironment(state.childEnv, state.runtimeRoot);
  if (state.status === "rolled_back") return;
  if (!state.profileIdentity || state.profileIdentity.appId !== state.appId || state.profileIdentity.ownerOpenId !== state.ownerOpenId) {
    throw new Error("onboarding state has no matching isolated profile identity");
  }
}

async function profileIdentityFailures(state: OnboardingState): Promise<string[]> {
  const environment = state.childEnv;
  if (!environment) return ["onboarding state has no recorded child environment"];
  const cli = environment.larkCliPath;
  const [user, bot] = await Promise.all([
    runCli(cli, state.profile, ["whoami", "--as", "user"], 15_000, environment),
    runCli(cli, state.profile, ["whoami", "--as", "bot"], 15_000, environment),
  ]);
  const userIdentity = identityFromPayload(resultPayload(user));
  const botIdentity = identityFromPayload(resultPayload(bot));
  const failures: string[] = [];
  if (!state.profileIdentity || !user.ok
    || userIdentity.appId !== state.profileIdentity.appId
    || userIdentity.openId !== state.profileIdentity.ownerOpenId) {
    failures.push("isolated profile user identity readback mismatch");
  }
  if (!bot.ok || (botIdentity.appId && botIdentity.appId !== (state.profileIdentity?.botAppId ?? state.profileIdentity?.appId))) {
    failures.push("isolated profile bot identity readback mismatch");
  }
  return failures;
}

async function verifyState(options: OnboardingOptions, state: OnboardingState, readRemote = true): Promise<string[]> {
  const failures: string[] = [];
  if (state.version !== STATE_VERSION) failures.push("unsupported onboarding state version");
  if (!["configured", "ready", "live_verified"].includes(state.status)) failures.push(`onboarding state is ${state.status}, not configured`);
  if (!state.rootGroupId) failures.push("control group is not recorded");
  failures.push(...await verifyArtifacts(options, state));
  const store = new SqliteBindingStore(options.dbPath);
  try {
    await store.init();
    for (const role of state.roles) {
      if (role.sessionId) {
        const session = await store.findSessionById(asSessionId(role.sessionId));
        const binding = session ? await store.findBySession(session.id) : null;
        if (!session || !binding || binding.groupId !== role.groupId || session.workdir !== role.workdir) {
          failures.push(`${role.name} database binding readback mismatch`);
        }
      }
    }
  } catch (error) {
    failures.push(`onboarding database readback failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  } finally {
    await store.close();
  }
  for (const role of state.roles) {
    if (role.phase !== "session_ready" || !role.groupId || !role.sessionId || !role.workdir) {
      failures.push(`${role.name} is incomplete (${role.phase})`);
    }
    if (role.workdir && !await access(role.workdir, fsConstants.R_OK).then(() => true).catch(() => false)) {
      failures.push(`${role.name} workdir is inaccessible`);
    }
    if (role.workdir && role.workdirKind === "module") {
      const entrypointFailure = await validateRunContract(role.workdir, role.run, role.requiredFiles);
      if (entrypointFailure) failures.push(`${role.name} ${entrypointFailure}`);
    }
  }
  if (!await access(options.dbPath, fsConstants.R_OK).then(() => true).catch(() => false)) {
    failures.push("onboarding database is missing");
  }
  if (["ready", "live_verified"].includes(state.status)) {
    const receipt = await readLocalWatchOwnerReceipt(options);
    if (!receipt) failures.push(`LocalWatch owner receipt is missing: ${localwatchOwnerReceiptPath(options)}`);
    if (!await isOwnedHealthyInstance(options, state)) failures.push("ready onboarding service is not an owned healthy instance");
  }
  if (readRemote && state.profileIdentity) {
    failures.push(...await profileIdentityFailures(state));
    if (!state.childEnv) return [...new Set([...failures, "onboarding state has no recorded child environment"])]
    const client = createRealLarkClient({
      larkCliPath: state.childEnv.larkCliPath,
      profile: state.profile,
      botAppId: state.appId,
      ownerUserId: state.ownerOpenId,
      noProxy: true,
      env: childProcessEnv(state.childEnv),
    });
    for (const role of state.roles) {
      if (!role.groupId) continue;
      try {
        const actualName = await client.getGroupName(asLarkGroupId(role.groupId));
        const expectedName = `sm-onboard-v1-${state.installId.slice(0, 8)}-${role.name}-${options.backend}`;
        if (actualName !== expectedName) failures.push(`${role.name} group identity readback mismatch`);
      } catch (error) {
        failures.push(`${role.name} group readback failed: ${redact(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }
  return [...new Set(failures)];
}

export async function rollback(options: OnboardingOptions, state: OnboardingState): Promise<void> {
  if (state.status === "rolled_back") return;
  validateStateOwnership(options, state);
  const profileFailures = await profileIdentityFailures(state);
  if (profileFailures.length) throw new Error(`rollback stopped: ${profileFailures.join("; ")}`);
  const onboardingRoot = path.join(options.runtimeRoot, "onboarding-v1");
  const owner = await readOwnerReceiptForRollback(options);
  // These waits are part of rollback's safety boundary: generated runtime
  // files are not removed while an owned supervisor or its child tree can
  // still observe them.
  if (owner.receipt.status === "active" && owner.identity) {
    await stopOwnedProcessTree(owner.receipt.pid, [path.join(onboardingRoot, "start.sh"), localwatchScriptPath(options)], "rollback service");
  }
  const remainingHealthy = await Promise.all(Object.values(owner.receipt.healthEndpoints).map(async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      return response.ok;
    } catch {
      return false;
    }
  }));
  if (remainingHealthy.some(Boolean)) {
    throw new Error("rollback stopped: LocalWatch owner is gone or changed but an onboarding health endpoint is still healthy");
  }
  await writeJsonAtomic(localwatchOwnerReceiptPath(options), {
    ...owner.receipt,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
  });
  const store = new SqliteBindingStore(options.dbPath);
  await store.init();
  if (!state.childEnv) throw new Error("rollback stopped: onboarding state has no recorded child environment");
  const cli = state.childEnv.larkCliPath;
  const client = createRealLarkClient({
    larkCliPath: cli,
    profile: state.profile,
    botAppId: state.appId,
    ownerUserId: state.ownerOpenId,
    noProxy: true,
    env: childProcessEnv(state.childEnv),
  });
  const gateway = new LarkCliGateway({
    client,
    attachmentDir: (groupId, date) => asAbsolutePath(path.join(options.runtimeRoot, "onboarding-v1", "attachments", groupId, date)),
    logger: createPinoLogger("warn"),
  });
  try {
    for (const role of state.roles) {
      if (role.sessionId && role.sessionOwned) {
        const session = await store.findSessionById(asSessionId(role.sessionId));
        const binding = session ? await store.findBySession(session.id) : null;
        if (!session || !binding || binding.groupId !== role.groupId || session.workdir !== role.workdir) {
          throw new Error(`rollback stopped: session ownership readback mismatch for ${role.name}`);
        }
      }
      if (role.groupId && role.groupOwned) {
        const expectedName = `sm-onboard-v1-${state.installId.slice(0, 8)}-${role.name}-${options.backend}`;
        const actualName = await gateway.getGroupName(asLarkGroupId(role.groupId));
        if (actualName !== expectedName) throw new Error(`rollback group identity mismatch for ${role.name}`);
      }
      if (role.sessionOwned && role.workdir) {
        if (!isWithin(options.runtimeRoot, role.workdir)) throw new Error(`rollback workdir escapes runtime for ${role.name}`);
        const info = await lstat(role.workdir).catch(() => undefined);
        if (info?.isSymbolicLink()) throw new Error(`rollback stopped: workdir is a symlink for ${role.name}`);
      }
    }
    for (const role of [...state.roles].reverse()) {
      if (role.sessionId && role.sessionOwned) await store.deleteSessionAndBinding(asSessionId(role.sessionId));
      if (role.groupId && role.groupOwned) {
        const expectedName = `sm-onboard-v1-${state.installId.slice(0, 8)}-${role.name}-${options.backend}`;
        const actualName = await gateway.getGroupName(asLarkGroupId(role.groupId));
        if (actualName !== expectedName) throw new Error(`rollback group identity changed during rollback for ${role.name}`);
        await gateway.dissolveGroup(asLarkGroupId(role.groupId));
      }
      if (role.sessionOwned && role.workdir && isWithin(options.runtimeRoot, role.workdir)) {
        await rm(role.workdir, { recursive: true, force: true });
      }
    }
    // Everything below this directory is generated and owned by this install.
    // Preserve the state and last owner receipts so a second rollback is an
    // idempotent no-op and a stopped owner remains auditable.
    for (const entry of await readdir(onboardingRoot)) {
      if ([resolveStatePath(options), localwatchOwnerReceiptPath(options)].some((preserved) => path.resolve(path.join(onboardingRoot, entry)) === path.resolve(preserved))) continue;
      await rm(path.join(onboardingRoot, entry), { recursive: true, force: true });
    }
    state.status = "rolled_back";
    await saveState(options, state);
  } finally {
    await store.close();
  }
}

async function withMutationLock<T>(options: OnboardingOptions, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(options.runtimeRoot, "onboarding-v1", "lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`another onboarding mutation is active: ${lockPath}`);
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function ensureSecrets(options: OnboardingOptions, state: OnboardingState, appSecret: string | undefined): Promise<string | undefined> {
  const appSecretPath = path.join(options.runtimeRoot, "onboarding-v1", "lark-app.secret");
  try {
    const current = (await readFile(appSecretPath, "utf8")).trim();
    if (current) {
      if (state.appSecretSha256 && createHash("sha256").update(current).digest("hex") !== state.appSecretSha256) throw new Error("isolated app secret changed outside onboarding");
      state.appSecretSha256 = createHash("sha256").update(current).digest("hex");
      return current;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!appSecret) return undefined;
  state.appSecretSha256 = await ensureSecretFile(options, "lark-app.secret", appSecret);
  return appSecret;
}

async function ensureGeneratedSecret(options: OnboardingOptions, state: OnboardingState, name: "scheduler-admin.secret"): Promise<void> {
  const secretPath = path.join(options.runtimeRoot, "onboarding-v1", name);
  try {
    const current = (await readFile(secretPath, "utf8")).trim();
    if (!current) throw new Error(`${name} is empty`);
    const hash = createHash("sha256").update(current).digest("hex");
    const expected = state.schedulerSecretSha256;
    if (expected && hash !== expected) throw new Error(`${name} changed outside onboarding`);
    state.schedulerSecretSha256 = hash;
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hash = await ensureSecretFile(options, name, randomBytes(32).toString("hex"));
  state.schedulerSecretSha256 = hash;
}

async function runOnboardingUnlocked(options: OnboardingOptions, deps: OnboardingWorkflowDeps = {}): Promise<number> {
  const statePath = resolveStatePath(options);
  const existing = await loadState(options);
  if (options.rollback) {
    if (!existing) throw new Error(`no onboarding state at ${statePath}`);
    await rollback(options, existing);
    console.log(`onboarding rollback complete; historical install was not touched; state=${statePath}`);
    return 0;
  }

  const earlyFailures: string[] = [];
  let childEnv: OnboardingChildEnvironment | undefined;
  try {
    if (existing) {
      if (!existing.childEnv) throw new Error("onboarding state has no recorded child environment; rerun from a fresh isolated runtime");
      validateChildEnvironment(existing.childEnv, options.runtimeRoot);
      childEnv = existing.childEnv;
    } else {
      childEnv = await captureChildEnvironment(options);
    }
  } catch (error) {
    earlyFailures.push(redact(error instanceof Error ? error.message : String(error)));
  }
  if (existing) {
    try { validateStateOwnership(options, existing); }
    catch (error) { earlyFailures.push(redact(error instanceof Error ? error.message : String(error))); }
  } else if (await access(options.dbPath, fsConstants.F_OK).then(() => true).catch(() => false)) {
    earlyFailures.push(`database already exists without onboarding state: ${options.dbPath}`);
  }
  const localFailures = [
    ...earlyFailures,
    ...await localPreflight(options, !options.verify, !options.verify, existing, deps.assetProvenancePath),
  ];
  if (options.verify) {
    if (!existing) {
      console.log(JSON.stringify({
        version: 1,
        status: "blocked",
        failures: [...localFailures, `no onboarding state at ${statePath}`],
        state: statePath,
      }, null, 2));
      return 2;
    }
    const failures = [...localFailures, ...await verifyState(options, existing)];
    console.log(JSON.stringify({ version: 1, status: failures.length ? "blocked" : "verified", failures, state: statePath }, null, 2));
    return failures.length ? 2 : 0;
  }
  const auth = localFailures.length
    ? { failures: [], summary: { skipped: "local preflight failed; no profile or remote mutation attempted" } }
    : childEnv ? await authPreflight(options, options.appId, childEnv) : { failures: [], summary: { skipped: "child environment is invalid; no profile or remote mutation attempted" } };
  const backend = localFailures.length
    ? { failures: [], summary: { skipped: "local preflight failed; backend probe not attempted" } }
    : childEnv ? await backendPreflight(options, childEnv) : { failures: [], summary: { skipped: "child environment is invalid; backend probe not attempted" } };
  if (localFailures.length || auth.failures.length || backend.failures.length) {
    console.log(JSON.stringify({
      version: 1,
      status: "human_action_required",
      localFailures,
      auth: auth.summary,
      authFailures: auth.failures,
      backend: backend.summary,
      backendFailures: backend.failures,
      next: [
        `Create/select the isolated profile ${options.profile}; onboarding invokes profile add and never switches the global profile.`,
        `Approve the Lark user authorization URL in auth.authorization (or scan the lark-cli QR), then rerun this same command if the terminal is non-interactive.`,
        "Have the isolated app tenant/admin approve the listed bot scopes; user OAuth is not tenant approval.",
        "Do not reuse production credentials or start an event subscriber until managed-device isolation is verified.",
      ],
    }, null, 2));
    return 2;
  }

  const appId = String(auth.summary.appId);
  const ownerOpenId = options.ownerOpenId ?? auth.userOpenId;
  if (!ownerOpenId) throw new Error("owner open_id was not returned; pass --owner-open-id after user authorization");
  if (existing) {
    validateStateOwnership(options, existing);
    if (existing.appId !== appId || existing.ownerOpenId !== ownerOpenId) {
      throw new Error("onboarding resume stopped: isolated profile identity changed");
    }
  }

  const manifest = await readJson<{ publicRoles: Role[] }>(ROOT_MANIFEST);
  const state: OnboardingState = existing ?? {
    version: 1,
    installId: randomUUID(),
    createdAt: new Date().toISOString(),
    profile: options.profile,
    backend: options.backend,
    appId,
    ownerOpenId,
    sourceRoot: options.sourceRoot,
    runtimeRoot: options.runtimeRoot,
    workspaceRoot: options.workspaceRoot,
    dbPath: options.dbPath,
    statePath,
    apiPort: options.apiPort,
    schedulerPort: options.schedulerPort,
    ...(childEnv ? { childEnv } : {}),
    profileIdentity: { appId, ownerOpenId, ...(auth.botAppId ? { botAppId: auth.botAppId } : {}) },
    roles: manifest.publicRoles.map((role) => ({
      name: role.name,
      purpose: role.purpose,
      ...(role.run ? { run: role.run } : {}),
      ...(role.modulePath ? { modulePath: role.modulePath } : {}),
      ...(role.requiredFiles ? { requiredFiles: role.requiredFiles } : {}),
      ...(role.env ? { env: role.env } : {}),
      ...(role.packagePaths ? { packagePaths: role.packagePaths } : {}),
      workdirKind: role.workdir,
      phase: "planned" as const,
    })),
    status: "planned",
  };
  if (existing) {
    if (!childEnv) throw new Error("onboarding resume stopped: child environment was not captured");
    state.childEnv = childEnv;
    state.profileIdentity = { appId, ownerOpenId, ...(auth.botAppId ? { botAppId: auth.botAppId } : {}) };
  }
  const existingHealthy = existing && await isOwnedHealthyInstance(options, existing);
  // `state` aliases `existing` on resume. `provision` temporarily marks that
  // same object as provisioning, so retain the pre-mutation terminal status
  // before entering the resumable provisioning path.
  const preexistingStatus = existing?.status;
  if (!existing && options.apply) {
    state.schedulerSecretSha256 = await ensureSecretFile(options, "scheduler-admin.secret", randomBytes(32).toString("hex"));
    await saveState(options, state);
  }
  if (!options.apply) {
    console.log(JSON.stringify({
      version: 1,
      status: "preflight_ok",
      state: statePath,
      roles: state.roles.map((role) => role.name),
      permissions: PERMISSION_MANIFEST,
      publicManifest: ROOT_MANIFEST,
      skillsManifest: SKILLS_MANIFEST,
      automatedOnApply: ["dependency installation", "bundled template/skill/module deployment", "profile-scoped authorization wizard", "backend probe", "service and scheduler wiring"],
      humanOnly: ["browser/QR approval and tenant/admin approval when requested by Lark", "maintainer-only live E2E acceptance; not a normal first-install prerequisite"],
      rollback: `npm run onboard -- --rollback --runtime-root ${options.runtimeRoot}`,
    }, null, 2));
    return 0;
  }

  const appSecret = await ensureSecrets(
    options,
    state,
    auth.appSecret ?? process.env.SM_ONBOARD_APP_SECRET ?? await promptSecret("Enter the isolated Lark app secret for the runtime (hidden)"),
  );
  if (!appSecret) {
    console.log(JSON.stringify({
      version: 1,
      status: "human_action_required",
      state: statePath,
      next: ["Enter the isolated app secret in the terminal prompt; it is stored only in a mode-0600 runtime file and never printed.", "Do not provide or copy a production secret."],
    }, null, 2));
    return 2;
  }
  try {
    await ensureGeneratedSecret(options, state, "scheduler-admin.secret");
    await saveState(options, state);
    await ensureBundledRuntime(options, deps.assetProvenancePath);
    const cli = state.childEnv?.larkCliPath ?? process.env.SM_LARK_CLI_PATH ?? "lark-cli";
    if (!state.childEnv) throw new Error("onboarding stopped: child environment was not captured");
    const client = createRealLarkClient({
      larkCliPath: cli,
      profile: options.profile,
      botAppId: appId,
      ownerUserId: ownerOpenId,
      noProxy: true,
      env: childProcessEnv(state.childEnv),
    });
    const gateway = deps.gateway ?? new LarkCliGateway({
      client,
      attachmentDir: (groupId, date) => asAbsolutePath(path.join(options.runtimeRoot, "onboarding-v1", "attachments", groupId, date)),
      logger: createPinoLogger("warn"),
    });
    await provision(options, state, manifest.publicRoles, gateway, deps.assetProvenancePath);
    await writeServiceArtifacts(options, state, manifest.publicRoles);
    state.status = existingHealthy && preexistingStatus ? preexistingStatus : "configured";
    await saveState(options, state);
    const failures = await verifyState(options, state, false);
    if (failures.length) {
      state.status = "blocked";
      state.blocked = failures;
      await saveState(options, state);
      console.log(JSON.stringify({ version: 1, status: "blocked", failures, state: statePath }, null, 2));
      return 2;
    }
    await (deps.startService ?? startService)(options, state, path.join(options.runtimeRoot, "onboarding-v1", "start.sh"));
    state.status = "ready";
    await saveState(options, state);
  } catch (error) {
    state.status = "blocked";
    state.blocked = [redact(error instanceof Error ? error.message : String(error))];
    await saveState(options, state);
    console.log(JSON.stringify({ version: 1, status: "blocked", failures: state.blocked, state: statePath }, null, 2));
    return 2;
  }
  console.log(JSON.stringify({
    version: 1,
    status: "ready",
    state: statePath,
    env: path.join(options.runtimeRoot, "onboarding-v1", ".env.local.generated"),
    start: path.join(options.runtimeRoot, "onboarding-v1", "start.sh"),
    servicePid: state.servicePid,
    skillsManifest: SKILLS_MANIFEST,
    rootGroupId: state.rootGroupId,
    provisioned: state.roles.map((role) => ({ name: role.name, groupId: role.groupId, workdir: role.workdir })),
    humanOnly: [
      "The command starts the generated launcher automatically; it starts the bundled scheduler-v2 with an isolated database before SuperMatrix.",
      "Maintainer-only live inbound/outbound, backend, continuation, delegation, scheduled-result, and restart-persistence checks may later promote ready to live_verified.",
    ],
    rollback: `npm run onboard -- --rollback --runtime-root ${options.runtimeRoot}`,
  }, null, 2));
  return 0;
}

export async function runOnboarding(rawOptions: OnboardingOptions, deps: OnboardingWorkflowDeps = {}): Promise<number> {
  const options = await normalizeOptions(rawOptions);
  if (options.rollback) {
    // Read and bind the historical receipt before withMutationLock creates
    // anything under a caller-supplied path. A mismatched rollback must be a
    // pure rejection, not a mkdir side effect.
    const state = await loadState(options);
    if (!state) throw new Error(`no onboarding state at ${resolveStatePath(options)}`);
    validateStateOwnership(options, state);
  }
  if (options.apply || options.rollback) return await withMutationLock(options, () => runOnboardingUnlocked(options, deps));
  return await runOnboardingUnlocked(options, deps);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function renderHelp(): string {
  return `Usage: npm run onboard -- [--apply] [--verify] [--rollback] [options]

One terminal onboarding path for an isolated SuperMatrix V1 install.

Options:
  --apply                 Create isolated runtime, groups, sessions, and service wiring
  --verify                Read back saved state and verify routing/workspaces
  --rollback              Remove only resources recorded by this onboarding state
  --profile <name>        Dedicated lark-cli profile (default: onboarding-v1)
  --app-id <cli_...>      App id when it cannot be read from the profile
  --owner-open-id <ou_>   User open_id when it cannot be read from the profile
  --backend <kind>        claude | codex | kimi (default: codex)
  --source-root <path>    Sanitized SuperMatrix source root (default: current directory)
  --runtime-root <path>   New runtime root (default: ~/SuperMatrixRuntime-onboarding-v1)
  --workspace-root <path> New workspace root (default: <runtime-root>/workspaces)
  --db <path>             New database path (default: <runtime-root>/data/supermatrix.db)
  --port <number>         Isolated API port (default: 3511)
  --scheduler-port <n>    Isolated scheduler-v2 port (default: --port + 1)
`;
}
