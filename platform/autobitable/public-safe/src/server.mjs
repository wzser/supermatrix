// This is only the public-safe entry point. The adapter implementation remains
// in the owner source at ../../src/server.mjs; this file intentionally contains
// no second ingress, queue, ledger, idempotency, or settlement implementation.
import { createAutobitableServer as createOwnerAutobitableServer } from "../../src/server.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function createAutobitableServer(options = {}) {
  return createOwnerAutobitableServer({ ...options, publicSafeProfile: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.AUTOBITABLE_PORT ?? 3510);
  const server = await createAutobitableServer();
  server.listen(port, process.env.AUTOBITABLE_HOST ?? "127.0.0.1", () => {
    process.stdout.write(`autobitable listening on http://${process.env.AUTOBITABLE_HOST ?? "127.0.0.1"}:${port}\n`);
  });
}
