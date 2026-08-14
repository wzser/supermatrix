import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { buildSelfHealConfig } from "./self-heal-config.mjs";
import { sendFeishuMessage } from "./feishu-alert.mjs";
import { upsertRepairRecord } from "./incident-store.mjs";
import { runPackValidation, runRepairOrchestrator } from "./repair-orchestrator.mjs";

const execFileAsync = promisify(execFileCallback);

function requireIncident(incident = {}) {
  const normalized = {
    incidentKey: String(incident.incidentKey || incident.id || "").trim(),
    id: String(incident.id || incident.incidentKey || "").trim(),
    packName: String(incident.packName || "").trim(),
    profile: String(incident.profile || "").trim(),
    target: String(incident.target || "").trim(),
    runId: String(incident.runId || "").trim(),
    trigger: String(incident.trigger || "").trim(),
    failureKind: String(incident.failureKind || "").trim(),
    createdAt: String(incident.createdAt || new Date().toISOString()).trim()
  };

  if (!normalized.incidentKey || !normalized.packName || !normalized.profile) {
    throw new Error("incidentKey, packName, and profile are required");
  }

  if (!normalized.id) {
    normalized.id = normalized.incidentKey;
  }

  return normalized;
}

function buildRepairFailureMarkdown({ incident, result, error }) {
  const summary = error
    ? String(error?.message || error)
    : JSON.stringify(result?.failureSummary || result || {});
  return [
    "[web-access] repair failed",
    `incident: ${incident.incidentKey}`,
    `pack: ${incident.packName}`,
    `profile: ${incident.profile}`,
    `target: ${incident.target}`,
    `trigger: ${incident.trigger || "unknown"}`,
    `failure kind: ${incident.failureKind || "unknown"}`,
    `summary: ${summary}`
  ].join("\n");
}

export async function spawnRepairAgentViaSessionApi({
  incident,
  attempt,
  worktree,
  fetchImpl = fetch,
  apiBaseUrl = process.env.WEB_ACCESS_SESSION_API_BASE_URL || "http://127.0.0.1:3501",
  repairTarget = process.env.WEB_ACCESS_REPAIR_TARGET || ""
} = {}) {
  if (!repairTarget) {
    throw new Error("WEB_ACCESS_REPAIR_TARGET is required for repair automation");
  }

  const prompt = [
    `Investigate and fix a web-access scraping incident in worktree ${worktree.worktreePath}.`,
    `Incident key: ${incident.incidentKey || incident.id}`,
    `Pack: ${incident.packName}`,
    `Profile: ${incident.profile}`,
    `Target: ${incident.target}`,
    `Trigger: ${incident.trigger || "unknown"}`,
    `Failure kind: ${incident.failureKind || "unknown"}`,
    `Attempt: ${attempt}`,
    "Only modify files under the allowed pack/test scope for this incident.",
    "Make the patch directly in the provided worktree path, add or update tests, and finish with a short root-cause hypothesis plus patch summary."
  ].join("\n");

  const response = await fetchImpl(`${apiBaseUrl}/api/spawn`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      target: repairTarget,
      prompt
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Repair spawn failed with ${response.status}: ${body}`);
  }

  let parsed = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    parsed = {};
  }

  const summary = String(parsed?.finalMessage || "").trim();
  return {
    attemptId: String(parsed?.childSessionId || `repair-attempt-${attempt}`),
    hypothesis: summary || `automated repair attempt ${attempt}`,
    patchSummary: summary || `automated repair attempt ${attempt}`
  };
}

export async function runValidationInWorktree({
  incident,
  worktree,
  execFileImpl = execFileAsync
} = {}) {
  const commands = runPackValidation({ packName: incident?.packName });
  if (commands.length === 0) {
    return {
      ok: false,
      tests: [],
      smoke: [],
      summary: `No validation commands configured for pack ${incident?.packName || ""}`
    };
  }

  const tests = [];
  const smoke = [];
  const smokeIndex = commands.length > 1 ? commands.length - 1 : -1;

  for (let index = 0; index < commands.length; index += 1) {
    const [file, args = []] = commands[index];
    const label = [file, ...args].join(" ");

    try {
      await execFileImpl(file, args, {
        cwd: worktree?.worktreePath,
        maxBuffer: 20 * 1024 * 1024
      });
    } catch (error) {
      const output = [error?.stdout, error?.stderr, error?.message]
        .filter(Boolean)
        .join("\n")
        .trim();
      return {
        ok: false,
        tests,
        smoke,
        summary: output || `Validation command failed: ${label}`
      };
    }

    if (index === smokeIndex) {
      smoke.push(label);
    } else {
      tests.push(label);
    }
  }

  return {
    ok: true,
    tests,
    smoke,
    summary: "Validation passed"
  };
}

export async function mergeRepairBranch({
  branchName,
  repoRoot,
  execFileImpl = execFileAsync
} = {}) {
  await execFileImpl("git", [
    "-C",
    String(repoRoot || process.cwd()),
    "merge",
    "--no-ff",
    "--no-edit",
    String(branchName || "")
  ]);
}

export async function runRepairWorker({
  repoRoot = process.cwd(),
  config = buildSelfHealConfig({ cwd: repoRoot }),
  incident,
  now = () => new Date(),
  runRepairOrchestratorImpl = runRepairOrchestrator,
  upsertRepairRecordImpl = upsertRepairRecord,
  sendFeishuMessageImpl = sendFeishuMessage,
  spawnRepairAgentImpl = spawnRepairAgentViaSessionApi,
  runValidationImpl = runValidationInWorktree,
  mergeRepairBranchImpl = async (payload) =>
    mergeRepairBranch({ ...payload, repoRoot })
} = {}) {
  const normalizedIncident = requireIncident(incident);
  const startedAt = now().toISOString();

  await upsertRepairRecordImpl({
    dbPath: config?.incidentDbPath,
    record: {
      incidentKey: normalizedIncident.incidentKey,
      packName: normalizedIncident.packName,
      profile: normalizedIncident.profile,
      target: normalizedIncident.target,
      runId: normalizedIncident.runId,
      trigger: normalizedIncident.trigger,
      status: "running",
      summary: {
        failureKind: normalizedIncident.failureKind
      },
      createdAt: normalizedIncident.createdAt,
      updatedAt: startedAt
    }
  });

  try {
    const result = await runRepairOrchestratorImpl({
      incident: normalizedIncident,
      repoRoot,
      autoMerge: config?.autoMergeEnabled !== false,
      spawnRepairAgentImpl,
      runValidationImpl,
      mergeRepairBranchImpl
    });

    if (result?.status === "merged") {
      await upsertRepairRecordImpl({
        dbPath: config?.incidentDbPath,
        record: {
          incidentKey: normalizedIncident.incidentKey,
          packName: normalizedIncident.packName,
          profile: normalizedIncident.profile,
          target: normalizedIncident.target,
          runId: normalizedIncident.runId,
          trigger: normalizedIncident.trigger,
          status: "merged",
          branchName: result.branchName || "",
          summary: {
            attempt: result.attempt,
            validation: result.validation || {}
          },
          createdAt: normalizedIncident.createdAt,
          updatedAt: now().toISOString()
        }
      });
      return result;
    }

    await upsertRepairRecordImpl({
      dbPath: config?.incidentDbPath,
      record: {
        incidentKey: normalizedIncident.incidentKey,
        packName: normalizedIncident.packName,
        profile: normalizedIncident.profile,
        target: normalizedIncident.target,
        runId: normalizedIncident.runId,
        trigger: normalizedIncident.trigger,
        status: "failed",
        branchName: result?.branchName || "",
        summary: result?.failureSummary || result || {},
        createdAt: normalizedIncident.createdAt,
        updatedAt: now().toISOString()
      }
    });

    if (config?.alertEnabled !== false && config?.alertChatId) {
      await sendFeishuMessageImpl({
        chatId: config.alertChatId,
        markdown: buildRepairFailureMarkdown({
          incident: normalizedIncident,
          result
        })
      });
    }

    return result;
  } catch (error) {
    await upsertRepairRecordImpl({
      dbPath: config?.incidentDbPath,
      record: {
        incidentKey: normalizedIncident.incidentKey,
        packName: normalizedIncident.packName,
        profile: normalizedIncident.profile,
        target: normalizedIncident.target,
        runId: normalizedIncident.runId,
        trigger: normalizedIncident.trigger,
        status: "failed",
        summary: {
          error: String(error?.message || error)
        },
        createdAt: normalizedIncident.createdAt,
        updatedAt: now().toISOString()
      }
    });

    if (config?.alertEnabled !== false && config?.alertChatId) {
      await sendFeishuMessageImpl({
        chatId: config.alertChatId,
        markdown: buildRepairFailureMarkdown({
          incident: normalizedIncident,
          error
        })
      });
    }

    throw error;
  }
}
