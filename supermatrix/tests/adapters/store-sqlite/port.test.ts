import { test } from "vitest";
import type { BindingStore } from "../../../src/ports/BindingStore.ts";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";

test("SqliteBindingStore is assignable to BindingStore", () => {
  const store: BindingStore = new SqliteBindingStore(":memory:");
  void store;
});
