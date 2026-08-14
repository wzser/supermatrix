#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const payload = JSON.parse(input || "{}");
  process.stdout.write(JSON.stringify({
    ok: true,
    summary: "echo complete",
    evidence: {
      record_id: payload.record_id,
      field_count: Object.keys(payload.fields || {}).length
    }
  }));
});
