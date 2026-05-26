export type Expectation =
  | { kind: "numeric"; op: ">=" | ">" | "==" | "<" | "<="; rhs: number }
  | { kind: "mtime_gt_trigger" };

export function parseExpectation(raw: string): Expectation {
  const s = raw.trim();
  if (s === "mtime > trigger") return { kind: "mtime_gt_trigger" };
  const m = s.match(/^(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) throw new Error(`unrecognized expectation: ${raw}`);
  return { kind: "numeric", op: m[1] as Expectation extends { op: infer O } ? O : never, rhs: Number(m[2]) };
}

export function evaluateNumeric(lhs: number, exp: Expectation & { kind: "numeric" }): boolean {
  switch (exp.op) {
    case ">=":
      return lhs >= exp.rhs;
    case ">":
      return lhs > exp.rhs;
    case "==":
      return lhs === exp.rhs;
    case "<":
      return lhs < exp.rhs;
    case "<=":
      return lhs <= exp.rhs;
  }
}

export function evaluateMtimeVsTrigger(mtimeMs: number, triggeredAtMs: number): boolean {
  return mtimeMs > triggeredAtMs;
}
