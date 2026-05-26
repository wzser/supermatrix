import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildEnvUpdates, mergeEnvText, parseAuthStatusOpenId, type EnvUpdates } from "./envFile.ts";
import { requiredLarkScopes, runPersonalAgentWizard } from "./personalAgent.ts";

const execFileP = promisify(execFile);
const PROFILE_NAME = "supermatrix";
const ROOT_CONSOLE_NAME = "Super Matrix Console";

export type MatrixInitOptions = {
  repoRoot: string;
  packageRoot: string;
  envPath?: string;
  skipAuth?: boolean;
  skipRootGroup?: boolean;
  skipSelfCheck?: boolean;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

export async function runMatrixInit(options: MatrixInitOptions): Promise<void> {
  const repoRoot = path.resolve(options.repoRoot);
  const packageRoot = path.resolve(options.packageRoot);
  const envPath = options.envPath ?? path.join(repoRoot, ".env");
  const exampleEnvPath = path.join(repoRoot, ".env.example");
  const larkCliPath = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "lark-cli.cmd" : "lark-cli");

  console.log("Super Matrix 初始化将写入本机未跟踪的 .env，不会修改 .env.example。");
  const registration = await runPersonalAgentWizard();

  await configureLarkCli(larkCliPath, registration.appId, registration.appSecret);

  let ownerOpenId = registration.operatorOpenId;
  if (!options.skipAuth) {
    await loginUser(larkCliPath);
    ownerOpenId = await readOwnerOpenId(larkCliPath) ?? ownerOpenId;
  }

  let rootGroupId: string | undefined;
  if (!options.skipRootGroup) {
    try {
      rootGroupId = await createRootConsole(larkCliPath, registration.appId);
    } catch (err) {
      console.warn(`创建 ${ROOT_CONSOLE_NAME} 失败，稍后可手动创建并回填 SM_ROOT_GROUP_ID：${errorMessage(err)}`);
    }
  }

  const initEnvInput = {
    appId: registration.appId,
    appSecret: registration.appSecret,
    tenant: registration.tenant,
    repoRoot,
    ...(ownerOpenId ? { operatorOpenId: ownerOpenId } : {}),
    ...(rootGroupId ? { rootGroupId } : {}),
  };
  const updates = buildEnvUpdates(initEnvInput);

  await writeMergedEnv(envPath, exampleEnvPath, updates);
  await ensureLocalDirs(updates);

  if (shouldRunSelfCheck(Boolean(options.skipSelfCheck), updates)) {
    await runSelfCheck(packageRoot, updates);
  } else {
    console.warn("跳过 self-check：需要先补齐 SM_ROOT_GROUP_ID 和 SM_ROOT_USER_ID 后再运行 npm run self-check。");
  }

  printNextSteps(envPath, rootGroupId);
}

export function shouldRunSelfCheck(skipSelfCheck: boolean, updates: EnvUpdates): boolean {
  if (skipSelfCheck) return false;
  return Boolean(updates.SM_ROOT_GROUP_ID && updates.SM_ROOT_USER_ID);
}

async function configureLarkCli(larkCliPath: string, appId: string, appSecret: string): Promise<void> {
  console.log("配置 lark-cli profile: supermatrix");
  await runWithInput(
    larkCliPath,
    ["config", "init", "--app-id", appId, "--app-secret-stdin", "--name", PROFILE_NAME],
    `${appSecret}\n`,
  );
  try {
    await runCapture(larkCliPath, ["profile", "use", PROFILE_NAME]);
  } catch (err) {
    console.warn(`lark-cli profile use ${PROFILE_NAME} 失败，继续使用当前 profile：${errorMessage(err)}`);
  }
}

async function loginUser(larkCliPath: string): Promise<void> {
  console.log("开始 lark-cli 用户授权。请按终端提示完成扫码/浏览器授权。");
  await runInteractive(larkCliPath, ["auth", "login", "--scope", requiredLarkScopes().join(" ")]);
}

async function readOwnerOpenId(larkCliPath: string): Promise<string | undefined> {
  try {
    const result = await runCapture(larkCliPath, ["auth", "status", "--json"]);
    return parseAuthStatusOpenId(result.stdout);
  } catch (err) {
    console.warn(`读取 lark-cli auth status 失败，将使用扫码用户 open_id：${errorMessage(err)}`);
    return undefined;
  }
}

async function createRootConsole(larkCliPath: string, appId: string): Promise<string> {
  console.log(`创建飞书/Lark root console 群：${ROOT_CONSOLE_NAME}`);
  const result = await runCapture(larkCliPath, [
    "im", "+chat-create",
    "--as", "user",
    "--name", ROOT_CONSOLE_NAME,
    "--type", "private",
    "--bots", appId,
  ]);
  const chatId = findJsonStringField(result.stdout, ["chat_id", "open_chat_id"]);
  if (!chatId) {
    throw new Error(`lark-cli did not return chat_id for ${ROOT_CONSOLE_NAME}: ${result.stdout.slice(0, 500)}`);
  }
  console.log(`✓ ${ROOT_CONSOLE_NAME}: ${chatId}`);
  return chatId;
}

async function writeMergedEnv(envPath: string, exampleEnvPath: string, updates: EnvUpdates): Promise<void> {
  const existing = await readTextIfExists(envPath) ?? await readTextIfExists(exampleEnvPath) ?? "";
  const next = mergeEnvText(existing, updates);
  await mkdir(path.dirname(envPath), { recursive: true });
  const tmp = `${envPath}.tmp-${process.pid}`;
  await writeFile(tmp, next, "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, envPath);
  console.log(`✓ 已更新 ${envPath}`);
}

async function ensureLocalDirs(updates: EnvUpdates): Promise<void> {
  const workspaceRoot = expandLocalPath(updates.SM_WORKSPACE_ROOT);
  const runtimeRoot = expandLocalPath(updates.SM_RUNTIME_ROOT);
  const dbDir = path.dirname(expandLocalPath(updates.SM_DB_PATH));
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(dbDir, { recursive: true });
  console.log(`✓ 已创建本地目录：${workspaceRoot}, ${runtimeRoot}`);
}

async function runSelfCheck(packageRoot: string, updates: EnvUpdates): Promise<void> {
  console.log("运行 npm run self-check");
  await runInteractive("npm", ["run", "self-check"], {
    cwd: packageRoot,
    env: { ...process.env, ...expandedEnv(updates) },
  });
}

function printNextSteps(envPath: string, rootGroupId: string | undefined): void {
  console.log("\n初始化完成。下一步：");
  console.log(`  1. 确认 ${envPath} 只保留在本机，不要提交。`);
  console.log("  2. cd supermatrix && set -a; source ../.env; set +a");
  console.log("  3. npm start");
  if (rootGroupId) {
    console.log(`  4. 在 ${ROOT_CONSOLE_NAME} (${rootGroupId}) 群里发送 /help 和 /status。`);
  } else {
    console.log(`  4. 在你配置的 ${ROOT_CONSOLE_NAME} 群里发送 /help 和 /status。`);
  }
}

async function runCapture(command: string, args: string[]): Promise<CommandResult> {
  return await execFileP(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

async function runWithInput(command: string, args: string[], stdin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
    child.stdin.end(stdin);
  });
}

async function runInteractive(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function findJsonStringField(stdout: string, keys: string[]): string | undefined {
  try {
    return findStringField(JSON.parse(stdout) as unknown, keys);
  } catch {
    return undefined;
  }
}

function findStringField(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].length > 0) return obj[key];
  }
  for (const child of Object.values(obj)) {
    const found = findStringField(child, keys);
    if (found) return found;
  }
  return undefined;
}

function expandedEnv(updates: EnvUpdates): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, expandLocalPath(value)]),
  );
}

function expandLocalPath(value: string): string {
  return value
    .replace(/^\$HOME(?=\/|$)/u, process.env.HOME ?? "")
    .replace(/^\$PWD(?=\/|$)/u, process.cwd());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
