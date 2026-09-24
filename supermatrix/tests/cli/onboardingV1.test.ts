import net from "node:net";
import { access, chmod, constants as fsConstants, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";
import {
  assertPortAvailable,
  buildBackendProbeArgs,
  buildEnv,
  parseBackendProbeOutput,
  parseOnboardingArgs,
  redact,
  resolveStatePath,
  buildAuthLoginArgs,
  copyTree,
  ensureProfile,
  renderStartScript,
  renderSchedulerStartScript,
  runCli,
  backendPreflight,
  localwatchOwnerReceiptPath,
  readProcessIdentity,
  scopeList,
  validateManifestSources,
  validateManifestInventory,
  validateModuleProvenance,
  validatePathLayout,
  validateStateOwnership,
  isOwnedHealthyInstance,
  startService,
  rollback,
  type OnboardingState,
  runOnboarding,
} from "../../src/cli/onboardingV1.ts";

const execFileAsync = promisify(execFile);

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not expose a free port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function processGroupId(pid: number): Promise<number | undefined> {
  const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="]).catch(() => ({ stdout: "" }));
  const value = Number(result.stdout.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function waitForProcessGroupGone(pgid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await execFileAsync("ps", ["-axo", "pid=,pgid="]).catch(() => ({ stdout: "" }));
    const alive = result.stdout.split("\n").some((line) => {
      const match = line.trim().match(/^\d+\s+(\d+)$/u);
      return match ? Number(match[1]) === pgid : false;
    });
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function writeOwnerReceipt(options: Parameters<typeof localwatchOwnerReceiptPath>[0], pid: number, status: "active" | "stopped" = "active"): Promise<void> {
  const identity = await readProcessIdentity(pid);
  if (!identity) throw new Error(`fixture process ${pid} identity unavailable`);
  const root = join(options.runtimeRoot, "onboarding-v1");
  const receipt = {
    version: 1,
    kind: "localwatch-owner",
    status,
    pid,
    processStart: identity.processStart,
    bootId: identity.bootId,
    repoDir: options.sourceRoot,
    scriptPath: join(options.sourceRoot, "scripts/localwatch.sh"),
    cwd: options.sourceRoot,
    installationNamespace: root,
    launcherPath: join(root, "start.sh"),
    healthEndpoints: {
      api: `http://127.0.0.1:${options.apiPort}/api/health`,
      scheduler: `http://127.0.0.1:${options.schedulerPort}/health`,
    },
    publishedAt: new Date().toISOString(),
  };
  await mkdir(root, { recursive: true });
  await writeFile(localwatchOwnerReceiptPath(options), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function fixtureOwnerReceiptBootstrap(options: Parameters<typeof localwatchOwnerReceiptPath>[0]): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const receiptPath = localwatchOwnerReceiptPath(options);
  const root = join(options.runtimeRoot, "onboarding-v1");
  const scriptPath = join(options.sourceRoot, "scripts/localwatch.sh");
  return `node -e ${quote(`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const pid = Number(process.argv[1]);
const receiptPath = process.argv[2];
const root = process.argv[3];
const scriptPath = process.argv[4];
const launcherPath = process.argv[5];
const api = process.argv[6];
const scheduler = process.argv[7];
const processStart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } }).toString().trim().replace(/\\s+/g, " ");
const rawBoot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"]).toString().trim();
const digest = crypto.createHash("md5").update(rawBoot).digest("hex");
const bootId = digest.slice(0, 8) + "-" + digest.slice(8, 12) + "-" + digest.slice(12, 16) + "-" + digest.slice(16, 20) + "-" + digest.slice(20, 32);
const value = { version: 1, kind: "localwatch-owner", status: "active", pid, processStart, bootId, repoDir: path.dirname(path.dirname(scriptPath)), scriptPath, cwd: process.cwd(), installationNamespace: root, launcherPath, healthEndpoints: { api, scheduler }, publishedAt: new Date().toISOString() };
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
const tmp = receiptPath + ".tmp." + pid;
fs.writeFileSync(tmp, JSON.stringify(value) + "\\n", { mode: 0o600 });
fs.renameSync(tmp, receiptPath);
`) } $$ ${quote(receiptPath)} ${quote(root)} ${quote(scriptPath)} ${quote(join(root, "start.sh"))} ${quote(`http://127.0.0.1:${options.apiPort}/api/health`)} ${quote(`http://127.0.0.1:${options.schedulerPort}/health`)}\n`;
}

describe("onboarding V1", () => {
  test("uses one isolated path with a non-production default", () => {
    const options = parseOnboardingArgs(["--profile", "xj-v1", "--backend", "codex"], {});
    expect(options.profile).toBe("xj-v1");
    expect(options.runtimeRoot).toContain("SuperMatrixRuntime-onboarding-v1");
    expect(options.apiPort).toBe(3511);
    expect(resolveStatePath(options)).toContain("onboarding-v1/state.json");
  });

  test("rejects conflicting apply and rollback or an unsafe port", () => {
    expect(() => parseOnboardingArgs(["--apply", "--rollback"], {})).toThrow(/mutually exclusive/u);
    expect(() => parseOnboardingArgs(["--apply", "--verify"], {})).toThrow(/mutually exclusive/u);
    expect(() => parseOnboardingArgs(["--port", "3501"], {})).not.toThrow();
    expect(() => parseOnboardingArgs(["--port", "80"], {})).toThrow(/1024/u);
  });

  test("redacts secrets and device artifacts from receipts", () => {
    expect(redact("app_secret=abc access_token=def device_code=ghi LARK_APP_SECRET=jkl")).toBe(
      "app_secret=[redacted] access_token=[redacted] device_code=[redacted] LARK_APP_SECRET=[redacted]",
    );
    expect(redact('{"access_token":"abc","LARK_APP_SECRET":"def"}')).toBe(
      '{"access_token":"[redacted]","LARK_APP_SECRET":"[redacted]"}',
    );
  });

  test("treats parseable JSON on an exit-0 CLI call as successful without a top-level ok", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-cli-result-");
    const cli = join(root, "lark-cli");
    try {
      await writeFile(cli, "#!/bin/sh\nprintf '%s\\n' '{\"verified\":true,\"identities\":[\"user\"],\"tokenStatus\":\"valid\"}'\n", { mode: 0o700 });
      await expect(runCli(cli, "isolated", ["auth", "status", "--json", "--verify"])).resolves.toMatchObject({
        ok: true,
        verified: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies a real temporary tree with executable bits and no special bits", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-copy-tree-");
    const source = join(root, "source");
    const destination = join(root, "destination");
    const executable = join(source, "bin", "entrypoint");
    const data = join(source, "data", "config.json");
    try {
      await mkdir(join(source, "bin"), { recursive: true });
      await mkdir(join(source, "data"), { recursive: true });
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(executable, 0o4755);
      await writeFile(data, "{}\n", { mode: 0o644 });
      await mkdir(join(destination, "bin"), { recursive: true });
      await writeFile(join(destination, "bin", "entrypoint"), "stale\n", { mode: 0o644 });

      await copyTree(source, destination);

      const executableMode = (await lstat(join(destination, "bin", "entrypoint"))).mode;
      const dataMode = (await lstat(join(destination, "data", "config.json"))).mode;
      expect(executableMode & 0o777).toBe(0o755);
      expect(executableMode & 0o7000).toBe(0);
      expect(dataMode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deduplicates permission union", () => {
    expect(scopeList({ identities: { user: { required: ["im:message", "im:chat:read"] }, bot: { required: ["im:message"] } } })).toEqual(["im:chat:read", "im:message"]);
  });

  test("uses the live lark-cli help contract and one complete sorted scope argument", async () => {
    const cli = join(process.cwd(), "node_modules", "@larksuite", "cli", "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
    const loginHelp = await execFileAsync(cli, ["auth", "login", "--help"], { maxBuffer: 1_000_000 });
    const initHelp = await execFileAsync(cli, ["config", "init", "--help"], { maxBuffer: 1_000_000 });
    expect(`${loginHelp.stdout}\n${loginHelp.stderr}`).toMatch(/--scope string/u);
    expect(`${loginHelp.stdout}\n${loginHelp.stderr}`).toMatch(/space- or comma-separated/u);
    expect(`${initHelp.stdout}\n${initHelp.stderr}`).toMatch(/--new/iu);
    expect(`${initHelp.stdout}\n${initHelp.stderr}`).toMatch(/--name string/u);
    expect(buildAuthLoginArgs(["im:message", "im:chat:read", "im:message", "im:chat:read"])).toEqual([
      "auth", "login", "--no-wait", "--json", "--scope", "im:chat:read,im:message",
    ]);
  });

  test("creates a missing named profile through config init without reading the global profile", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-profile-init-");
    const cli = join(root, "lark-cli");
    const calls = join(root, "calls");
    const savedSecret = process.env.SM_ONBOARD_APP_SECRET;
    try {
      await writeFile(cli, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SM_ONBOARD_TEST_CALLS"
case "$*" in
  "--profile new-profile config show") printf '%s\\n' '{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"profile not found"}}'; exit 1 ;;
  "config init --new --name new-profile") printf '%s\\n' 'created app cli_new_app in profile new-profile'; exit 0 ;;
  *) printf '%s\\n' 'unexpected argv' >&2; exit 1 ;;
esac
`, { mode: 0o700 });
      process.env.SM_ONBOARD_TEST_CALLS = calls;
      process.env.SM_ONBOARD_APP_SECRET = "new-profile-secret";
      const result = await ensureProfile(cli, parseOnboardingArgs(["--profile", "new-profile"], {}));
      expect(result).toEqual({ appId: "cli_new_app", appSecret: "new-profile-secret" });
      expect(await readFile(calls, "utf8")).toBe("--profile new-profile config show\nconfig init --new --name new-profile\n");
    } finally {
      if (savedSecret === undefined) delete process.env.SM_ONBOARD_APP_SECRET;
      else process.env.SM_ONBOARD_APP_SECRET = savedSecret;
      delete process.env.SM_ONBOARD_TEST_CALLS;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the isolated API port is occupied", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    await expect(assertPortAvailable(address.port)).rejects.toThrow(`port ${address.port} is already in use`);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("rejects production overlap, outside state, and symlink-shaped layouts", () => {
    expect(() => validatePathLayout({
      sourceRoot: "/tmp/sm-source",
      runtimeRoot: "/tmp/sm-source/runtime",
      workspaceRoot: "/tmp/sm-source/runtime/workspaces",
      dbPath: "/tmp/sm-source/runtime/data/db",
    })).toThrow(/disjoint/u);
    expect(() => validatePathLayout({
      sourceRoot: "/tmp/sm-source",
      runtimeRoot: "/tmp/sm-runtime",
      workspaceRoot: "/tmp/sm-workspaces",
      dbPath: "/tmp/sm-runtime/data/db",
    })).toThrow(/workspace root/u);
  });

  test("requires structured output and the exact marker for a real backend probe", () => {
    expect(parseBackendProbeOutput("codex", "0\n")).toEqual({ ok: false, structured: false, marker: false });
    expect(parseBackendProbeOutput("codex", JSON.stringify({ type: "completed", text: "SM_ONBOARDING_PROBE_OK" }))).toEqual({
      ok: true,
      structured: true,
      marker: true,
    });
  });

  test("gives Claude provider-routed probes enough budget to emit the marker", () => {
    const args = buildBackendProbeArgs("claude", "SM_ONBOARDING_PROBE_OK");
    expect(args).toEqual([
      "-p", "--output-format", "json", "--no-session-persistence", "--max-budget-usd", "0.25", "SM_ONBOARDING_PROBE_OK",
    ]);
    expect(args).not.toContain("0.01");
  });

  test("accepts the Claude probe after the provider-routed budget adjustment", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-backend-probe-");
    const backend = join(root, "claude");
    const argsFile = join(root, "args");
    const environment = {
      home: join(root, "home"),
      xdgConfigHome: join(root, "xdg-config"),
      codexHome: join(root, "codex-home"),
      path: "/usr/bin:/bin",
      nodePath: "/usr/bin/node",
      npmPath: "/usr/bin/npm",
      pythonPath: "/usr/bin/python3",
      larkCliPath: "/usr/bin/lark-cli",
      backendPath: backend,
    };
    try {
      await writeFile(backend, `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'claude fixture'
else
  printf '%s\\n' "$*" > "${argsFile}"
  printf '%s\\n' '{"type":"result","result":"SM_ONBOARDING_PROBE_OK"}'
fi
`, { mode: 0o700 });
      const options = parseOnboardingArgs(["--backend", "claude", "--runtime-root", root], {});
      await expect(backendPreflight(options, environment)).resolves.toMatchObject({ failures: [] });
      expect(await readFile(argsFile, "utf8")).toContain("--max-budget-usd 0.25");
      expect(await readFile(argsFile, "utf8")).not.toContain("0.01");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ships the public module inventory and refuses missing module sources before writes", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "config/onboarding-v1/platform-manifest.json"), "utf8")) as {
      publicRoles: Array<{ name: string; modulePath?: string; run?: string; requiredFiles?: string[] }>;
    };
    const roles = new Map(manifest.publicRoles.map((role) => [role.name, role]));
    expect(roles.get("localgit")?.modulePath).toBe("platform/localgit");
    expect(roles.get("socail-king")?.modulePath).toBe("platform/socail-king");
    expect(roles.get("heartbeat")?.run).toBe("scripts/heartbeat-patrol");
    expect(roles.get("socail-king")?.run).toBe("npm run verify");
    expect(roles.get("autobitable")?.run).toBe("npm --prefix public-safe run verify");
    expect(roles.get("autobitable")?.requiredFiles).toEqual([
      "src/server.mjs",
      "public-safe/.gitignore",
      "public-safe/README.md",
      "public-safe/package.json",
      "public-safe/package-lock.json",
      "public-safe/config/tenant.example.env",
      "public-safe/examples/webhook.prompt.json",
      "public-safe/registry/bitable-webhooks.empty.json",
      "public-safe/scripts/register-webhook-secret.mjs",
      "public-safe/src/server.mjs",
      "public-safe/tests/adapter.test.mjs",
      "public-safe/tests/secret-registration.test.mjs",
    ]);
    expect(roles.get("autobitable")?.requiredFiles?.every((file) => file === "src/server.mjs" || file.startsWith("public-safe/"))).toBe(true);
    expect(roles.get("localgit")?.run).toBe("npm run git-ledger -- --help");
    const root = await mkdtemp("/tmp/sm-onboard-manifest-");
    try {
      const options = parseOnboardingArgs(["--source-root", root, "--runtime-root", join(root, "runtime")], {});
      await expect(validateManifestSources(options, [{
        name: "missing", purpose: "test", workdir: "module", modulePath: "platform/missing", run: "npm start",
      }])).resolves.toEqual([expect.stringContaining("public module source is missing")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires every build-time platform inventory entry to have one disposition", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "config/onboarding-v1/platform-manifest.json"), "utf8")) as {
      publicRoles: Array<{ name: string; purpose: string; workdir: "source" | "workspace" | "module" }>;
      inventory: { platformNames: string[]; distributionNames?: string[] };
      inventoryDisposition: Array<{ name: string; disposition: string; of?: string }>;
    };
    expect(validateManifestInventory(manifest)).toEqual([]);
    expect(manifest.inventory.platformNames).toHaveLength(12);
  });

  test("accepts approved package metadata while preserving pending source review", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "config/onboarding-v1/platform-manifest.json"), "utf8"));
    const packageVersion = (JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
    const packageProvenance = JSON.parse(await readFile(join(process.cwd(), "config/onboarding-v1/asset-provenance.json"), "utf8"));
    expect(["0.1.0", "0.3.0", "0.3.1", "0.3.2"]).toContain(packageVersion);
    const isFinalPackage = packageVersion === "0.3.0" || packageVersion === "0.3.1" || packageVersion === "0.3.2";
    const expectedPackageStatus = isFinalPackage ? "approved" : "pending-owner-review";
    expect(packageProvenance.modules.every((entry: { reviewStatus: string }) => entry.reviewStatus === expectedPackageStatus)).toBe(true);
    const finalPackageProvenance = isFinalPackage
      ? packageProvenance
      : {
          ...packageProvenance,
          modules: packageProvenance.modules.map((entry: Record<string, unknown>) => ({ ...entry, reviewStatus: "approved" })),
        };
    expect(finalPackageProvenance.modules.every((entry: { reviewStatus: string }) => entry.reviewStatus === "approved")).toBe(true);
    expect(validateModuleProvenance(manifest, finalPackageProvenance)).toEqual([]);
    expect(manifest.publicRoles.find((role: { name: string }) => role.name === "larkc").requiredFiles).toContain("public-input/card-callback-public-manifest.json");
    expect(manifest.publicRoles.find((role: { name: string }) => role.name === "mythos").requiredFiles).toContain("public/README.md");
    expect(manifest.publicRoles.find((role: { name: string }) => role.name === "mythos").env).toEqual({ MYTHOS_KB_ROOT: "$MODULE_ROOT/public" });
    expect(manifest.supportModules.find((role: { name: string }) => role.name === "wendangwang")).toBeDefined();
  });

  test("keeps module provenance aligned with the current public-export allowlists", async () => {
    const provenance = JSON.parse(await readFile(join(process.cwd(), "config/onboarding-v1/asset-provenance.json"), "utf8")) as {
      modules: Array<{ name: string; commit: string; sourceRoot: string; include: string[] }>;
    };
    const modules = new Map(provenance.modules.map((entry) => [entry.name, entry]));
    expect(modules.get("mythos")).toMatchObject({
      commit: "a29638922f59a1e047f565a3c7f34a04d0c2a7de",
      sourceRoot: ".",
      include: [
        ".python-version", "pyproject.toml", "public/.gitignore", "public/README.md", "public/DEPENDENCIES.md",
        "public/THIRD_PARTY_NOTICES.md", "public/third-party/a2a-LICENSE", "public/third-party/mcp-LICENSE",
        "public/config/**", "public/fixtures/query-fixture.jsonl", "public/kb/**", "scripts/build-index.py",
        "scripts/rebuild-map.py", "scripts/log-query.py", "scripts/sync-kb.sh", "tests/test_public_seed.py",
      ],
    });
    expect(modules.get("skill-master")?.include).toContain("tests/test_evaluate_spawn_endpoint.py");
    expect(modules.get("localgit")).toMatchObject({
      commit: "cd6fe3018f644f1c9e55998b355c48372b115708",
      sourceRoot: ".",
      include: expect.arrayContaining(["config/localgit-role.json", "config/daily-commit-bitable.example.json"]),
    });
    expect(modules.get("larkc")).toMatchObject({
      commit: "57cf7c6c9d7fdcb0a0053b0500196ceec5e1400c",
      include: expect.arrayContaining(["public-input/verify-public-input.test.mjs"]),
    });
    for (const name of ["mythos", "skill-master", "localgit", "larkc"]) {
      expect(modules.get(name)?.include.some((pattern) => /(?:node_modules|dist|logs|runs|__pycache__)/u.test(pattern))).toBe(false);
    }
  });

  test("keeps the complete core bot permission baseline in the owner union", async () => {
    const permissions = JSON.parse(await readFile(join(process.cwd(), "config/onboarding-v1/permissions.json"), "utf8"));
    const coreBotScopes = [
      "im:message", "im:message:readonly", "im:message:update", "im:message.p2p_msg:readonly",
      "im:chat:read", "im:chat.members:read", "im:resource", "docs:document.media:download",
      "drive:file:download", "drive:file:upload", "docs:document.comment:read",
      "docs:document.comment:create", "docs:document.comment:write_only",
    ];
    expect(permissions.identities.bot.required).toEqual(expect.arrayContaining(coreBotScopes));
  });

  test("validates a public module layout without node_modules and checks Python metadata", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-public-layout-");
    try {
      const roles = [
        { name: "skill-master", purpose: "", workdir: "module" as const, modulePath: "platform/skill-master", run: ".venv/bin/python scripts/validate-skill-frontmatter.py --help", requiredFiles: ["pyproject.toml", ".python-version", "scripts/validate-skill-frontmatter.py"] },
        { name: "gitmaster", purpose: "", workdir: "module" as const, modulePath: "platform/gitmaster", run: ".venv/bin/python scripts/sanitized_release.py --help", requiredFiles: ["pyproject.toml", ".python-version", "scripts/sanitized_release.py"] },
      ];
      for (const role of roles) {
        const module = join(root, role.modulePath);
        await mkdir(join(module, "scripts"), { recursive: true });
        await writeFile(join(module, "pyproject.toml"), "[project]\nname = 'public-module'\nrequires-python = '>=3.11,<3.12'\n");
        await writeFile(join(module, ".python-version"), "3.11.15\n");
        await writeFile(join(module, role.name === "skill-master" ? "scripts/validate-skill-frontmatter.py" : "scripts/sanitized_release.py"), "print('ok')\n");
      }
      const options = parseOnboardingArgs(["--source-root", root, "--runtime-root", join(root, "runtime")], {});
      await expect(validateManifestSources(options, roles)).resolves.toEqual([]);
      expect(await readFile(join(root, "platform/skill-master/pyproject.toml"), "utf8")).toContain("requires-python");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bootstraps from a clean public directory before loading the TypeScript entrypoint", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-bootstrap-");
    const fakeNpm = join(root, "fake-npm.sh");
    const receipt = join(root, "receipt");
    try {
      await writeFile(fakeNpm, `#!/bin/sh
set -eu
mkdir -p "$SM_BOOTSTRAP_FIXTURE/node_modules/.bin"
cat > "$SM_BOOTSTRAP_FIXTURE/node_modules/.bin/tsx" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$SM_BOOTSTRAP_RECEIPT"
EOF
cat > "$SM_BOOTSTRAP_FIXTURE/node_modules/.bin/lark-cli" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$SM_BOOTSTRAP_FIXTURE/node_modules/.bin/tsx" "$SM_BOOTSTRAP_FIXTURE/node_modules/.bin/lark-cli"
`, { mode: 0o700 });
      await execFileAsync(process.execPath, [join(process.cwd(), "scripts/sm-onboard-bootstrap.mjs"), "--source-root", root, "--help"], {
        env: { ...process.env, SM_ONBOARD_NPM: fakeNpm, SM_BOOTSTRAP_FIXTURE: root, SM_BOOTSTRAP_RECEIPT: receipt },
        timeout: 10_000,
      });
      const invocation = await readFile(receipt, "utf8");
      expect(invocation).toContain(join(root, "scripts/sm-onboard.ts"));
      expect(invocation).toContain("--help");
      expect(invocation).not.toContain("auth");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quotes hostile paths and makes scheduler startup idempotent", () => {
    const options = parseOnboardingArgs([
      "--runtime-root", "/tmp/onboard space;safe", "--workspace-root", "/tmp/onboard space;safe/workspaces",
    ], {});
    const state = {
      version: 1 as const, installId: "install-1", createdAt: "2026-09-11T00:00:00.000Z", profile: "safe;profile",
      backend: "codex" as const, appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot,
      runtimeRoot: options.runtimeRoot, workspaceRoot: options.workspaceRoot, dbPath: options.dbPath,
      statePath: resolveStatePath(options), apiPort: options.apiPort, schedulerPort: options.schedulerPort,
      childEnv: {
        home: join(options.runtimeRoot, "home"), xdgConfigHome: join(options.runtimeRoot, "xdg-config"), codexHome: join(options.runtimeRoot, "codex-home"),
        path: "/opt/pinned/python/bin:/opt/pinned/codex/bin:/opt/pinned/node/bin:/opt/pinned/lark/bin:/usr/bin:/bin",
        nodePath: "/opt/pinned/node/bin/node", npmPath: "/opt/pinned/node/bin/npm", pythonPath: "/opt/pinned/python/bin/python3",
        larkCliPath: "/opt/pinned/lark/bin/lark-cli", backendPath: "/opt/pinned/codex/bin/codex",
      }, instanceSecretSha256: "hash",
      schedulerSecretSha256: "hash", profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" }, roles: [], status: "configured" as const,
    };
    const env = buildEnv(options, state);
    expect(env).toContain("LARK_CLI_PROFILE='safe;profile'");
    expect(env).toContain("SM_RUNTIME_ROOT='/tmp/onboard space;safe'");
    expect(env).toContain(`SM_SCHEDULER_BASE_URL='http://127.0.0.1:${options.schedulerPort}'`);
    expect(env).toContain("HOME='/tmp/onboard space;safe/home'");
    expect(env).toContain("XDG_CONFIG_HOME='/tmp/onboard space;safe/xdg-config'");
    expect(env).toContain("CODEX_HOME='/tmp/onboard space;safe/codex-home'");
    expect(env).toContain("SM_ONBOARD_NODE='/opt/pinned/node/bin/node'");
    expect(env).toContain("SM_LARK_CLI_PATH='/opt/pinned/lark/bin/lark-cli'");
    expect(env).toContain("SM_CODEX_CLI_PATH='/opt/pinned/codex/bin/codex'");
    expect(env).not.toContain("SM_CLAUDE_CLI_PATH=");
    expect(env).not.toContain("SM_KIMI_CLI_PATH=");
    for (const [backend, variable] of [["claude", "SM_CLAUDE_CLI_PATH"], ["codex", "SM_CODEX_CLI_PATH"], ["kimi", "SM_KIMI_CLI_PATH"]] as const) {
      const backendEnv = buildEnv({ ...options, backend }, { ...state, backend });
      expect(backendEnv).toContain(`${variable}='/opt/pinned/codex/bin/codex'`);
      for (const other of ["SM_CLAUDE_CLI_PATH", "SM_CODEX_CLI_PATH", "SM_KIMI_CLI_PATH"]) {
        if (other !== variable) expect(backendEnv).not.toContain(`${other}=`);
      }
    }
    expect(env).toContain(`SM_CARD_ASK_MCP_SERVER_PATH=${JSON.stringify(join(options.runtimeRoot, "onboarding-v1/modules/larkc/card-callback/src/mcpAskServer.js"))}`.replaceAll('"', "'"));
    expect(env).toContain(`SM_LOCALWATCH_OWNER_RECEIPT_PATH=${JSON.stringify(localwatchOwnerReceiptPath(options))}`.replaceAll('"', "'"));
    expect(env).toContain(`SM_LOCALWATCH_INSTALLATION_NAMESPACE=${JSON.stringify(join(options.runtimeRoot, "onboarding-v1"))}`.replaceAll('"', "'"));
    expect(env).toContain("SM_DRIVE_COMMENT_SUBSCRIPTION_ENABLED=0");
    expect(env).not.toContain("127.0.0.1:3502");
    expect(env).not.toContain("LARK_APP_SECRET=");
    expect(() => buildEnv(options, {
      ...state,
      childEnv: { ...state.childEnv, path: "relative/bin:/usr/bin" },
    })).toThrow(/absolute path/u);
    const start = renderStartScript(options, state, "/tmp/onboard space;safe/onboarding-v1/scheduler-start.sh");
    expect(env).toContain("SM_LOCALWATCH_SCRIPT=");
    expect(start).toContain('exec bash "$SM_LOCALWATCH_SCRIPT"');
    expect(start).not.toContain("kill -0");
    expect(start).not.toContain("/api/spawn");
  });

  test("keeps the generated scheduler launcher exec-based", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-scheduler-");
    const moduleRoot = join(root, "scheduler");
    const fakeBin = join(root, "bin");
    const count = join(root, "scheduler-starts");
    const server = join(root, "server.mjs");
    const start = join(root, "scheduler-start.sh");
    const port = 39000 + Math.floor(Math.random() * 500);
    try {
      await mkdir(join(moduleRoot, "node_modules"), { recursive: true });
      await mkdir(join(moduleRoot, "dist"), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(moduleRoot, "dist/main.js"), "// fixture\n");
      await writeFile(server, "import http from 'node:http';\nconst server=http.createServer((_req,res)=>{res.writeHead(200);res.end('ok');});\nserver.listen(Number(process.env.SCHEDULER_V2_PORT),'127.0.0.1');\n");
      await writeFile(join(fakeBin, "npm"), `#!/bin/sh
set -eu
echo start >> "$SM_SCHEDULER_COUNT"
exec node "$SM_SCHEDULER_SERVER"
`, { mode: 0o700 });
      await writeFile(start, renderSchedulerStartScript(moduleRoot, { runtimeRoot: root, dbPath: join(root, "data", "state.db") }, port), { mode: 0o700 });
      const child = spawn(start, [], {
        cwd: moduleRoot,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, SM_API_PORT: "39100", SM_SCHEDULER_COUNT: count, SM_SCHEDULER_SERVER: server },
      });
      child.unref();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) break;
        } catch { /* wait for the real generated process */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await expect(fetch(`http://127.0.0.1:${port}/health`)).resolves.toMatchObject({ ok: true });
      const generated = await readFile(start, "utf8");
      expect(generated).toContain("exec env SCHEDULER_V2_HOST");
      expect((await readFile(count, "utf8")).trim()).toBe("start");
      process.kill(child.pid!, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recognizes an owned healthy instance before checking occupied ports", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-owned-instance-");
    const source = join(root, "source");
    const runtime = join(root, "runtime");
    const fakeBin = join(root, "bin");
    const server = join(root, "server.mjs");
    const apiPort = 39500 + Math.floor(Math.random() * 200);
    const schedulerPort = apiPort + 1;
    try {
      await mkdir(source, { recursive: true });
      await mkdir(join(source, "scripts"), { recursive: true });
      await mkdir(join(source, "scripts/lib"), { recursive: true });
      await writeFile(join(source, "scripts/localwatch.sh"), await readFile(join(process.cwd(), "scripts/localwatch.sh")), { mode: 0o700 });
      await writeFile(join(source, "scripts/lib/localwatch-identity.sh"), await readFile(join(process.cwd(), "scripts/lib/localwatch-identity.sh")), { mode: 0o700 });
      await mkdir(fakeBin, { recursive: true });
      await mkdir(join(runtime, "onboarding-v1"), { recursive: true });
      await mkdir(join(source, "node_modules/.bin"), { recursive: true });
      await writeFile(server, "import http from 'node:http';\nconst p=Number(process.env.TEST_PORT);http.createServer((_q,r)=>{r.writeHead(200);r.end('ok');}).listen(p,'127.0.0.1');\n");
      await writeFile(join(fakeBin, "npm"), "#!/bin/sh\nif [ -n \"${SCHEDULER_V2_HOST:-}\" ]; then export TEST_PORT=\"$SCHEDULER_V2_PORT\"; else export TEST_PORT=\"$SM_API_PORT\"; fi\nexec node \"$SM_ONBOARD_TEST_SERVER\"\n", { mode: 0o700 });
      await writeFile(join(source, "node_modules/.bin/tsx"), "#!/bin/sh\nexport TEST_PORT=\"$SM_API_PORT\"\nexec node \"$SM_ONBOARD_TEST_SERVER\"\n", { mode: 0o700 });
      const options = parseOnboardingArgs(["--source-root", source, "--runtime-root", runtime, "--workspace-root", join(runtime, "workspaces"), "--profile", "isolated", "--port", String(apiPort), "--scheduler-port", String(schedulerPort)], {});
      const state: OnboardingState = {
        version: 1 as const, installId: "owned", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex" as const,
        appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot, runtimeRoot: options.runtimeRoot,
        workspaceRoot: options.workspaceRoot, dbPath: options.dbPath, statePath: resolveStatePath(options), apiPort, schedulerPort,
        schedulerSecretSha256: "hash", childEnv: {
          home: join(runtime, "home"), xdgConfigHome: join(runtime, "xdg-config"), codexHome: join(runtime, "codex-home"),
          path: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`, nodePath: process.execPath, npmPath: join(fakeBin, "npm"),
          pythonPath: "/usr/bin/python3", larkCliPath: join(source, "node_modules/.bin/lark-cli"), backendPath: join(fakeBin, "codex"),
        }, profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" }, roles: [], status: "ready" as const,
      };
      await writeFile(join(runtime, "onboarding-v1", ".env.local.generated"), buildEnv(options, state).replace("SM_ONBOARD_NPM='npm'", `SM_ONBOARD_NPM=${JSON.stringify(join(fakeBin, "npm"))}`));
      await writeFile(join(runtime, "onboarding-v1", "lark-app.secret"), "app\n");
      await writeFile(join(runtime, "onboarding-v1", "scheduler-admin.secret"), "scheduler\n");
      const start = join(runtime, "onboarding-v1", "start.sh");
      const schedulerStart = join(runtime, "onboarding-v1", "scheduler-start.sh");
      await mkdir(join(runtime, "onboarding-v1", "scheduler-module", "node_modules"), { recursive: true });
      await mkdir(join(runtime, "onboarding-v1", "scheduler-module", "dist"), { recursive: true });
      await writeFile(join(runtime, "onboarding-v1", "scheduler-module", "dist/main.js"), "// fixture\n");
      await writeFile(schedulerStart, renderSchedulerStartScript(join(runtime, "onboarding-v1", "scheduler-module"), { runtimeRoot: runtime, dbPath: join(runtime, "data", "state.db") }, schedulerPort), { mode: 0o700 });
      await writeFile(start, renderStartScript(options, state, schedulerStart), { mode: 0o700 });
      const child = spawn(start, [], { cwd: source, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, SM_ONBOARD_TEST_SERVER: server } });
      child.unref();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const [api, scheduler] = await Promise.all([fetch(`http://127.0.0.1:${apiPort}/api/health`), fetch(`http://127.0.0.1:${schedulerPort}/health`)]);
          if (api.ok && scheduler.ok) break;
        } catch { /* wait for both generated child processes */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!child.pid) throw new Error("fixture start did not return a pid");
      state.servicePid = child.pid;
      await writeFile(join(runtime, "onboarding-v1", "service.pid"), `${child.pid}\n`);
      await writeOwnerReceipt(options, child.pid);
      await expect(isOwnedHealthyInstance(options, state)).resolves.toBe(true);
      const pgid = await processGroupId(child.pid!);
      if (pgid) {
        try { process.kill(-pgid, "SIGTERM"); } catch { /* fixture already exited */ }
        if (!await waitForProcessGroupGone(pgid)) {
          try { process.kill(-pgid, "SIGKILL"); } catch { /* fixture already exited */ }
          expect(await waitForProcessGroupGone(pgid)).toBe(true);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("follows a successor/native start receipt when state.servicePid is stale", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-owner-handoff-");
    const source = join(root, "source");
    const runtime = join(root, "runtime");
    const start = join(runtime, "onboarding-v1", "start.sh");
    const health = join(root, "health.mjs");
    const apiPort = await freePort();
    let schedulerPort = await freePort();
    while (schedulerPort === apiPort) schedulerPort = await freePort();
    const options = parseOnboardingArgs(["--source-root", source, "--runtime-root", runtime, "--profile", "isolated", "--port", String(apiPort), "--scheduler-port", String(schedulerPort)], {});
    const state: OnboardingState = {
      version: 1, installId: "handoff", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex",
      appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot, runtimeRoot: options.runtimeRoot,
      workspaceRoot: options.workspaceRoot, dbPath: options.dbPath, statePath: resolveStatePath(options), apiPort, schedulerPort,
      roles: [], status: "ready", profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
    };
    let healthPid: number | undefined;
    const ownerPids: number[] = [];
    try {
      await mkdir(join(source, "scripts"), { recursive: true });
      await mkdir(join(runtime, "onboarding-v1"), { recursive: true });
      await writeFile(join(source, "scripts/localwatch.sh"), "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o700 });
      await writeFile(start, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o700 });
      await writeFile(health, `import http from "node:http"; for (const port of [${apiPort}, ${schedulerPort}]) http.createServer((_q, r) => { r.writeHead(200); r.end("ok"); }).listen(port, "127.0.0.1");\n`);
      const healthChild = spawn(process.execPath, [health], { cwd: source, stdio: "ignore" });
      healthChild.unref();
      healthPid = healthChild.pid;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          const [api, scheduler] = await Promise.all([fetch(`http://127.0.0.1:${apiPort}/api/health`), fetch(`http://127.0.0.1:${schedulerPort}/health`)]);
          if (api.ok && scheduler.ok) break;
        } catch { /* wait for both local fixture listeners */ }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const first = spawn(start, [], { cwd: source, detached: true, stdio: "ignore" });
      first.unref();
      if (!first.pid) throw new Error("handoff A did not return a pid");
      ownerPids.push(first.pid);
      await writeOwnerReceipt(options, first.pid);
      state.servicePid = first.pid;
      await expect(isOwnedHealthyInstance(options, state)).resolves.toBe(true);
      const firstReceipt = await readFile(localwatchOwnerReceiptPath(options), "utf8");
      const firstPgid = await processGroupId(first.pid);
      if (firstPgid) process.kill(-firstPgid, "SIGKILL");
      if (firstPgid) expect(await waitForProcessGroupGone(firstPgid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const successor = spawn(start, [], { cwd: source, detached: true, stdio: "ignore" });
      successor.unref();
      if (!successor.pid) throw new Error("handoff B did not return a pid");
      ownerPids.push(successor.pid);
      await writeOwnerReceipt(options, successor.pid);
      const secondReceipt = JSON.parse(await readFile(localwatchOwnerReceiptPath(options), "utf8")) as { pid: number; processStart: string; bootId: string };
      const firstParsed = JSON.parse(firstReceipt) as { pid: number; processStart: string; bootId: string };
      expect(secondReceipt.pid).not.toBe(firstParsed.pid);
      expect(secondReceipt.processStart).not.toBe(firstParsed.processStart);
      expect(secondReceipt.bootId).toBe(firstParsed.bootId);
      expect(await isOwnedHealthyInstance(options, state)).toBe(true);
      await expect(startService(options, state, start, 1_000)).resolves.toBe(successor.pid);
      expect(state.servicePid).toBe(successor.pid);

      await writeFile(localwatchOwnerReceiptPath(options), JSON.stringify({ ...secondReceipt, bootId: "00000000-0000-0000-0000-000000000000" }));
      await expect(isOwnedHealthyInstance(options, state)).resolves.toBe(false);
      await rm(localwatchOwnerReceiptPath(options), { force: true });
      await expect(isOwnedHealthyInstance(options, state)).resolves.toBe(false);
    } finally {
      for (const pid of ownerPids) {
        const pgid = await processGroupId(pid);
        if (pgid) {
          try { process.kill(-pgid, "SIGKILL"); } catch { /* fixture already exited */ }
        }
      }
      if (healthPid) {
        try { process.kill(healthPid, "SIGKILL"); } catch { /* fixture already exited */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("rejects a reused PID and a supervisor with one dead isolated health endpoint", async () => {
    const reusedRoot = await mkdtemp("/tmp/sm-onboard-reused-pid-");
    const reusedOptions = parseOnboardingArgs(["--runtime-root", join(reusedRoot, "runtime"), "--source-root", reusedRoot], {});
    const reusedState: OnboardingState = {
      version: 1, installId: "reused", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex",
      appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: reusedOptions.sourceRoot, runtimeRoot: reusedOptions.runtimeRoot,
      workspaceRoot: reusedOptions.workspaceRoot, dbPath: reusedOptions.dbPath, statePath: resolveStatePath(reusedOptions),
      apiPort: reusedOptions.apiPort, schedulerPort: reusedOptions.schedulerPort, roles: [], status: "ready",
      servicePid: process.pid, profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
    };
    try {
      await expect(isOwnedHealthyInstance(reusedOptions, reusedState)).resolves.toBe(false);
    } finally {
      await rm(reusedRoot, { recursive: true, force: true });
    }

    const root = await mkdtemp("/tmp/sm-onboard-dead-health-");
    const start = join(root, "start.sh");
    const server = join(root, "server.mjs");
    const apiPort = 39900 + Math.floor(Math.random() * 100);
    const options = parseOnboardingArgs(["--source-root", root, "--runtime-root", join(root, "runtime"), "--port", String(apiPort), "--scheduler-port", String(apiPort + 1)], {});
    let childPid: number | undefined;
    try {
      await writeFile(server, "import http from 'node:http'; http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); }).listen(Number(process.env.TEST_API_PORT), '127.0.0.1');\n");
      await writeFile(start, "#!/bin/sh\nnode \"$TEST_SERVER\" & child=$!\ntrap 'kill \"$child\" 2>/dev/null || true; wait \"$child\" 2>/dev/null || true' INT TERM EXIT\nwait \"$child\"\n", { mode: 0o700 });
      const child = spawn(start, [], { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, TEST_SERVER: server, TEST_API_PORT: String(apiPort) } });
      child.unref();
      if (!child.pid) throw new Error("dead-health fixture did not return a pid");
      childPid = child.pid;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          if ((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok) break;
        } catch { /* wait for the API fixture */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const state: OnboardingState = {
        version: 1, installId: "dead-health", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex",
        appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot, runtimeRoot: options.runtimeRoot,
        workspaceRoot: options.workspaceRoot, dbPath: options.dbPath, statePath: resolveStatePath(options), apiPort, schedulerPort: apiPort + 1,
        roles: [], status: "ready", servicePid: child.pid, profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
      };
      await expect(isOwnedHealthyInstance(options, state)).resolves.toBe(false);
    } finally {
      if (childPid) {
        try { process.kill(-childPid, "SIGTERM"); } catch { /* fixture already exited */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists startup ownership and reaps both supervisor trees when health fails", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-start-failure-");
    const source = join(root, "source");
    const runtime = join(root, "runtime");
    const fakeBin = join(root, "bin");
    const server = join(root, "server.mjs");
    const savedPath = process.env.PATH;
    const savedServer = process.env.SM_ONBOARD_TEST_SERVER;
    const apiPort = 40000 + Math.floor(Math.random() * 100);
    const options = parseOnboardingArgs(["--source-root", source, "--runtime-root", runtime, "--port", String(apiPort), "--scheduler-port", String(apiPort + 1)], {});
    const state: OnboardingState = {
      version: 1, installId: "start-failure", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex",
      appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot, runtimeRoot: options.runtimeRoot,
      workspaceRoot: options.workspaceRoot, dbPath: options.dbPath, statePath: resolveStatePath(options), apiPort, schedulerPort: apiPort + 1,
      roles: [], status: "configured", profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
    };
    try {
      await mkdir(join(runtime, "onboarding-v1"), { recursive: true });
      await mkdir(join(source), { recursive: true });
      await mkdir(join(source, "scripts/lib"), { recursive: true });
      await writeFile(join(source, "scripts/localwatch.sh"), await readFile(join(process.cwd(), "scripts/localwatch.sh")), { mode: 0o700 });
      await writeFile(join(source, "scripts/lib/localwatch-identity.sh"), await readFile(join(process.cwd(), "scripts/lib/localwatch-identity.sh")), { mode: 0o700 });
      await mkdir(join(runtime, "data"), { recursive: true });
      await mkdir(join(fakeBin), { recursive: true });
      await mkdir(join(source, "node_modules/.bin"), { recursive: true });
      await mkdir(join(root, "scheduler-module", "node_modules"), { recursive: true });
      await mkdir(join(root, "scheduler-module", "dist"), { recursive: true });
      await writeFile(join(root, "scheduler-module", "dist/main.js"), "// fixture\n");
      await writeFile(server, "import http from 'node:http'; http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); }).listen(Number(process.env.SM_API_PORT), '127.0.0.1');\n");
      await writeFile(join(fakeBin, "npm"), "#!/bin/sh\nif [ -n \"${SCHEDULER_V2_HOST:-}\" ]; then exit 0; fi\nnode \"$SM_ONBOARD_TEST_SERVER\" & child=$!\nwait \"$child\"\n", { mode: 0o700 });
      await writeFile(join(source, "node_modules/.bin/tsx"), "#!/bin/sh\nexport TEST_PORT=\"$SM_API_PORT\"\nexec node \"$SM_ONBOARD_TEST_SERVER\"\n", { mode: 0o700 });
      await writeFile(join(runtime, "onboarding-v1", ".env.local.generated"), buildEnv(options, state).replace("SM_ONBOARD_NPM='npm'", `SM_ONBOARD_NPM=${JSON.stringify(join(fakeBin, "npm"))}`), { mode: 0o600 });
      await writeFile(join(runtime, "onboarding-v1", "lark-app.secret"), "app\n", { mode: 0o600 });
      await writeFile(join(runtime, "onboarding-v1", "scheduler-admin.secret"), "scheduler\n", { mode: 0o600 });
      const schedulerStart = join(runtime, "onboarding-v1", "scheduler-start.sh");
      const start = join(runtime, "onboarding-v1", "start.sh");
      await writeFile(schedulerStart, renderSchedulerStartScript(join(root, "scheduler-module"), { runtimeRoot: runtime, dbPath: join(runtime, "data", "state.db") }, apiPort + 1), { mode: 0o700 });
      await writeFile(start, renderStartScript(options, state, schedulerStart), { mode: 0o700 });
      await writeFile(join(runtime, "onboarding-v1", "service.json"), "{}\n", { mode: 0o600 });
      process.env.PATH = `${fakeBin}:${savedPath ?? ""}`;
      process.env.SM_ONBOARD_TEST_SERVER = server;
      await expect(startService(options, state, start, 600)).rejects.toThrow(/isolated service startup failed/u);
      const receipt = JSON.parse(await readFile(resolveStatePath(options), "utf8")) as OnboardingState;
      expect(receipt.servicePid).toBeTypeOf("number");
      expect(receipt.schedulerPid).toBeTypeOf("number");
      for (const pid of [receipt.servicePid, receipt.schedulerPid]) {
        const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pid="]).catch(() => ({ stdout: "" }));
        expect(result.stdout.trim()).toBe("");
      }
      await expect(fetch(`http://127.0.0.1:${apiPort}/api/health`)).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${apiPort + 1}/health`)).rejects.toThrow();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedServer === undefined) delete process.env.SM_ONBOARD_TEST_SERVER;
      else process.env.SM_ONBOARD_TEST_SERVER = savedServer;
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("reaps the owned supervisor when the owner receipt cannot be persisted", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-receipt-failure-");
    const source = join(root, "source");
    const runtime = join(root, "runtime");
    const options = parseOnboardingArgs(["--source-root", source, "--runtime-root", runtime, "--port", "40120", "--scheduler-port", "40121"], {});
    const state: OnboardingState = {
      version: 1, installId: "receipt-failure", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex",
      appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot, runtimeRoot: options.runtimeRoot,
      workspaceRoot: options.workspaceRoot, dbPath: options.dbPath, statePath: join(runtime, "onboarding-v1", "state-directory"),
      apiPort: options.apiPort, schedulerPort: options.schedulerPort, roles: [], status: "configured",
      profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
    };
    options.statePath = state.statePath;
    const start = join(runtime, "onboarding-v1", "start.sh");
    try {
      await mkdir(join(runtime, "onboarding-v1"), { recursive: true });
      await mkdir(state.statePath, { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(start, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
      await expect(startService(options, state, start, 500)).rejects.toThrow();
      const pid = Number((await readFile(join(runtime, "onboarding-v1", "service.pid"), "utf8")).trim());
      const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pid="]).catch(() => ({ stdout: "" }));
      expect(result.stdout.trim()).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds health probes by the startup deadline before cleanup", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-health-timeout-");
    const source = join(root, "source");
    const runtime = join(root, "runtime");
    const server = join(root, "server.mjs");
    const accepted = join(root, "accepted.log");
    const childPidFile = join(root, "child.pid");
    const apiPort = await freePort();
    let schedulerPort = await freePort();
    while (schedulerPort === apiPort) schedulerPort = await freePort();
    const options = parseOnboardingArgs(["--source-root", source, "--runtime-root", runtime, "--port", String(apiPort), "--scheduler-port", String(schedulerPort)], {});
    const state: OnboardingState = {
      version: 1, installId: "health-timeout", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex",
      appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot, runtimeRoot: options.runtimeRoot,
      workspaceRoot: options.workspaceRoot, dbPath: options.dbPath, statePath: resolveStatePath(options), apiPort, schedulerPort,
      roles: [], status: "configured", profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
    };
    const start = join(runtime, "onboarding-v1", "start.sh");
    try {
      await mkdir(join(runtime, "onboarding-v1"), { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(server, `import net from 'node:net';\nimport { appendFileSync, writeFileSync } from 'node:fs';\nconst ports = [Number(process.env.SM_API_PORT), Number(process.env.SCHEDULER_V2_PORT)];\nwriteFileSync(process.env.SM_ONBOARD_CHILD_PID_FILE, String(process.pid));\nwriteFileSync(process.env.SM_ONBOARD_ACCEPTED_FILE, '');\nfor (const port of ports) net.createServer(() => appendFileSync(process.env.SM_ONBOARD_ACCEPTED_FILE, String(port) + '\\n')).listen(port, '127.0.0.1');\n`);
      await writeFile(start, `#!/bin/sh\nset -eu\nset -a\n. ${JSON.stringify(join(runtime, "onboarding-v1/.env.local.generated"))}\nset +a\n${fixtureOwnerReceiptBootstrap(options)}SM_ONBOARD_ACCEPTED_FILE=${JSON.stringify(accepted)} SM_ONBOARD_CHILD_PID_FILE=${JSON.stringify(childPidFile)} ${JSON.stringify(process.execPath)} ${JSON.stringify(server)} & child=$!\ntrap 'kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true' INT TERM EXIT\nwait "$child"\n`, { mode: 0o700 });
      await writeFile(join(runtime, "onboarding-v1", ".env.local.generated"), buildEnv(options, state), { mode: 0o600 });
      await writeFile(join(runtime, "onboarding-v1", "service.json"), "{}\n", { mode: 0o600 });
      const startedAt = Date.now();
      await expect(startService(options, state, start, 1_000)).rejects.toThrow(/isolated service startup failed/u);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      const acceptedPorts = new Set((await readFile(accepted, "utf8")).trim().split("\n"));
      expect(acceptedPorts).toEqual(new Set([String(apiPort), String(schedulerPort)]));
      const childPid = Number((await readFile(childPidFile, "utf8")).trim());
      for (const pid of [state.servicePid, childPid]) {
        const result = await execFileAsync("ps", ["-p", String(pid), "-o", "pid="]).catch(() => ({ stdout: "" }));
        expect(result.stdout.trim()).toBe("");
      }
      await expect(assertPortAvailable(apiPort)).resolves.toBeUndefined();
      await expect(assertPortAvailable(schedulerPort)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 5_000);

  test("waits for rollback process termination before removing generated artifacts", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-rollback-process-");
    const runtime = join(root, "runtime");
    const start = join(runtime, "onboarding-v1", "start.sh");
    const fakeCli = join(root, "lark-cli");
    const savedCli = process.env.SM_LARK_CLI_PATH;
    const options = parseOnboardingArgs(["--source-root", root, "--runtime-root", runtime, "--profile", "isolated"], {});
    let childPid: number | undefined;
    try {
      await mkdir(join(runtime, "onboarding-v1"), { recursive: true });
      await mkdir(join(runtime, "data"), { recursive: true });
      await mkdir(options.workspaceRoot, { recursive: true });
      await mkdir(join(root, "scripts"), { recursive: true });
      await writeFile(join(root, "scripts/localwatch.sh"), "#!/bin/sh\n", { mode: 0o700 });
      await writeFile(fakeCli, "#!/bin/sh\ncase \"$*\" in *\"whoami --as user\"*) echo '{\"ok\":true,\"data\":{\"appId\":\"cli_app\",\"openId\":\"ou_owner\"}}';; *\"whoami --as bot\"*) echo '{\"ok\":true,\"data\":{\"appId\":\"cli_app\"}}';; *) exit 1;; esac\n", { mode: 0o700 });
      await writeFile(start, "#!/bin/sh\ntrap 'sleep 0.3; exit 0' TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o700 });
      await writeFile(join(runtime, "onboarding-v1", "generated.marker"), "owned\n");
      const child = spawn(start, [], { cwd: root, detached: true, stdio: "ignore" });
      child.unref();
      if (!child.pid) throw new Error("rollback fixture did not return a pid");
      childPid = child.pid;
      await writeOwnerReceipt(options, child.pid);
      const state: OnboardingState = {
        version: 1, installId: "rollback-process", createdAt: "2026-09-11T00:00:00.000Z", profile: "isolated", backend: "codex",
        appId: "cli_app", ownerOpenId: "ou_owner", sourceRoot: options.sourceRoot, runtimeRoot: options.runtimeRoot,
        workspaceRoot: options.workspaceRoot, dbPath: options.dbPath, statePath: resolveStatePath(options), apiPort: options.apiPort,
        schedulerPort: options.schedulerPort, childEnv: {
          home: join(runtime, "home"), xdgConfigHome: join(runtime, "xdg-config"), codexHome: join(runtime, "codex-home"),
          path: process.env.PATH ?? "/usr/bin:/bin", nodePath: process.execPath, npmPath: "/usr/bin/npm", pythonPath: "/usr/bin/python3",
          larkCliPath: fakeCli, backendPath: "/usr/bin/codex",
        }, roles: [], status: "configured", servicePid: child.pid,
        profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
      };
      await writeFile(resolveStatePath(options), JSON.stringify(state));
      process.env.SM_LARK_CLI_PATH = fakeCli;
      const ownerReceipt = await readFile(localwatchOwnerReceiptPath(options), "utf8");
      await rm(localwatchOwnerReceiptPath(options), { force: true });
      await expect(rollback(options, state)).rejects.toThrow(/owner receipt is missing/u);
      await writeFile(localwatchOwnerReceiptPath(options), ownerReceipt, { mode: 0o600 });
      await rollback(options, state);
      const ps = await execFileAsync("ps", ["-p", String(childPid), "-o", "pid="]).catch(() => ({ stdout: "" }));
      expect(ps.stdout.trim()).toBe("");
      await expect(readFile(join(runtime, "onboarding-v1", "generated.marker"), "utf8")).rejects.toThrow();
      expect((JSON.parse(await readFile(resolveStatePath(options), "utf8")) as OnboardingState).status).toBe("rolled_back");
    } finally {
      if (childPid) {
        try { process.kill(-childPid, "SIGKILL"); } catch { /* fixture already exited */ }
      }
      if (savedCli === undefined) delete process.env.SM_LARK_CLI_PATH;
      else process.env.SM_LARK_CLI_PATH = savedCli;
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("runs the apply workflow through real SQLite/workspace provisioning with an isolated gateway", async () => {
    const root = await realpath(await mkdtemp("/tmp/sm-onboard-workflow-"));
    const source = join(root, "release");
    const runtime = join(root, "runtime");
    const fakeCli = join(root, "lark-cli");
    const fakeBackend = join(root, "codex");
    const fakeNpm = join(root, "npm");
    const fixtureServer = join(root, "server.mjs");
    const envKeys = ["SM_LARK_CLI_PATH", "SM_CODEX_CLI_PATH", "SM_ONBOARD_APP_SECRET", "SM_ONBOARD_TEST_SERVER", "SM_ONBOARD_NPM"] as const;
    const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    const savedPath = process.env.PATH;
    let servicePid: number | undefined;
    let apiPort: number | undefined;
    let schedulerPort: number | undefined;
    try {
      await mkdir(join(source, "templates"), { recursive: true });
      await mkdir(join(source, "scripts"), { recursive: true });
      await mkdir(join(source, "scripts/lib"), { recursive: true });
      await mkdir(join(source, "config/onboarding-v1"), { recursive: true });
      await writeFile(join(source, "scripts/localwatch.sh"), await readFile(join(process.cwd(), "scripts/localwatch.sh")), { mode: 0o700 });
      await writeFile(join(source, "scripts/lib/localwatch-identity.sh"), await readFile(join(process.cwd(), "scripts/lib/localwatch-identity.sh")), { mode: 0o700 });
      await mkdir(join(source, "node_modules/.bin"), { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { start: "node server.mjs" } }));
      for (const file of ["claude-md-base.md", "agents-md-base.md", "gitignore.default"]) {
        await writeFile(join(source, "templates", file), "fixture\n");
      }
      const skillRoot = join(source, "platform/skill-master/skills");
      const fixtureRoot = join(process.cwd(), "tests/fixtures/onboarding-v1/public-assets");
      for (const name of ["diagnose", "improve-codebase-architecture", "tdd"]) {
        await mkdir(join(skillRoot, name), { recursive: true });
        await writeFile(join(skillRoot, name, "SKILL.md"), await readFile(join(fixtureRoot, "platform/skill-master/skills", name, "SKILL.md")));
      }
      const templateRoot = join(source, "platform/first-principle/templates");
      await mkdir(templateRoot, { recursive: true });
      for (const name of ["console-principles.md", "coding-principles.md", "sop-template.md"]) {
        await writeFile(join(templateRoot, name), await readFile(join(fixtureRoot, "platform/first-principle/templates", name)));
      }
      await writeFile(join(templateRoot, "business-principles.md"), await readFile(join(fixtureRoot, "platform/first-principle/templates/business-principles.md")));

      const manifest = JSON.parse(await readFile(join(process.cwd(), "config/onboarding-v1/platform-manifest.json"), "utf8")) as { publicRoles: Array<{ name: string; modulePath?: string; run?: string; requiredFiles?: string[]; packagePaths?: string[] }>; supportModules?: Array<{ name: string; modulePath?: string; run?: string; requiredFiles?: string[]; packagePaths?: string[] }> };
      for (const role of [...manifest.publicRoles, ...(manifest.supportModules ?? [])]) {
        if (!role.modulePath) continue;
        const module = join(source, role.modulePath);
        await mkdir(module, { recursive: true });
        const roleRecord = role as typeof role & { requiredFiles?: string[]; packagePaths?: string[] };
        const tokens = role.run?.split(/\s+/u) ?? [];
        const prefixIndex = tokens.indexOf("--prefix");
        const packageRoots = new Set([
          "",
          ...(roleRecord.packagePaths ?? []),
          ...(prefixIndex >= 0 && tokens[prefixIndex + 1] ? [tokens[prefixIndex + 1]] : []),
        ]);
        for (const packagePath of packageRoots) {
          const packageRoot = join(module, packagePath);
          await mkdir(packageRoot, { recursive: true });
          const scriptIndex = prefixIndex >= 0 ? prefixIndex + 2 : 1;
          const scriptName = tokens[scriptIndex] === "run" ? tokens[scriptIndex + 1] : tokens[scriptIndex];
          if (packagePath || tokens[0] === "npm") {
            await writeFile(join(packageRoot, "package.json"), JSON.stringify({ scripts: { [scriptName ?? "start"]: "node -e ''" } }));
            if ((roleRecord.requiredFiles ?? []).includes(`${packagePath ? `${packagePath}/` : ""}package-lock.json`)) {
              await writeFile(join(packageRoot, "package-lock.json"), "{}\n");
            }
            await mkdir(join(packageRoot, "node_modules"), { recursive: true });
          }
        }
        for (const file of roleRecord.requiredFiles ?? []) {
          const destination = join(module, file);
          if (file.endsWith("package.json") || file.endsWith("package-lock.json")) continue;
          if (await access(destination, fsConstants.F_OK).then(() => true).catch(() => false)) continue;
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, file.endsWith(".json") ? "{}\n" : file.endsWith(".sh") ? "#!/bin/sh\nexit 0\n" : file.endsWith(".py") ? "print('fixture')\n" : "fixture\n", { mode: file.endsWith(".sh") ? 0o700 : 0o600 });
        }
        const commandTokens = tokens.filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token));
        if (commandTokens[0]?.includes("python")) {
          await writeFile(join(module, "pyproject.toml"), "[project]\nname='fixture'\nrequires-python='>=3.11,<3.12'\n");
          await writeFile(join(module, ".python-version"), "3.11.15\n");
        }
      }
      await writeFile(fakeCli, `#!/bin/sh
set -eu
case "$*" in
  *"profile list"*) printf '%s\\n' onboarding-test ;;
  *"auth status"*) printf '%s\\n' '{"ok":true,"verified":true,"data":{"profile":"onboarding-test","identity":"user","tokenStatus":"valid"}}' ;;
  *"whoami --as bot"*) printf '%s\\n' '{"ok":true,"data":{"appId":"cli_app"}}' ;;
  *"whoami --as user"*) printf '%s\\n' '{"ok":true,"data":{"appId":"cli_app","openId":"ou_owner"}}' ;;
  *"auth scopes"*) printf '%s\\n' '{"ok":true,"data":{"userScopes":["base:app:create","base:field:create","base:field:read","base:field:update","base:record:create","base:record:read","base:record:update","base:table:create","base:table:delete","base:table:read","base:table:update","base:view:write_only","im:chat:create_by_user","im:chat:read","im:chat:update","im:chat.members:read","im:chat.members:write_only","im:message","im:message:readonly","im:message.send_as_user","contact:user.basic_profile:readonly","contact:user:search"]}}' ;;
  *"application/v6/scopes"*) printf '%s\\n' '{"ok":true,"data":{"scopes":[{"name":"base:app:create","grant_status":1},{"name":"base:field:create","grant_status":1},{"name":"base:field:read","grant_status":1},{"name":"base:field:update","grant_status":1},{"name":"base:record:create","grant_status":1},{"name":"base:record:read","grant_status":1},{"name":"base:record:update","grant_status":1},{"name":"base:table:create","grant_status":1},{"name":"base:table:delete","grant_status":1},{"name":"base:table:read","grant_status":1},{"name":"base:table:update","grant_status":1},{"name":"base:view:write_only","grant_status":1},{"name":"contact:user.basic_profile:readonly","grant_status":1},{"name":"contact:user:search","grant_status":1},{"name":"docs:document.comment:read","grant_status":1},{"name":"docs:document.comment:create","grant_status":1},{"name":"docs:document.comment:write_only","grant_status":1},{"name":"docs:document.media:download","grant_status":1},{"name":"docs:permission.member:create","grant_status":1},{"name":"drive:file:download","grant_status":1},{"name":"drive:file:upload","grant_status":1},{"name":"im:chat:read","grant_status":1},{"name":"im:chat.members:read","grant_status":1},{"name":"im:chat.members:write_only","grant_status":1},{"name":"im:chat:create","grant_status":1},{"name":"im:chat:update","grant_status":1},{"name":"im:message","grant_status":1},{"name":"im:message.p2p_msg:readonly","grant_status":1},{"name":"im:message:readonly","grant_status":1},{"name":"im:message:send_as_bot","grant_status":1},{"name":"im:message:update","grant_status":1},{"name":"im:resource","grant_status":1}]}}' ;;
  *"im +chat-search"*) printf '%s\\n' '{"ok":true,"data":{"items":[]}}' ;;
  *) printf '%s\\n' '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o700 });
      await writeFile(fakeBackend, "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then echo fixture-backend; else echo '{\"type\":\"completed\",\"text\":\"SM_ONBOARDING_PROBE_OK\"}'; fi\n", { mode: 0o700 });
      process.env.SM_LARK_CLI_PATH = fakeCli;
      process.env.SM_CODEX_CLI_PATH = fakeBackend;
      process.env.SM_ONBOARD_APP_SECRET = "isolated-test-secret";
      process.env.SM_ONBOARD_NPM = fakeNpm;
      await writeFile(fixtureServer, "import http from 'node:http'; const scheduler = Boolean(process.env.SCHEDULER_V2_HOST); const port = scheduler ? Number(process.env.SCHEDULER_V2_PORT) : Number(process.env.SM_API_PORT); http.createServer((_q, r) => { r.writeHead(200, {'content-type':'application/json'}); r.end(JSON.stringify(scheduler ? {ok:true,service:'scheduler-v2'} : {status:'ok'})); }).listen(port, '127.0.0.1');\n");
      await writeFile(fakeNpm, "#!/bin/sh\nset -eu\nif [ \"${1:-}\" = start ]; then exec node \"$SM_ONBOARD_TEST_SERVER\"; fi\nexit 0\n", { mode: 0o700 });
      await writeFile(join(source, "node_modules/.bin/tsx"), "#!/bin/sh\nexport TEST_PORT=\"$SM_API_PORT\"\nexec node \"$SM_ONBOARD_TEST_SERVER\"\n", { mode: 0o700 });
      process.env.SM_ONBOARD_TEST_SERVER = fixtureServer;
      process.env.PATH = `${root}:${savedPath ?? ""}`;
      apiPort = await freePort();
      schedulerPort = await freePort();
      while (schedulerPort === apiPort) schedulerPort = await freePort();
      const options = parseOnboardingArgs(["--apply", "--source-root", source, "--runtime-root", runtime, "--profile", "onboarding-test", "--app-id", "cli_app", "--owner-open-id", "ou_owner", "--port", String(apiPort), "--scheduler-port", String(schedulerPort)], {});
      const gateway = createFakeLarkGateway();
      const deps = {
        gateway,
        assetProvenancePath: join(process.cwd(), "tests/fixtures/onboarding-v1/asset-provenance.json"),
      };
      const firstCode = await runOnboarding(options, deps);
      expect(firstCode).toBe(0);
      const first = JSON.parse(await readFile(join(runtime, "onboarding-v1/state.json"), "utf8")) as OnboardingState & { roles: Array<{ phase: string }> };
      servicePid = first.servicePid;
      expect(first.status).toBe("ready");
      const service = JSON.parse(await readFile(join(runtime, "onboarding-v1/service.json"), "utf8")) as { nativeOS: { registration: string; command: string; launchAgent: { programArguments: string[]; runAtLoad: boolean; keepAlive: boolean } }; ownerReceipt: { path: string; format: string; requiredFields: string[] } };
      expect(service.nativeOS.registration).toBe("external");
      expect(service.nativeOS.command).toBe(join(runtime, "onboarding-v1/start.sh"));
      expect(service.nativeOS.launchAgent).toMatchObject({ programArguments: ["/bin/sh", join(runtime, "onboarding-v1/start.sh")], runAtLoad: true, keepAlive: true });
      expect(service.ownerReceipt).toMatchObject({ path: localwatchOwnerReceiptPath(options), format: "localwatch-owner-v1" });
      expect(service.ownerReceipt.requiredFields).toEqual(expect.arrayContaining(["pid", "processStart", "bootId", "repoDir", "scriptPath", "cwd", "installationNamespace", "launcherPath", "healthEndpoints", "status"]));
      expect(first.childEnv?.home).toBe(join(runtime, "home"));
      expect(first.childEnv?.codexHome).toBe(join(runtime, "codex-home"));
      expect(first.childEnv?.nodePath).toBe(process.execPath);
      expect(first.childEnv?.larkCliPath).toBe(fakeCli);
      expect(first.childEnv?.backendPath).toBe(fakeBackend);
      expect(await readFile(join(runtime, "onboarding-v1/.env.local.generated"), "utf8")).toContain(`PATH=${JSON.stringify(first.childEnv?.path)}`.replaceAll('"', "'"));
      expect(first.roles).toHaveLength(12);
      expect(first.roles.every((role) => role.phase === "session_ready")).toBe(true);
      expect(await access(join(runtime, "onboarding-v1/modules/wendangwang/tests/fixtures/public-demo.asset.json"))).toBeUndefined();
      expect(await access(join(runtime, "onboarding-v1/modules/mythos/public/README.md"))).toBeUndefined();
      await expect(access(join(runtime, "onboarding-v1/modules/mythos/kb/CHARTER.md"))).rejects.toThrow();
      expect(await access(join(runtime, "onboarding-v1/modules/larkc/public-input/lark-install-permissions.v1.json"))).toBeUndefined();
      expect(await access(join(runtime, "onboarding-v1/modules/larkc/card-callback/src/askBroker.js"))).toBeUndefined();
      const generatedEnv = await readFile(join(runtime, "onboarding-v1/.env.local.generated"), "utf8");
      const materializedMcpPath = join(runtime, "onboarding-v1/modules/larkc/card-callback/src/mcpAskServer.js");
      expect(generatedEnv).toContain(`SM_CARD_ASK_MCP_SERVER_PATH=${JSON.stringify(materializedMcpPath)}`.replaceAll('"', "'"));
      expect(await access(materializedMcpPath)).toBeUndefined();
      expect(generatedEnv).toContain("LOCALWATCH_MANAGED_COMPONENTS='core,scheduler-v2'");
      expect(generatedEnv).not.toContain("CARD_ASK_BROKER");
      await expect(access(join(runtime, "onboarding-v1/modules/socail-king/public-safe/README.md"))).rejects.toThrow();
      expect(await isOwnedHealthyInstance(options, first as OnboardingState)).toBe(true);
      expect(gateway.createdGroups).toHaveLength(12);
      const resumeCode = await runOnboarding(options, deps);
      const resumed = JSON.parse(await readFile(join(runtime, "onboarding-v1/state.json"), "utf8")) as { status: string; roles: Array<{ phase: string }>; servicePid: number };
      expect(resumeCode).toBe(0);
      expect(resumed.status).toBe("ready");
      expect(resumed.servicePid).toBe(first.servicePid);
      expect(gateway.createdGroups).toHaveLength(12);
      expect(await isOwnedHealthyInstance(options, resumed as OnboardingState)).toBe(true);
      const generatedEnvPath = join(runtime, "onboarding-v1/.env.local.generated");
      const generatedEnvAfterResume = await readFile(generatedEnvPath, "utf8");
      expect(generatedEnvAfterResume).not.toContain("LARK_APP_SECRET=");
      await writeFile(generatedEnvPath, generatedEnvAfterResume.replace(`SM_CODEX_CLI_PATH=${JSON.stringify(fakeBackend).replaceAll('"', "'")}`, "SM_CODEX_CLI_PATH='/usr/bin/codex'"), { mode: 0o600 });
      await expect(runOnboarding({ ...options, apply: false, verify: true }, deps)).resolves.toBe(2);
      await writeFile(generatedEnvPath, generatedEnvAfterResume, { mode: 0o600 });
    } finally {
      if (servicePid) {
        const pgid = await processGroupId(servicePid);
        if (pgid) {
          try { process.kill(-pgid, "SIGTERM"); } catch { /* fixture already exited */ }
          if (!await waitForProcessGroupGone(pgid)) {
            try { process.kill(-pgid, "SIGKILL"); } catch { /* fixture already exited */ }
            expect(await waitForProcessGroupGone(pgid)).toBe(true);
          }
        }
        if (apiPort !== undefined) await expect(assertPortAvailable(apiPort)).resolves.toBeUndefined();
        if (schedulerPort !== undefined) await expect(assertPortAvailable(schedulerPort)).resolves.toBeUndefined();
      }
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("binds rollback ownership to profile, backend, port, and every path", () => {
    const options = parseOnboardingArgs([
      "--profile", "isolated", "--backend", "codex", "--runtime-root", "/tmp/sm-runtime", "--port", "3511",
    ], {});
    const state = {
      version: 1 as const,
      installId: "install-1",
      createdAt: "2026-09-11T00:00:00.000Z",
      profile: "isolated",
      backend: "codex" as const,
      appId: "cli_app",
      ownerOpenId: "ou_owner",
      sourceRoot: options.sourceRoot,
      runtimeRoot: options.runtimeRoot,
      workspaceRoot: options.workspaceRoot,
      dbPath: options.dbPath,
      statePath: resolveStatePath(options),
      apiPort: options.apiPort, schedulerPort: options.schedulerPort,
      instanceSecretSha256: "hash",
      schedulerSecretSha256: "hash",
      profileIdentity: { appId: "cli_app", ownerOpenId: "ou_owner" },
      roles: [],
      status: "configured" as const,
    };
    expect(() => validateStateOwnership(options, state)).not.toThrow();
    expect(() => validateStateOwnership({ ...options, profile: "production" }, state)).toThrow(/ownership mismatch/u);
    expect(() => validateStateOwnership({ ...options, apiPort: 3512 }, state)).toThrow(/backend or port/u);
  });

  test("keeps corrupt state distinguishable from first install", async () => {
    const root = await mkdtemp("/tmp/sm-onboard-state-");
    try {
      const state = join(root, "onboarding-v1", "state.json");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "onboarding-v1"), { recursive: true }));
      await writeFile(state, "{not-json\n", { mode: 0o600 });
      const options = parseOnboardingArgs(["--verify", "--runtime-root", root], {});
      await expect(runOnboarding(options)).rejects.toThrow(/corrupt onboarding state/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
