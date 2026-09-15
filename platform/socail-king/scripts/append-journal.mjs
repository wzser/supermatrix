#!/usr/bin/env node

import process from "node:process";
import { appendJsonl } from "../src/public-safe-ledger.mjs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/append-journal.mjs <jsonl-path> < row.json");
  process.exit(2);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
let row;
try {
  row = JSON.parse(input);
} catch (error) {
  console.error(`invalid JSON: ${error.message}`);
  process.exit(2);
}
if (!row || typeof row !== "object" || Array.isArray(row)) {
  console.error("journal input must be one JSON object");
  process.exit(2);
}

const now = new Date();
row.ts = now.toISOString();
row.ts_ms = now.getTime();
appendJsonl(target, row);
console.log(`appended ${target}`);
