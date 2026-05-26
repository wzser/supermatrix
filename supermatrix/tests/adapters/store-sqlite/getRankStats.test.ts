import { describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";

async function makeSeededStore() {
  const store = new SqliteBindingStore(":memory:");
  await store.init();
  const db = (store as any).db;

  db.prepare(
    `INSERT INTO sessions (id, name, alias, avatar, category, scope, backend, workdir, status, created_at, updated_at)
     VALUES
       ('sess_1', 'console', '', '', '', 'user', 'claude', '/tmp', 'idle', 0, 0),
       ('sess_2', 'zedong',  '', '', '', 'user', 'claude', '/tmp', 'idle', 0, 0),
       ('sess_3', 'monet',   '', '', '', 'user', 'claude', '/tmp', 'idle', 0, 0)`
  ).run();

  // user A: 3 in console (oc_c), 2 in zedong (oc_z), 1 in monet (oc_m) = 6 total
  // user B: 4 in zedong (oc_z) = 4 total
  // historical row: no sender_id
  // continuation row: framework-generated child continuation, not a real Feishu user
  const ins = db.prepare(
    `INSERT INTO message_runs (id, session_id, group_id, prompt, started_at, status, sender_id)
     VALUES (?, ?, ?, ?, ?, 'done', ?)`
  );
  const now = Date.now();
  const recent = (offset: number) => now - offset;
  const old = now - 8 * 24 * 60 * 60 * 1000;
  const rows = [
    ['r1',  'sess_1', 'oc_c', 'a',                                      recent(1000),  'ou_user_a'],
    ['r2',  'sess_1', 'oc_c', 'bb https://example.com/ignored',          recent(2000),  'ou_user_a'],
    ['r3',  'sess_1', 'oc_c', 'ccc',                                    recent(3000),  'ou_user_a'],
    ['r4',  'sess_2', 'oc_z', 'dddd',                                   recent(4000),  'ou_user_a'],
    ['r5',  'sess_2', 'oc_z', 'eeeee data:image/webp;base64,IGNORED',   recent(5000),  'ou_user_a'],
    ['r6',  'sess_3', 'oc_m', 'ffffff',                                 recent(6000),  'ou_user_a'],
    ['r7',  'sess_2', 'oc_z', 'gg',                                     recent(7000),  'ou_user_b'],
    ['r8',  'sess_2', 'oc_z', 'hh',                                     recent(8000),  'ou_user_b'],
    ['r9',  'sess_2', 'oc_z', 'ii',                                     recent(9000),  'ou_user_b'],
    ['r10', 'sess_2', 'oc_z', 'jj',                                     recent(10000), 'ou_user_b'],
    ['r11', 'sess_1', 'oc_c', 'ignored',                                recent(11000), null],  // historical — no sender
    ['r12', 'sess_2', 'oc_z', 'ignored continuation payload',            recent(12000), 'continuation:sess_child_1'],
    ['r13', 'sess_1', 'oc_c', 'old-user-message',                       old,           'ou_user_a'],
  ];
  for (const r of rows) ins.run(...r);
  return store;
}

describe("getRankStats — global scope", () => {
  test("returns users sorted by total desc, excludes non-user senders", async () => {
    const store = await makeSeededStore();
    const stats = await store.getRankStats({ scope: "global" });

    expect(stats.rows).toHaveLength(2);
    expect(stats.rows.map((r) => r.senderId)).not.toContain("continuation:sess_child_1");
    expect(stats.rows[0].senderId).toBe("ou_user_a");
    expect(stats.rows[0].total).toBe(6);
    expect(stats.rows[0].inputChars).toBe(21);
    expect(stats.rows[1].senderId).toBe("ou_user_b");
    expect(stats.rows[1].total).toBe(4);
    expect(stats.rows[1].inputChars).toBe(8);
  });

  test("top3Sessions is sorted desc and limited to 3", async () => {
    const store = await makeSeededStore();
    const stats = await store.getRankStats({ scope: "global" });

    const userA = stats.rows.find((r) => r.senderId === "ou_user_a")!;
    expect(userA.top3Sessions).toHaveLength(3);
    expect(userA.top3Sessions[0]).toEqual({ sessionName: "console", count: 3 });
    expect(userA.top3Sessions[1]).toEqual({ sessionName: "zedong",  count: 2 });
    expect(userA.top3Sessions[2]).toEqual({ sessionName: "monet",   count: 1 });
  });

  test("trackingSince is the rolling 7-day window start", async () => {
    const store = await makeSeededStore();
    const before = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stats = await store.getRankStats({ scope: "global" });
    const after = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(stats.trackingSince).toBeGreaterThanOrEqual(before);
    expect(stats.trackingSince).toBeLessThanOrEqual(after);
  });

  test("returns empty + window start when no sender_id rows", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const before = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stats = await store.getRankStats({ scope: "global" });
    const after = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(stats.rows).toHaveLength(0);
    expect(stats.trackingSince).toBeGreaterThanOrEqual(before);
    expect(stats.trackingSince).toBeLessThanOrEqual(after);
  });
});

describe("getRankStats — group scope", () => {
  test("returns only rows from the given groupId, top3Sessions is empty", async () => {
    const store = await makeSeededStore();
    const stats = await store.getRankStats({
      scope: "group",
      groupId: asLarkGroupId("oc_z"),
    });

    expect(stats.rows).toHaveLength(2);
    const ids = stats.rows.map((r) => r.senderId);
    expect(ids).toContain("ou_user_a");
    expect(ids).toContain("ou_user_b");
    for (const row of stats.rows) {
      expect(row.top3Sessions).toHaveLength(0);
    }
  });
});

describe("getDisplayNames", () => {
  test("returns empty map for empty input", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    const result = await store.getDisplayNames([]);
    expect(result.size).toBe(0);
  });

  test("returns cached entries that exist, skips missing", async () => {
    const store = new SqliteBindingStore(":memory:");
    await store.init();
    (store as any).db
      .prepare(
        `INSERT INTO user_display_names (sender_id, display_name, fetched_at)
         VALUES ('ou_abc', 'YOUR_NAME', 1000000)`
      )
      .run();

    const result = await store.getDisplayNames(["ou_abc", "ou_missing"]);
    expect(result.get("ou_abc")).toEqual({ displayName: "YOUR_NAME", fetchedAt: 1000000 });
    expect(result.has("ou_missing")).toBe(false);
  });
});
