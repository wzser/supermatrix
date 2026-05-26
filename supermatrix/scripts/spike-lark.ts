#!/usr/bin/env tsx
// Spike: verify @larksuite/cli can do everything the adapter needs.
// This script has NOT been executed yet — it is a placeholder documenting the
// intended verb surface. Run it manually with real credentials before shipping:
//   APP_ID=... APP_SECRET=... OWNER_USER_ID=... ROOT_GROUP_ID=... npx tsx scripts/spike-lark.ts

/* eslint-disable no-console */
async function main() {
  console.log("[spike] TODO: wire up @larksuite/cli and exercise each verb:");
  console.log("  1. subscribeInbound  — verify message callbacks arrive");
  console.log("  2. sendText          — send to ROOT_GROUP_ID");
  console.log("  3. createGroup       — 'spike-test-group' with owner");
  console.log("  4. inviteUser        — add OWNER_USER_ID");
  console.log("  5. postCard          — initial text");
  console.log("  6. updateCard        — append more text");
  console.log("  7. finalizeCard      — final text");
  console.log("  8. dissolveGroup");
  console.log("  9. downloadAttachment — fetch an image / file by remote key");
  console.log("");
  console.log("Print every response shape to stdout, then record findings in");
  console.log("src/adapters/lark-cli/SPIKE_NOTES.md under 'Observed schema'.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
