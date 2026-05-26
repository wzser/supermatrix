import Database from "better-sqlite3";
import type { ProofResult } from "../types.js";
import { parseExpectation, evaluateNumeric } from "./expectation.js";

type Deps = {
  target: Record<string, unknown>;
  expectation: string;
  triggeredAt: number;
};

export async function evaluateSqlite(deps: Deps): Promise<ProofResult> {
  const dbPath = typeof deps.target.db === "string" ? deps.target.db : undefined;
  const sql = typeof deps.target.sql === "string" ? deps.target.sql : undefined;
  if (!dbPath || !sql) {
    return { passed: false, retriable: false, evidence: { note: "sqlite engine requires target.db + target.sql" } };
  }

  let exp;
  try {
    exp = parseExpectation(deps.expectation);
  } catch (err) {
    return { passed: false, retriable: false, evidence: { note: "invalid expectation", error: String(err) } };
  }
  if (exp.kind !== "numeric") {
    return { passed: false, retriable: false, evidence: { note: "sqlite engine only supports numeric expectations" } };
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { passed: false, retriable: false, evidence: { error: `cannot open db: ${String(err)}`, dbPath } };
  }

  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    if (!row) {
      return { passed: false, retriable: false, evidence: { note: "query returned no rows", sql } };
    }
    const firstColValue = Object.values(row)[0];
    const asNum = typeof firstColValue === "number" ? firstColValue : Number(firstColValue);
    if (!Number.isFinite(asNum)) {
      return { passed: false, retriable: false, evidence: { note: "first column not numeric", value: firstColValue } };
    }
    const ok = evaluateNumeric(asNum, exp);
    return {
      passed: ok,
      retriable: false,
      evidence: { value: asNum, expectation: deps.expectation },
    };
  } catch (err) {
    return { passed: false, retriable: false, evidence: { error: String(err), sql } };
  } finally {
    db.close();
  }
}
