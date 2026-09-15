#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendJsonl,
  assertExceptionTransaction,
  projectJudgmentTableRow,
  readJsonl,
  validateJudgment,
  validateExceptionEvent,
  validateSpawn2Request,
  validateTerminalInterview,
} from "../src/public-safe-ledger.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "public-safe-flow-"));
const journalPath = path.join(tempRoot, "state", "judgments.jsonl");
const exceptionPath = path.join(tempRoot, "state", "exception-transactions.jsonl");
const tablePath = path.join(tempRoot, "table-rows.jsonl");

function makeExceptionTransaction({ snapshot = {}, closed = {} } = {}) {
  const open = {
    ref: "spawnq_stub_001",
    comm_id: "comm_stub_002",
    event: "open",
    status: "open",
    snapshot: {
      failed_phase: "delivery",
      failure_kind: "delivery_missing",
      attempt_count: 1,
      async_status: "waiting_child",
      result_evidence: { present: true, ref: "result_stub_002" },
      target_evidence: { present: true, ref: "delivery_stub_002" },
      ...snapshot,
    },
  };
  if (Object.hasOwn(snapshot, "target_evidence") && snapshot.target_evidence === undefined) {
    delete open.snapshot.target_evidence;
  }
  return [
    open,
    {
      ref: open.ref,
      comm_id: open.comm_id,
      event: "intent",
      status: "intent",
      action: "verify_delivery_evidence",
    },
    {
      ref: open.ref,
      comm_id: open.comm_id,
      event: "closed",
      status: "closed",
      verdict: "contract_fault",
      verdict_reason: "The frozen snapshot shows a contract fault; park the contract.",
      action: "park_contract",
      host_writeback: { read_back_verified: true, ref: "writeback_stub_002" },
      ...closed,
    },
  ];
}

function stubSpawn2Terminal({ target, finalMessage, caseKey }) {
  const request = {
    from: "agent-a",
    target,
    prompt: `Synthetic interview for ${caseKey}`,
    client_request_id: `2099-01-02:agent-a:${target}:judgment-interview:${caseKey}`,
    closure: { kind: "message", target: { type: "inline" } },
  };
  validateSpawn2Request(request);
  return { ok: true, status: "completed", target, finalMessage };
}

try {
  assert.throws(() => validateSpawn2Request({
    from: "agent-a",
    target: "agent-b",
    prompt: "synthetic",
    client_request_id: "2099-01-02:agent-a:agent-b:case",
    mode: "legacy",
    closure: { kind: "message", target: { type: "inline" } },
  }), /unsupported Spawn2 request fields/);
  assert.throws(() => assertExceptionTransaction([
    { ref: "stub", comm_id: "stub", event: "open", status: "open", snapshot: {} },
  ]), /transaction must contain/);
  assert.throws(() => validateExceptionEvent({
    ref: "stub",
    comm_id: "stub",
    event: "closed",
    status: "closed",
    verdict: "retrying",
    verdict_reason: "not terminal",
    host_writeback: { read_back_verified: true, ref: "stub-writeback" },
  }), /allowed verdict/);
  assert.throws(() => assertExceptionTransaction(makeExceptionTransaction({
    snapshot: { target_evidence: undefined },
  })), /snapshot is missing target_evidence/);
  assert.throws(() => assertExceptionTransaction(makeExceptionTransaction({
    snapshot: { target_evidence: { present: false, reason: "no_delivery_receipt" } },
    closed: { verdict: "false_alarm", verdict_reason: "delivery was proven elsewhere" },
  })), /false_alarm requires proven target evidence/);
  assert.throws(() => assertExceptionTransaction(makeExceptionTransaction({
    closed: { host_writeback: { read_back_verified: false, ref: "writeback_stub_002" } },
  })), /verified host writeback/);
  assert.throws(() => assertExceptionTransaction(makeExceptionTransaction({
    closed: { host_writeback: undefined },
  })), /verified host writeback/);

  const a = stubSpawn2Terminal({
    target: "agent-a",
    caseKey: "stub-001",
    finalMessage: "A expected a concrete answer and had to repeat the request.",
  });
  const b = stubSpawn2Terminal({
    target: "agent-b",
    caseKey: "stub-001",
    finalMessage: "B understood the request as a status note, not a completion answer.",
  });
  validateTerminalInterview(a, "A");
  validateTerminalInterview(b, "B");

  const judgment = validateJudgment({
    id: "judg-2099-01-02-001",
    judgment_id: "judg-2099-01-02-001",
    kind: "primary",
    theme: "communication_gap",
    user_visible_symptom: "The request was repeated twice because the intended answer was not recognizable.",
    function_loss: "The caller spent time repeating the request and the original work stayed blocked.",
    evidence: {
      source: "cross_session_log",
      source_comm_id: "comm_stub_001",
      interview_a: a.finalMessage,
      interview_b: b.finalMessage,
    },
    interview_a: a.finalMessage,
    interview_b: b.finalMessage,
    confidence: "high",
    gray_zone_hit: "none",
    applied_to_rule: null,
    status: "pending",
    ts_ms: 4070908800000,
  });
  appendJsonl(journalPath, { ...judgment, event: "primary" });

  const tableRow = projectJudgmentTableRow(judgment);
  appendJsonl(tablePath, tableRow);
  assert.equal(Object.hasOwn(tableRow, "user_verdict"), false);
  assert.equal(Object.hasOwn(tableRow, "user_note"), false);
  assert.equal(Object.hasOwn(tableRow, "record_id"), false);

  for (const event of makeExceptionTransaction({
    snapshot: { target_evidence: { present: false, reason: "no_delivery_receipt" } },
    closed: {
      verdict_reason: "The frozen snapshot shows missing target evidence; park the contract.",
    },
  })) appendJsonl(exceptionPath, event);
  assertExceptionTransaction(readJsonl(exceptionPath));

  assert.equal(readJsonl(journalPath).length, 1);
  assert.equal(readJsonl(tablePath).length, 1);
  assert.equal(readJsonl(exceptionPath).map((event) => event.event).join("->"), "open->intent->closed");

  const forbiddenFiles = [];
  const forbiddenPatterns = [
    new RegExp("/" + "Users/"),
    /o(?:c)_[a-z0-9]{6,}/,
    /ba(?:scn)[a-z0-9]{6,}/,
    /t(?:bl)[a-z0-9]{6,}/,
    /r(?:ec)_[a-z0-9]{6,}/,
    /K(?:ey)chain/,
  ];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(item);
      else if (entry.isFile() && /\.(md|json|mjs)$/.test(entry.name)) {
        const content = fs.readFileSync(item, "utf8");
        if (forbiddenPatterns.some((pattern) => pattern.test(content))) forbiddenFiles.push(path.relative(packageRoot, item));
      }
    }
  }
  scan(packageRoot);
  assert.deepEqual(forbiddenFiles, [], `public-safe leakage: ${forbiddenFiles.join(", ")}`);
  console.log(JSON.stringify({ ok: true, checks: ["spawn2 A/B terminal", "spawn2 unknown-field rejection", "judgment schema", "append-only journal", "table authority split", "exception snapshot gate", "false_alarm evidence gate", "exception open-intent-closed", "closed verdict gate", "exception negative matrix", "public-safe scan"] }));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
