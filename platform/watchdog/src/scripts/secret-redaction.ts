import { createHash } from "node:crypto";

export const SECRET_REDACTION_MARKER_PREFIX = "[REDACTED_SECRET:";

export type SecretRuleId =
  | "anthropic_api_key"
  | "aws_access_key_id"
  | "aws_secret_access_key"
  | "bearer_token"
  | "generic_labelled_secret"
  | "github_token"
  | "google_api_key"
  | "openai_api_key"
  | "private_key"
  | "slack_token"
  | "stripe_secret_key";

export type SecretMatch = {
  ruleId: SecretRuleId;
  start: number;
  end: number;
  value: string;
  hash: string;
  marker: string;
};

export type RedactedText = {
  changed: boolean;
  redactedText: string;
  matches: SecretMatch[];
};

type RegexRule = {
  ruleId: SecretRuleId;
  regex: RegExp;
  valueGroup: number;
  priority: number;
  requiresEntropy?: boolean;
};

type Candidate = SecretMatch & {
  priority: number;
};

const REDACTION_MARKER_RE = /\[REDACTED_SECRET:[a-f0-9]{12}\]/u;
const SUPERMATRIX_ID_RE =
  /^(?:mr|sess|oc|ou|comm|async|task|run|msg|child_codexroot|child_claude|child)[A-Za-z0-9_-]*_[A-Za-z0-9_-]+$/iu;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_HASH_RE = /^[0-9a-f]{32,128}$/iu;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+)?$/u;

const SECRET_LABEL =
  "(?:api[_-]?key|secret|token|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|openai[_-]?api[_-]?key|anthropic[_-]?api[_-]?key|feishu[_-]?app[_-]?secret|lark[_-]?app[_-]?secret)";

const RULES: RegexRule[] = [
  {
    ruleId: "private_key",
    regex:
      /(-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----)/gu,
    valueGroup: 1,
    priority: 120,
  },
  {
    ruleId: "anthropic_api_key",
    regex: /\b(sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{24,})\b/gu,
    valueGroup: 1,
    priority: 110,
  },
  {
    ruleId: "openai_api_key",
    regex: /\b(sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,})\b/gu,
    valueGroup: 1,
    priority: 110,
  },
  {
    ruleId: "github_token",
    regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
    valueGroup: 1,
    priority: 105,
  },
  {
    ruleId: "slack_token",
    regex: /\b(xox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,})\b/gu,
    valueGroup: 1,
    priority: 105,
  },
  {
    ruleId: "stripe_secret_key",
    regex: /\b(sk_live_[A-Za-z0-9]{20,})\b/gu,
    valueGroup: 1,
    priority: 105,
  },
  {
    ruleId: "google_api_key",
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/gu,
    valueGroup: 1,
    priority: 105,
  },
  {
    ruleId: "aws_access_key_id",
    regex: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/gu,
    valueGroup: 1,
    priority: 100,
  },
  {
    ruleId: "aws_secret_access_key",
    regex: /\baws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?=["'\s,;}\]]|$)/giu,
    valueGroup: 1,
    priority: 100,
  },
  {
    ruleId: "bearer_token",
    regex: /\bBearer\s+([A-Za-z0-9._~+/=-]{24,})(?=["'\s,;}\]]|$)/gu,
    valueGroup: 1,
    priority: 70,
    requiresEntropy: true,
  },
  {
    ruleId: "generic_labelled_secret",
    regex: new RegExp(
      `(?:["']?${SECRET_LABEL}["']?\\s*[:=]\\s*["'\`]?)` +
        "([A-Za-z0-9._~+/=-]{16,})(?=[\"'`\\s,;}\\]]|$)",
      "giu",
    ),
    valueGroup: 1,
    priority: 60,
    requiresEntropy: true,
  },
];

export function findSecretMatches(text: string): SecretMatch[] {
  if (text.length === 0) return [];
  const candidates: Candidate[] = [];

  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.regex.exec(text)) !== null) {
      const value = match[rule.valueGroup];
      if (value === undefined) continue;

      const relativeStart = match[0].indexOf(value);
      if (relativeStart < 0 || match.index === undefined) continue;

      const start = match.index + relativeStart;
      const end = start + value.length;
      if (!shouldKeepCandidate(value, rule)) continue;

      const hash = hashSecret(value);
      candidates.push({
        ruleId: rule.ruleId,
        start,
        end,
        value,
        hash,
        marker: markerForHash(hash),
        priority: rule.priority,
      });

      if (rule.regex.lastIndex === match.index) rule.regex.lastIndex += 1;
    }
  }

  return pickNonOverlapping(candidates).map(({ priority: _priority, ...match }) => match);
}

export function redactSecretsInText(text: string): RedactedText {
  const matches = findSecretMatches(text);
  if (matches.length === 0) {
    return { changed: false, redactedText: text, matches };
  }

  let redactedText = text;
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    redactedText = redactedText.slice(0, match.start) + match.marker + redactedText.slice(match.end);
  }

  return { changed: true, redactedText, matches };
}

export function markerForHash(hash: string): string {
  return `${SECRET_REDACTION_MARKER_PREFIX}${hash.slice(0, 12)}]`;
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shouldKeepCandidate(value: string, rule: RegexRule): boolean {
  if (REDACTION_MARKER_RE.test(value)) return false;
  if (isLikelyNonSecret(value)) return false;
  if (rule.requiresEntropy) {
    return hasSecretShape(value);
  }
  return true;
}

function isLikelyNonSecret(value: string): boolean {
  if (SUPERMATRIX_ID_RE.test(value)) return true;
  if (UUID_RE.test(value)) return true;
  if (HEX_HASH_RE.test(value)) return true;
  if (ISO_DATE_RE.test(value)) return true;
  if (value.startsWith("/Users/") || value.startsWith("file://")) return true;
  if (/^(?:claude|gpt|opus|sonnet|haiku|gemini|kimi|deepseek)[A-Za-z0-9._-]*$/iu.test(value)) return true;
  return false;
}

function hasSecretShape(value: string): boolean {
  if (value.length < 16) return false;
  if (!/[A-Za-z]/u.test(value)) return false;
  if (!/[0-9]/u.test(value)) return false;
  if (shannonEntropy(value) < 3.2) return false;
  return true;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function pickNonOverlapping(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.end - b.start - (a.end - a.start);
  });

  const selected: Candidate[] = [];
  for (const candidate of sorted) {
    const overlaps = selected.some((existing) => candidate.start < existing.end && candidate.end > existing.start);
    if (!overlaps) selected.push(candidate);
  }
  return selected;
}
