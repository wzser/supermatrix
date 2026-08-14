const POSITIVE_LABEL_PATTERNS = [
  { pattern: /\bcontinue\b/i, weight: 60 },
  { pattern: /\bproceed\b/i, weight: 58 },
  { pattern: /\bsubmit\b/i, weight: 55 },
  { pattern: /\bnext\b/i, weight: 50 },
  { pattern: /\bsave\b/i, weight: 42 },
  { pattern: /\bconfirm\b/i, weight: 40 },
  { pattern: /\bok\b/i, weight: 36 },
  { pattern: /\byes\b/i, weight: 34 },
  { pattern: /\baccept\b/i, weight: 32 }
];

const NEGATIVE_LABEL_PATTERNS = [
  { pattern: /\bcancel\b/i, weight: -65 },
  { pattern: /\bclose\b/i, weight: -55 },
  { pattern: /\bdismiss\b/i, weight: -50 },
  { pattern: /\bback\b/i, weight: -45 },
  { pattern: /\bno\b/i, weight: -40 },
  { pattern: /\bskip\b/i, weight: -35 },
  { pattern: /\blater\b/i, weight: -30 }
];

function getAffordanceText(affordance = {}) {
  return [
    affordance.label,
    affordance.text,
    affordance.value,
    affordance.ariaLabel,
    affordance.title,
    affordance.name
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function scoreAffordance(affordance = {}) {
  const text = getAffordanceText(affordance);
  let score = 0;
  let hasPositiveProgressionSignal = false;

  for (const { pattern, weight } of POSITIVE_LABEL_PATTERNS) {
    if (pattern.test(text)) {
      score += weight;
      hasPositiveProgressionSignal = true;
    }
  }

  for (const { pattern, weight } of NEGATIVE_LABEL_PATTERNS) {
    if (pattern.test(text)) {
      score += weight;
    }
  }

  const type = String(affordance.type || "").toLowerCase();
  const intent = String(affordance.intent || "").toLowerCase();
  const role = String(affordance.role || "").toLowerCase();
  const kind = String(affordance.kind || "").toLowerCase();

  if (type === "submit" && hasPositiveProgressionSignal) {
    score += 70;
  }

  if (intent === "proceed" || intent === "continue" || intent === "submit") {
    score += 35;
    hasPositiveProgressionSignal = true;
  }

  if (role === "button" || kind === "button") {
    score += 5;
  }

  if (!hasPositiveProgressionSignal) {
    return 0;
  }

  return score;
}

export function chooseContinuationAffordance(affordances = []) {
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const affordance of affordances) {
    const score = scoreAffordance(affordance);
    if (score > bestScore) {
      best = affordance;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}
