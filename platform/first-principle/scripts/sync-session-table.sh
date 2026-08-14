#!/usr/bin/env bash
set -euo pipefail

# Sync local sessions + bindings ↔ Feishu bitable.
#
# Field directions (source of truth):
#   - Pull (Feishu → SM DB): Purpose, 别称 (alias), 头像 (avatar), 分类 (category), Heartbeat
#   - Push (SM DB → Feishu): Backend, Scope, Status, Model, Workdir, Group ID, Created, Updated
#
# Pull rule for text/select/attachment: write local only when online value is non-empty.
# Online "non-empty → empty" transitions are NOT propagated (treated as anomaly, logged to stderr).
#
# Pull rule for checkboxes (Heartbeat): both True and False propagate. Checkboxes have no
# "absent" state — False IS the off value. Contract: rules/session-meta-fields.md §5.
#
# Push mechanism: per-row upsert by record_id (no delete + batch-create). 头像 is never
# included in the push payload.
#
# Dedup (2026-05-13): Before the upsert loop, detect any Bitable rows with the same
# Session name and delete all but the Updated-latest. Same-name multiple rows had
# accumulated (test2/test3/ziniao/xjbc 7 stray rows by 5-13) because the upsert path
# never deletes — an init-time race or manual insert could leave orphans the sync
# would forever ignore. The dedup step makes sync self-converging.
#
# Side actions: rename Feishu group + update Feishu group avatar from local PNG cache.
# Both side actions are idempotent: group rename skips when current name already matches;
# group avatar skips when avatar_token matches last-pushed value (cache at data/avatars/.pushed.json).
#
# Usage: ./scripts/sync-session-table.sh

: "${FEISHU_BASE_TOKEN:?set FEISHU_BASE_TOKEN to the target Bitable base token}"
: "${FEISHU_SESSION_TABLE_ID:?set FEISHU_SESSION_TABLE_ID to the session table id}"

RUNTIME_ROOT="${SM_RUNTIME_ROOT:-${HOME}/SuperMatrixRuntime}"
export BASE_TOKEN="$FEISHU_BASE_TOKEN"
export TABLE_ID="$FEISHU_SESSION_TABLE_ID"
export DB="${SM_DB_PATH:-${RUNTIME_ROOT}/data/supermatrix.db}"
export AVATAR_DIR="${SM_AVATAR_DIR:-${RUNTIME_ROOT}/data/avatars}"

mkdir -p "$AVATAR_DIR"

if ! command -v lark-cli &>/dev/null; then
  echo "ERROR: lark-cli not found" >&2; exit 1
fi
if [[ ! -f "$DB" ]]; then
  echo "ERROR: $DB not found" >&2; exit 1
fi

python3 - <<'PYEOF'
import json
import os
import subprocess
import sqlite3
import sys
import time

BASE_TOKEN = os.environ["BASE_TOKEN"]
TABLE_ID   = os.environ["TABLE_ID"]
DB         = os.environ["DB"]
AVATAR_DIR = os.environ["AVATAR_DIR"]


def run(cmd, *, check=True):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if check and res.returncode != 0:
        sys.stderr.write(f"ERROR: command failed (rc={res.returncode}): {' '.join(cmd[:4])}...\n")
        sys.stderr.write(f"  stdout: {res.stdout[:600]}\n")
        sys.stderr.write(f"  stderr: {res.stderr[:600]}\n")
        raise SystemExit(1)
    return res


def lark_json(*args, json_payload=None):
    """lark-cli call that uses --json flag (e.g. base subcommands). Returns parsed JSON."""
    cmd = ["lark-cli"] + list(args)
    if json_payload is not None:
        cmd += ["--json", json.dumps(json_payload, ensure_ascii=False)]
    res = run(cmd)
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(f"ERROR: lark response not JSON: {res.stdout[:600]}\n")
        raise SystemExit(1)


def lark_data(*args, data_payload=None):
    """lark-cli call that uses --data flag (e.g. api / im subcommands). Returns parsed JSON."""
    cmd = ["lark-cli"] + list(args)
    if data_payload is not None:
        cmd += ["--data", json.dumps(data_payload, ensure_ascii=False)]
    res = run(cmd)
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(f"ERROR: lark response not JSON: {res.stdout[:600]}\n")
        raise SystemExit(1)


def db_query(sql, params=()):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def db_exec(sql, params=()):
    conn = sqlite3.connect(DB)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


print("SYNC: sessions ↔ Feishu bitable")

# ━━ Step 1: Fetch online state (subset of fields) ━━
print("  [1/5] Fetching online state...")
resp = lark_json("base", "+record-list",
                 "--base-token", BASE_TOKEN, "--table-id", TABLE_ID,
                 "--format", "json",
                 "--limit", "200",
                 "--field-id", "Session", "--field-id", "Purpose",
                 "--field-id", "别称", "--field-id", "头像",
                 "--field-id", "分类", "--field-id", "Heartbeat",
                 "--field-id", "FP管辖", "--field-id", "Updated")
data = resp.get("data") or {}
fields = data.get("fields") or []
fidx = {name: i for i, name in enumerate(fields)}
rids = data.get("record_id_list") or []
rows = data.get("data") or []

if "Session" not in fidx:
    sys.stderr.write(f"ERROR: 'Session' column missing from response. fields={fields}\n")
    raise SystemExit(1)

# ━━ Step 1.5: Dedup — same-name multi-row → keep Updated-latest, delete rest ━━
# Rationale: the upsert loop only updates one record_id per name, so any stray
# same-name rows (from init races, manual inserts, or early sync bugs) would
# linger forever. This step makes sync self-converging.
si = fidx["Session"]
ui = fidx.get("Updated")  # None if not selected (shouldn't happen now, but be safe)
winners = {}   # name -> (winner_row_idx, winner_updated_str)
to_delete = []
dedup_log = []
for i, row in enumerate(rows):
    name = row[si]
    if not name:
        continue
    upd = (row[ui] if ui is not None else "") or ""
    if name not in winners:
        winners[name] = (i, upd)
        continue
    cur_i, cur_upd = winners[name]
    if upd > cur_upd:
        # current row wins; previous becomes a drop
        to_delete.append(rids[cur_i])
        dedup_log.append((name, rids[cur_i], cur_upd))
        winners[name] = (i, upd)
    else:
        to_delete.append(rids[i])
        dedup_log.append((name, rids[i], upd))

if to_delete:
    print(f"  [1.5/5] DEDUP: deleting {len(to_delete)} duplicate row(s)")
    for name, rid, upd in dedup_log:
        print(f"    drop: {name} record_id={rid} updated={upd or '<empty>'}")
    lark_json("base", "+record-delete", "--yes",
              "--base-token", BASE_TOKEN, "--table-id", TABLE_ID,
              json_payload={"record_id_list": to_delete})
    # Filter local snapshot to only winners so the subsequent online dict build is clean
    drop_set = set(to_delete)
    filtered = [(rid, rows[i]) for i, rid in enumerate(rids) if rid not in drop_set]
    rids = [t[0] for t in filtered]
    rows = [t[1] for t in filtered]
else:
    print("  [1.5/5] DEDUP: no same-name duplicates")

online = {}  # name -> {record_id, purpose, alias, avatar_token, category}
for i, row in enumerate(rows):
    name = row[fidx["Session"]]
    if not name:
        continue
    avatar_field = row[fidx["头像"]] if "头像" in fidx else None
    avatar_token = ""
    if isinstance(avatar_field, list) and avatar_field:
        avatar_token = (avatar_field[0] or {}).get("file_token", "") or ""
    category_field = row[fidx["分类"]] if "分类" in fidx else None
    category = ""
    if isinstance(category_field, list) and category_field:
        category = category_field[0] or ""
    elif isinstance(category_field, str):
        category = category_field
    heartbeat_field = row[fidx["Heartbeat"]] if "Heartbeat" in fidx else None
    fp_managed_field = row[fidx["FP管辖"]] if "FP管辖" in fidx else None
    # Bitable returns checkbox as bool (True / False / None when never set).
    online[name] = {
        "record_id":    rids[i],
        "purpose":      (row[fidx["Purpose"]] if "Purpose" in fidx else None) or "",
        "alias":        (row[fidx["别称"]]   if "别称"   in fidx else None) or "",
        "avatar_token": avatar_token,
        "category":     category,
        "heartbeat":    heartbeat_field,    # True / False / None
        "fp_managed":   fp_managed_field,   # True / False / None
    }

print(f"    Online records: {len(online)}")

# ━━ Step 2: Pull-direction fields → local DB ━━
# Online non-empty wins. Online empty + local non-empty = anomaly; do not clear local.
print("  [2/5] Pulling Purpose / 别称 / 头像 / 分类 / Heartbeat / FP管辖 → local DB...")
local_rows = {r["name"]: r for r in db_query(
    "SELECT name, COALESCE(purpose,'') AS purpose, COALESCE(alias,'') AS alias, "
    "COALESCE(avatar,'') AS avatar, COALESCE(category,'') AS category, "
    "COALESCE(heartbeat_enabled,0) AS heartbeat_enabled, fp_managed "
    "FROM sessions WHERE scope != 'child';"
)}

warns = 0
for name, info in online.items():
    if name not in local_rows:
        # Online has a row that doesn't exist locally — leave alone, FP doesn't reach in to delete.
        continue
    local = local_rows[name]

    for col, key, label in [("purpose",  "purpose",  "Purpose"),
                            ("alias",    "alias",    "别称"),
                            ("category", "category", "分类")]:
        new_val = info[key]
        if isinstance(new_val, str):
            new_val = new_val.strip()
        cur = local[col]
        if new_val:
            if new_val != cur:
                db_exec(f"UPDATE sessions SET {col} = ? WHERE name = ?", (new_val, name))
                print(f"    ← {name} {label}: {cur!r} → {new_val!r}")
        elif cur:
            print(f"    WARN: {name} {label} online-empty, local kept ({cur!r})", file=sys.stderr)
            warns += 1

    new_token = info["avatar_token"]
    cur_token = local["avatar"]
    if new_token:
        if new_token != cur_token:
            db_exec("UPDATE sessions SET avatar = ? WHERE name = ?", (new_token, name))
            print(f"    ← {name} 头像: {cur_token!r} → {new_token!r}")
        # Bitable attachments need the medias endpoint with bitablePerm context;
        # the plain `drive +download` returns HTTP 403 for table-scoped tokens.
        out_name = name + ".png"
        extra = json.dumps({"bitablePerm": {"tableId": TABLE_ID, "baseToken": BASE_TOKEN}})
        last_res = None
        for attempt in range(2):
            if attempt:
                time.sleep(1.5)
            res = subprocess.run(
                ["lark-cli", "api", "GET",
                 f"/open-apis/drive/v1/medias/{new_token}/download",
                 "--params", json.dumps({"extra": extra}),
                 "--as", "user",
                 "--output", out_name],
                capture_output=True, text=True, cwd=AVATAR_DIR,
            )
            if res.returncode == 0:
                break
            last_res = res
        else:
            err = (last_res.stderr if last_res else "")[:400]
            sys.stderr.write(f"ERROR: avatar download failed for {name}: {err}\n")
            raise SystemExit(1)
    elif cur_token:
        print(f"    WARN: {name} 头像 online-empty, local token kept ({cur_token!r})", file=sys.stderr)
        warns += 1

    # Heartbeat: checkbox column. True/False both propagate; None (column never set)
    # leaves local unchanged. Contract: rules/session-meta-fields.md §5.
    hb_online = info["heartbeat"]
    cur_hb = int(local["heartbeat_enabled"] or 0)
    if hb_online is None:
        if cur_hb:
            print(f"    WARN: {name} Heartbeat field missing in Bitable, local kept ({cur_hb})", file=sys.stderr)
            warns += 1
    else:
        new_hb = 1 if hb_online else 0
        if new_hb != cur_hb:
            db_exec("UPDATE sessions SET heartbeat_enabled = ? WHERE name = ?", (new_hb, name))
            print(f"    ← {name} Heartbeat: {cur_hb} → {new_hb}")

    # FP管辖: checkbox column → fp_managed INTEGER (1/0/NULL). True→1, False→0,
    # None (column never set) leaves local unchanged — NULL stays NULL, which
    # renderOtherSessionsBlock treats as in-scope. Contract: rules/session-meta-fields.md.
    fp_online = info["fp_managed"]
    cur_fp = local["fp_managed"]  # 1 / 0 / None
    if fp_online is None:
        if cur_fp is not None:
            print(f"    WARN: {name} FP管辖 field missing in Bitable, local kept ({cur_fp})", file=sys.stderr)
            warns += 1
    else:
        new_fp = 1 if fp_online else 0
        if new_fp != cur_fp:
            db_exec("UPDATE sessions SET fp_managed = ? WHERE name = ?", (new_fp, name))
            print(f"    ← {name} FP管辖: {cur_fp} → {new_fp}")

if warns:
    print(f"    ({warns} pull warnings — see stderr)")

# ━━ Step 3: Upsert SM-authoritative fields (no delete) ━━
print("  [3/5] Upserting records (push-only fields, no 头像/Purpose/别称/分类)...")
push_rows = db_query("""
    SELECT s.name, s.backend, s.scope, s.status, COALESCE(s.model,'') AS model,
           s.workdir, COALESCE(b.group_id,'') AS group_id,
           s.created_at, s.updated_at
      FROM sessions s
      LEFT JOIN bindings b ON s.id = b.session_id
     WHERE s.scope != 'child'
     ORDER BY s.name
""")

n_upd, n_new = 0, 0
for r in push_rows:
    payload = {
        "Session":  r["name"],
        "Backend":  r["backend"],
        "Scope":    r["scope"],
        "Status":   r["status"],
        "Model":    r["model"],
        "Workdir":  r["workdir"],
        "Group ID": r["group_id"],
        "Created":  r["created_at"],
        "Updated":  r["updated_at"],
    }
    args = ["base", "+record-upsert", "--base-token", BASE_TOKEN, "--table-id", TABLE_ID]
    is_update = r["name"] in online
    if is_update:
        args += ["--record-id", online[r["name"]]["record_id"]]
    res = lark_json(*args, json_payload=payload)
    if is_update:
        n_upd += 1
    else:
        n_new += 1
        d = res.get("data") or {}
        rid = (d.get("record") or {}).get("record_id") or d.get("record_id")
        if rid:
            online[r["name"]] = {"record_id": rid, "purpose": "", "alias": "",
                                 "avatar_token": "", "category": "",
                                 "heartbeat": None}

print(f"    Upserted: {n_upd} updated, {n_new} created")

# ━━ Step 4: Update Feishu group names ━━
# Pattern: `{prefix}-{name}-{backend}` (prefix falls back alias → chat_name → empty).
# chat_name is the CLI-supplied prefix captured at /new; if bitable 别称 is set, it wins.
# No verbatim overrides — structure stays uniform across all groups.
print("  [4/5] Updating group names...")
try:
    gn_rows = db_query("""
        SELECT s.name, COALESCE(s.alias,'') AS alias, s.backend,
               COALESCE(s.chat_name,'') AS chat_name, b.group_id
          FROM sessions s
          JOIN bindings b ON s.id = b.session_id
         WHERE s.status != 'deleted' AND s.scope != 'child'
    """)
except sqlite3.OperationalError as e:
    if "no such column" in str(e).lower():
        sys.stderr.write(f"    WARN: sessions.chat_name not present yet; falling back. ({e})\n")
        gn_rows = db_query("""
            SELECT s.name, COALESCE(s.alias,'') AS alias, s.backend,
                   '' AS chat_name, b.group_id
              FROM sessions s
              JOIN bindings b ON s.id = b.session_id
             WHERE s.status != 'deleted' AND s.scope != 'child'
        """)
    else:
        raise
for r in gn_rows:
    gid = r["group_id"]
    if not gid:
        continue
    prefix = r["alias"] or r.get("chat_name") or ""
    new_name = (f"{prefix}-{r['name']}-{r['backend']}"
                if prefix else f"{r['name']}-{r['backend']}")
    cur = lark_data("api", "GET", f"/open-apis/im/v1/chats/{gid}", "--as", "bot")
    cur_name = (cur.get("data") or {}).get("name", "") or ""
    if cur_name == new_name:
        continue
    lark_data("api", "PUT", f"/open-apis/im/v1/chats/{gid}", "--as", "bot",
              data_payload={"name": new_name})
    print(f"    ✓ {r['name']}: '{cur_name}' → '{new_name}'")

# ━━ Step 5: Update Feishu group avatars from cached PNG ━━
# Idempotent: skip when avatar_token matches the last-pushed value for this session.
# Cache: data/avatars/.pushed.json = {session_name: last_pushed_avatar_token}
print("  [5/5] Updating group avatars...")
pushed_cache_path = os.path.join(AVATAR_DIR, ".pushed.json")
try:
    with open(pushed_cache_path) as f:
        pushed_cache = json.load(f)
        if not isinstance(pushed_cache, dict):
            pushed_cache = {}
except (FileNotFoundError, json.JSONDecodeError):
    pushed_cache = {}

ga_rows = db_query("""
    SELECT s.name, COALESCE(s.avatar,'') AS avatar, b.group_id
      FROM sessions s
      JOIN bindings b ON s.id = b.session_id
     WHERE s.status != 'deleted' AND s.scope != 'child' AND s.avatar != ''
""")
n_pushed, n_skipped = 0, 0
for r in ga_rows:
    gid = r["group_id"]
    if not gid:
        continue
    cur_token = r["avatar"]
    if pushed_cache.get(r["name"]) == cur_token:
        n_skipped += 1
        continue
    img_path = os.path.join(AVATAR_DIR, r["name"] + ".png")
    if not os.path.isfile(img_path):
        print(f"    skip {r['name']}: no cached PNG at {img_path}", file=sys.stderr)
        continue
    # Upload image → image_key. lark-cli rejects absolute --file paths, so cd into dir first.
    res = subprocess.run(
        ["lark-cli", "im", "images", "create", "--as", "bot",
         "--data", '{"image_type":"avatar"}',
         "--file", f"image={r['name']}.png"],
        capture_output=True, text=True, cwd=AVATAR_DIR,
    )
    if res.returncode != 0:
        sys.stderr.write(f"ERROR: image upload failed for {r['name']}: {res.stderr[:400]}\n")
        raise SystemExit(1)
    try:
        image_key = ((json.loads(res.stdout).get("data") or {}).get("image_key") or "")
    except json.JSONDecodeError:
        sys.stderr.write(f"ERROR: image upload response not JSON: {res.stdout[:400]}\n")
        raise SystemExit(1)
    if not image_key:
        sys.stderr.write(f"ERROR: no image_key for {r['name']}: {res.stdout[:400]}\n")
        raise SystemExit(1)
    lark_data("api", "PUT", f"/open-apis/im/v1/chats/{gid}", "--as", "bot",
              data_payload={"avatar": image_key})
    pushed_cache[r["name"]] = cur_token
    n_pushed += 1
    print(f"    ✓ {r['name']} group avatar updated")

with open(pushed_cache_path, "w") as f:
    json.dump(pushed_cache, f, ensure_ascii=False, indent=2, sort_keys=True)
print(f"    Avatar push summary: {n_pushed} pushed, {n_skipped} skipped (unchanged)")

print("SYNC: complete")
PYEOF
