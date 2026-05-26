import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";

export async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "supermatrix-sqlite-"));
  const store = new SqliteBindingStore(join(dir, "console.db"));
  await store.init();
  return {
    store,
    dir,
    async cleanup() {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
