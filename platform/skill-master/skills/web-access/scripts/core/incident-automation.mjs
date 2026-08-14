import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateAlertThreshold } from "./alert-evaluator.mjs";
import { sendFeishuMessage } from "./feishu-alert.mjs";
import { listRecentRunEvents, upsertRepairRecord } from "./incident-store.mjs";

function buildIncidentKey(event, decision) {
  return [
    String(event?.packName || "").trim(),
    String(event?.profile || "").trim(),
    String(decision?.trigger || "").trim(),
    String(event?.runId || "").trim()
  ].join(":");
}

function buildFailureAlertMarkdown({ event, decision, latestRun, repairStarted }) {
  return [
    "[web-access] terminal failure threshold reached",
    `pack: ${event.packName}`,
    `profile: ${event.profile}`,
    `trigger: ${decision.trigger}`,
    `terminal failures: ${decision.terminalFailureCount}`,
    `blocked/captcha failures: ${decision.blockedOrCaptchaCount}`,
    `target: ${event.target}`,
    `failure kind: ${event.failureKind || "unknown"}`,
    `latest screenshot: ${latestRun?.screenshotPath || event?.screenshotPath || "n/a"}`,
    `repair started: ${repairStarted ? "yes" : "no"}`
  ].join("\n");
}

const REPAIR_WORKER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "repair-worker.mjs"
);

export async function startRepairWorker({
  repoRoot,
  dbPath,
  incidentKey,
  incident,
  spawnImpl = spawnProcess
} = {}) {
  const args = [
    REPAIR_WORKER_PATH,
    "--repo-root",
    String(repoRoot || process.cwd()),
    "--db-path",
    String(dbPath || ""),
    "--incident-key",
    String(incidentKey || incident?.incidentKey || ""),
    "--pack-name",
    String(incident?.packName || ""),
    "--profile",
    String(incident?.profile || ""),
    "--target",
    String(incident?.target || ""),
    "--run-id",
    String(incident?.runId || ""),
    "--trigger",
    String(incident?.trigger || ""),
    "--failure-kind",
    String(incident?.failureKind || ""),
    "--created-at",
    String(incident?.createdAt || new Date().toISOString())
  ];

  const child = spawnImpl(process.execPath, args, {
    detached: true,
    stdio: "ignore"
  });
  if (typeof child?.unref === "function") {
    child.unref();
  }

  return {
    started: true,
    incidentKey: String(incidentKey || incident?.incidentKey || "")
  };
}

export async function handleTerminalRunFailure({
  repoRoot = process.cwd(),
  config = {},
  event,
  now = () => new Date(),
  listRecentRunEventsImpl = listRecentRunEvents,
  evaluateAlertThresholdImpl = evaluateAlertThreshold,
  sendFeishuMessageImpl = sendFeishuMessage,
  startRepairWorkerImpl = startRepairWorker,
  upsertRepairRecordImpl = upsertRepairRecord
} = {}) {
  if (!event || event.eventType !== "run_failed") {
    return {
      decision: {
        shouldAlert: false,
        trigger: null,
        terminalFailureCount: 0,
        blockedOrCaptchaCount: 0,
        crossedThreshold: false
      },
      alertSent: false,
      repairStarted: false
    };
  }

  const recentRuns = await listRecentRunEventsImpl({
    dbPath: config?.incidentDbPath,
    packName: event.packName,
    profile: event.profile,
    limit: 10
  });
  const decision = evaluateAlertThresholdImpl(recentRuns);

  if (decision.shouldAlert !== true || decision.crossedThreshold !== true) {
    return {
      decision,
      alertSent: false,
      repairStarted: false
    };
  }

  const incidentKey = buildIncidentKey(event, decision);
  const createdAt = String(event.createdAt || now().toISOString());
  const incident = {
    incidentKey,
    id: incidentKey,
    packName: event.packName,
    profile: event.profile,
    target: event.target,
    runId: event.runId,
    trigger: decision.trigger,
    failureKind: event.failureKind || "",
    createdAt,
    screenshotPath: event.screenshotPath || ""
  };

  let repairStarted = false;
  if (config?.repairAgentEnabled !== false) {
    try {
      await upsertRepairRecordImpl({
        dbPath: config?.incidentDbPath,
        record: {
          incidentKey,
          packName: incident.packName,
          profile: incident.profile,
          target: incident.target,
          runId: incident.runId,
          trigger: incident.trigger,
          status: "queued",
          summary: {
            decision
          },
          createdAt,
          updatedAt: createdAt
        }
      });

      const startResult = await startRepairWorkerImpl({
        repoRoot,
        dbPath: config?.incidentDbPath,
        incidentKey,
        incident
      });
      repairStarted = Boolean(startResult?.started);

      await upsertRepairRecordImpl({
        dbPath: config?.incidentDbPath,
        record: {
          incidentKey,
          packName: incident.packName,
          profile: incident.profile,
          target: incident.target,
          runId: incident.runId,
          trigger: incident.trigger,
          status: repairStarted ? "running" : "failed",
          summary: {
            decision,
            startResult
          },
          createdAt,
          updatedAt: now().toISOString()
        }
      });
    } catch (error) {
      repairStarted = false;
      try {
        await upsertRepairRecordImpl({
          dbPath: config?.incidentDbPath,
          record: {
            incidentKey,
            packName: incident.packName,
            profile: incident.profile,
            target: incident.target,
            runId: incident.runId,
            trigger: incident.trigger,
            status: "failed",
            summary: {
              decision,
              error: String(error?.message || error)
            },
            createdAt,
            updatedAt: now().toISOString()
          }
        });
      } catch {
      }
    }
  }

  let alertSent = false;
  if (config?.alertEnabled !== false && config?.alertChatId) {
    try {
      await sendFeishuMessageImpl({
        chatId: config.alertChatId,
        markdown: buildFailureAlertMarkdown({
          event,
          decision,
          latestRun: Array.isArray(recentRuns) ? recentRuns[0] : null,
          repairStarted
        })
      });
      alertSent = true;
    } catch {
      alertSent = false;
    }
  }

  return {
    decision,
    alertSent,
    repairStarted,
    incidentKey
  };
}
