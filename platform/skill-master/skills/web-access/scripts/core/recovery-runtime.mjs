function isHealthyState(state) {
  if (!state || typeof state !== "object") {
    return false;
  }

  return state.status === "healthy" || state.healthy === true;
}

function normalizeMaxRounds(value) {
  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`Invalid maxRounds: ${value}`);
  }
  return rounds;
}

export async function runRecoveryLoop({
  maxRounds,
  detectState,
  captureEvidence = async () => null,
  chooseAction = async () => null,
  recordAttempt = async () => {},
  executeAction = async () => {}
} = {}) {
  if (typeof detectState !== "function") {
    throw new Error("detectState is required");
  }

  const rounds = normalizeMaxRounds(maxRounds);
  let attempts = 0;

  for (let round = 1; round <= rounds; round += 1) {
    const state = await detectState({ round });

    if (isHealthyState(state)) {
      return round === 1
        ? { status: "healthy", round, attempts }
        : { status: "recovered", round, attempts };
    }

    let evidence = null;
    try {
      evidence = await captureEvidence(state, { round });
    } catch {
      evidence = null;
    }

    let action = null;
    try {
      action = await chooseAction(state, { round, evidence });
    } catch {
      action = null;
    }

    try {
      await recordAttempt({
        round,
        stateStatus: state?.status || "unknown",
        actionChosen: Boolean(action),
        evidenceCaptured: evidence != null,
        action,
        evidence
      });
    } catch {
    }

    if (action) {
      try {
        await executeAction(action, { round, state, evidence });
      } catch {
      }
    }

    attempts += 1;
  }

  return {
    status: "failed",
    rounds,
    attempts
  };
}
