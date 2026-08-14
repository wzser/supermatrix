import path from "node:path";

export const DEFAULT_INCIDENT_DB_PATH = "/Users/LOCAL_USER/CodexSkills/web-access/data/incidents.db";

export function defaultIncidentDbPath(cwd = process.cwd()) {
  return DEFAULT_INCIDENT_DB_PATH;
}

export function resolveIncidentDbPath({ cwd = process.cwd(), env = process.env } = {}) {
  return env.WEB_ACCESS_INCIDENT_DB_PATH || defaultIncidentDbPath(cwd);
}

function resolveAlertChatId(env = process.env) {
  return env.WEB_ACCESS_ALERT_CHAT_ID || env.SCHEDULER_NOTIFY_GROUP_ID || undefined;
}

export function buildSelfHealConfig(options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    ...overrides
  } = options;

  const defaults = {
    runtimeEnabled: true,
    evidenceEnabled: true,
    alertEnabled: true,
    repairAgentEnabled: true,
    autoMergeEnabled: true,
    maxRecoveryRounds: 10,
    incidentDbPath: resolveIncidentDbPath({ cwd, env }),
    evidenceRoot: path.join(cwd, "artifacts", "web-access"),
    alertChatId: resolveAlertChatId(env)
  };

  return {
    ...defaults,
    ...overrides
  };
}
