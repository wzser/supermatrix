const BLOCKED_OR_CAPTCHA_FAILURE_KINDS = new Set(["blocked", "captcha"]);

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isTerminalFailure(run = {}) {
  if (run.terminal === false || run.nonTerminal === true || run.recovered === true) {
    return false;
  }

  const eventType = normalizeText(run.eventType);
  const status = normalizeText(run.status);

  if (eventType === "run_failed" || status === "failed") {
    return true;
  }

  if (status === "blocked" || status === "captcha") {
    return true;
  }

  return false;
}

function isBlockedOrCaptchaFailure(run = {}) {
  return (
    BLOCKED_OR_CAPTCHA_FAILURE_KINDS.has(normalizeText(run.failureKind)) ||
    BLOCKED_OR_CAPTCHA_FAILURE_KINDS.has(normalizeText(run.status))
  );
}

export function evaluateAlertThreshold(runs = []) {
  const result = {
    shouldAlert: false,
    trigger: null,
    terminalFailureCount: 0,
    blockedOrCaptchaCount: 0,
    crossedThreshold: false
  };
  let blockedOrCaptchaStreakActive = true;

  for (const run of runs) {
    if (!isTerminalFailure(run)) {
      break;
    }

    result.terminalFailureCount += 1;

    if (blockedOrCaptchaStreakActive && isBlockedOrCaptchaFailure(run)) {
      result.blockedOrCaptchaCount += 1;
    } else {
      blockedOrCaptchaStreakActive = false;
    }
  }

  if (result.blockedOrCaptchaCount >= 3) {
    return {
      ...result,
      shouldAlert: true,
      trigger: "blocked_or_captcha_streak",
      crossedThreshold: result.blockedOrCaptchaCount === 3
    };
  }

  if (result.terminalFailureCount >= 5) {
    return {
      ...result,
      shouldAlert: true,
      trigger: "terminal_failure_streak",
      crossedThreshold: result.terminalFailureCount === 5
    };
  }

  return result;
}
