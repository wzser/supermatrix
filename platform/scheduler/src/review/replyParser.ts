export type ParsedDecision = {
  reviewId: string;
  decision: "approved" | "patched" | "rejected" | "escalated";
  reason: string;
  patch?: Record<string, unknown>;
  disable?: boolean;
};

export type ParseReplyResult =
  | { ok: true; decisions: ParsedDecision[] }
  | { ok: false; error: string; partial?: ParsedDecision[] };

const VALID_DECISIONS = new Set(["approved", "patched", "rejected", "escalated"]);

// Strip leading/trailing markdown bold markers around a "label:" prefix.
// e.g. "**review_id:** foo" -> "review_id: foo"
function stripBoldLabel(line: string): string {
  // Match patterns like **label:** value
  return line.replace(/\*\*([a-zA-Z_]+)\s*:\s*\*\*\s*/, "$1: ");
}

function stripCodeFences(s: string): string {
  // Remove leading ```json (or ```) and trailing ```
  let trimmed = s.trim();
  trimmed = trimmed.replace(/^```(?:json)?\s*\n?/i, "");
  trimmed = trimmed.replace(/\n?```\s*$/i, "");
  return trimmed.trim();
}

/**
 * Given an array of lines starting where the patch JSON begins (after the
 * "patch:" prefix removed), consume lines until we have a balanced JSON
 * structure. Returns the consumed text and the number of lines consumed.
 *
 * Tolerates code fences. Counts braces/brackets while ignoring strings.
 */
function consumePatchValue(lines: string[], startIdx: number, firstLineRest: string): { text: string; nextIdx: number } {
  // Combine firstLineRest with subsequent lines until balanced
  const collected: string[] = [];
  let combined = firstLineRest;
  collected.push(firstLineRest);

  // If first line is a code fence start with nothing after, advance
  // Count braces, ignoring those in strings
  function countBalance(s: string): { braces: number; brackets: number; sawOpen: boolean } {
    let braces = 0;
    let brackets = 0;
    let sawOpen = false;
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        braces++;
        sawOpen = true;
      } else if (ch === "}") {
        braces--;
      } else if (ch === "[") {
        brackets++;
        sawOpen = true;
      } else if (ch === "]") {
        brackets--;
      }
    }
    return { braces, brackets, sawOpen };
  }

  let bal = countBalance(combined);
  let idx = startIdx;

  // If the first line is just a code fence opener like ```json with no JSON yet,
  // we may not have seen any open brace yet. Keep going.
  while (idx + 1 < lines.length && (!bal.sawOpen || bal.braces > 0 || bal.brackets > 0)) {
    idx++;
    const nextLine = lines[idx];
    collected.push(nextLine);
    combined += "\n" + nextLine;
    bal = countBalance(combined);
    // Stop if we encounter a new field label after we've already seen open brace closed
    if (bal.sawOpen && bal.braces === 0 && bal.brackets === 0) break;
    // Also stop if we hit a closing code fence on this line
    if (/^\s*```\s*$/.test(nextLine) && bal.sawOpen && bal.braces === 0 && bal.brackets === 0) break;
  }

  return { text: collected.join("\n"), nextIdx: idx + 1 };
}

function parseBlock(blockLines: string[]): { ok: true; decision: ParsedDecision } | { ok: false; error: string; partialDecision?: ParsedDecision } {
  // Normalize: strip bold around labels
  const lines = blockLines.map(stripBoldLabel);

  let reviewId: string | undefined;
  let decision: string | undefined;
  let reason: string | undefined;
  let patchRaw: string | undefined;
  let disableRaw: string | undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }

    // Match "label: value" — label is letters/underscore
    const m = trimmed.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const label = m[1].toLowerCase();
    const rest = m[2];

    if (label === "review_id") {
      reviewId = rest.trim();
      i++;
    } else if (label === "decision") {
      decision = rest.trim().toLowerCase();
      i++;
    } else if (label === "reason") {
      reason = rest.trim();
      i++;
    } else if (label === "disable") {
      disableRaw = rest.trim().toLowerCase();
      i++;
    } else if (label === "patch") {
      // Multi-line JSON consumption
      const { text, nextIdx } = consumePatchValue(lines, i, rest);
      patchRaw = text;
      i = nextIdx;
    } else {
      i++;
    }
  }

  if (!reviewId) {
    return { ok: false, error: "missing review_id" };
  }
  if (!decision) {
    return { ok: false, error: `missing decision for review_id=${reviewId}` };
  }
  if (!VALID_DECISIONS.has(decision)) {
    return {
      ok: false,
      error: `unknown decision value "${decision}" for review_id=${reviewId}`,
    };
  }
  if (!reason || reason.length === 0) {
    return { ok: false, error: `missing reason for review_id=${reviewId}` };
  }

  const dec = decision as ParsedDecision["decision"];
  const out: ParsedDecision = {
    reviewId,
    decision: dec,
    reason,
  };

  if (dec === "patched") {
    if (!patchRaw) {
      return { ok: false, error: `missing patch for patched review_id=${reviewId}` };
    }
    const cleaned = stripCodeFences(patchRaw);
    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: `patch is not a JSON object for review_id=${reviewId}` };
      }
      out.patch = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        error: `patch JSON parse failed for review_id=${reviewId}: ${(err as Error).message}`,
      };
    }
  }

  if (dec === "rejected") {
    if (disableRaw === undefined) {
      out.disable = true;
    } else if (disableRaw === "true") {
      out.disable = true;
    } else if (disableRaw === "false") {
      out.disable = false;
    } else {
      return {
        ok: false,
        error: `invalid disable value "${disableRaw}" for review_id=${reviewId}`,
      };
    }
  }

  return { ok: true, decision: out };
}

/**
 * Split the text into blocks. A block starts at a line whose normalized form
 * begins with `review_id:`. Everything before the first such line is treated
 * as a header and discarded.
 */
function splitBlocks(text: string): string[][] {
  const allLines = text.split(/\r?\n/);
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const line of allLines) {
    const normalized = stripBoldLabel(line).trim().toLowerCase();
    if (normalized.startsWith("review_id:")) {
      if (current && current.length > 0) {
        blocks.push(current);
      }
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
    // else: header noise before first review_id — drop
  }
  if (current && current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

export function parseReply(text: string): ParseReplyResult {
  if (!text || text.trim() === "") {
    return { ok: true, decisions: [] };
  }

  const blocks = splitBlocks(text);
  const decisions: ParsedDecision[] = [];

  for (const block of blocks) {
    const result = parseBlock(block);
    if (result.ok) {
      decisions.push(result.decision);
    } else {
      return {
        ok: false,
        error: result.error,
        partial: decisions.length > 0 ? decisions : undefined,
      };
    }
  }

  return { ok: true, decisions };
}
