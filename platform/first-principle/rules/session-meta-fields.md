# Session Meta Fields Contract

> Owner: first-principle (this session) | Created: 2026-05-02 | Rev: v1.2
>
> Authority: This document is the **single source of truth** for the format / writer / sync timing / authoritative source / validation of the session-meta fields on the `sessions` SQLite table. Implementation (in `SuperMatrix/src/...`) MUST conform to this contract; if implementation needs to deviate, it MUST first propose a contract revision via `/first-principle` skill or HTTP spawn to first-principle.

## Why this exists

**Problem.** As of 2026-05-02 the four session-meta columns (`avatar / alias / category / chat_name`) had never been formally specified. Field values drifted across writers: `avatar` stored 4 incompatible formats (Bitable file_token, IM image_key, https URL, data URL, local filesystem path), `alias` had unclear uniqueness rules, `category` had an undocumented enum, `chat_name` was unclear whether it was cache, display, or dead. The triggering incident: 2026-05-02 todomaster `/new` finished but the Feishu group avatar never wrote back because `sync-session-table.sh` could not understand the URL written into `sessions.avatar`.

**Goal.** Pin down each field's format, writer, sync direction, authority, validation, and the migration plan for non-conforming rows, so that downstream code (framework src, sync scripts, init flows) has one reference to point at.

## Field catalog

### 1. `sessions.avatar` — settled v1.0

| Dimension | Contract |
|---|---|
| **Format** | Bitable attachment `file_token` (string, 27 chars, base62-ish, no scheme prefix). Empty string `''` means "no avatar set". |
| **Writer** | Two and only two writers: (a) `scripts/sync-session-table.sh` (pulls from Bitable column 「头像」 and writes the file_token); (b) `scripts/bitable-init-sync.sh` invoked at session-init step 8 (writes the file_token after uploading the local PNG to Bitable). No other code path may write `sessions.avatar` directly. |
| **When sync** | Pull-only from Bitable: every run of `sync-session-table.sh`. Push direction (DB → Bitable) is forbidden — Bitable is the source of truth, DB is a cache. |
| **Authoritative source** | Feishu Bitable table `<FP_SESSION_TABLE_ID>` column 「头像」. The local PNG cache `data/avatars/{name}.png` is a **derived artifact** for re-uploading to Feishu group avatars; not authoritative. |
| **Validation** | On read: `len == 0 OR (len == 27 AND matches /^[A-Za-z0-9]+$/)`. On write (sync script): reject any value that is not a file_token; log + skip. URL / data URL / file path are all rejected. |
| **Migration** | Rows with non-conforming values (todomaster, fuwuqi, deepautosearch, final-answer as of snapshot) MUST be normalised by: (i) decoding/downloading the existing image to `data/avatars/{name}.png`; (ii) uploading to Bitable 「头像」 column to obtain a file_token; (iii) letting the next `sync-session-table.sh` run pull the file_token back. Alternatively, if no avatar is desired, set the row to `''`. |

**Rationale.** `sync-session-table.sh:128-184` already treats file_token as canonical. The other formats are violations from manual SQL or older code paths. Aligning everyone on file_token requires the smallest behavioural change.

### 2. `sessions.alias` — settled v1.0

| Dimension | Contract |
|---|---|
| **Format** | Short Chinese (preferred) or English nickname, ≤ 8 visible characters. `NOT NULL DEFAULT ''`; empty string means "no alias set". |
| **Writer** | (a) Owner of the session at `/new` time, supplied via `--chat-name` flag → captured into `chat_name`, NOT alias (see below); (b) `sync-session-table.sh` (pulls from Bitable column 「别称」); (c) `bitable-init-sync.sh` at init step 8 (pushes alias into Bitable on first creation). |
| **When sync** | Bidirectional: Bitable 「别称」 ↔ `sessions.alias`. Bitable wins on conflict (consistent with avatar). |
| **Authoritative source** | Feishu Bitable column 「别称」. |
| **Validation** | Optional. Empty allowed for child sessions and ATP-test sessions. If set: ≤ 8 visible chars, no whitespace, no `/` `\` `|`. |
| **Uniqueness** | **NOT enforced as a hard constraint**. SQLite `idx_sessions_alias` exists but is not UNIQUE. However, FP patrol SHOULD flag duplicate non-empty aliases for human disambiguation. Rationale: enforcing uniqueness would block legitimate temporary collisions during rename windows. |
| **Relation to Feishu group name** | Feishu group name format is `{alias}-{name}-{backend}` when alias is non-empty, else `{name}-{backend}`. Maintained by `sync-session-table.sh` group-rename step. The string used for `{alias}` here comes from `sessions.alias` column, NOT from `chat_name` (which is the original at-creation input only). |
| **Migration** | child_xxx rows with empty alias are conformant and stay empty. ATP test sessions (`atp-*`) with empty alias are conformant. |

### 3. `sessions.category` — settled v1.1

| Dimension | Contract |
|---|---|
| **Format** | One of the closed enum: `业务` / `平台` / `工具` / `知识` / `外部`. `NOT NULL DEFAULT ''`; empty string is the "not categorised" state, allowed only for child sessions and pre-categorisation transient state. |
| **Writer** | (a) Owner at `/new` time via the init flow's category prompt → `bitable-init-sync.sh` writes both Bitable 「分类」 and `sessions.category`; (b) `sync-session-table.sh` (pulls from Bitable 「分类」). |
| **When sync** | Bidirectional: Bitable 「分类」 ↔ `sessions.category`. Bitable wins on conflict. |
| **Authoritative source** | Feishu Bitable column 「分类」. |
| **Validation** | Value MUST be in `{'', '业务', '平台', '工具', '知识', '外部'}`. Any other value MUST be rejected at write time with a logged error. |
| **Enum extension policy** | Extending the enum requires a contract revision (this file), matching category templates, init validation, Bitable select options, and a runtime handoff when the category carries execution/security semantics. Reserved for future consideration: `框架` (for framework-level sessions like supermatrix-root, scheduler), but NOT added in v1.1 because current platform convention still covers framework roles. |
| **Relation to category templates** | `templates/claude-md-{category}.md` and `templates/agents-md-{category}.md` MUST cover exactly the five enum values. Adding a category here without adding templates breaks SOP `category-template-distribution.md`. |
| **Relation to session catalog** | `category` is a field in each session's `session-catalog.json` entry. The catalog is a flat list sorted by `name`; `category` is filterable (`jq '.sessions[] | select(.category=="平台")'`) but does not drive ordering or grouping. |
| **Migration** | child_xxx rows with empty category are conformant. Non-child sessions with empty category MUST be filled via FP patrol or owner self-edit. `xjbc` is the initial `外部` migration target per user instruction on 2026-05-11. |

#### `外部` category security contract

`外部` is for sessions bound to external groups or any group whose members should be treated as outside the company trust boundary.

Runtime and template implementations MUST enforce these rules:

1. **Default-deny internal information.** For inbound messages whose sender open_id is not the configured owner open_id (`SM_ROOT_USER_ID`; production owner: `LARK_OWNER_OPEN_ID`), the session MUST NOT disclose company business status, company personnel information, accounts, passwords, secrets, tokens, SuperMatrix code architecture, internal workflows, session lists, workspace paths, database contents, or Feishu document contents.
2. **Owner exception.** If and only if the inbound sender open_id equals the configured owner open_id, the session may answer internal questions the owner explicitly asks, while still avoiding unsolicited extra disclosure in an external group.
3. **Answer-only surface.** External sessions answer questions. They MUST NOT operate SuperMatrix functions, call `/api/spawn`, use `lark-cli`, mutate Feishu, write files, land code, inspect other workspaces, or trigger downstream sessions.
4. **Slash-command and attachment caution.** Runtime SHOULD reject slash-command operations from non-owner senders in `外部` sessions and SHOULD avoid fetching or exposing attachment/local-file content unless the sender is the owner.
5. **Mention gate.** Runtime MUST ignore external-group messages that do not explicitly @ mention the bot. This applies to owner and non-owner senders; `外部` sessions are opt-in responders, not ambient group listeners.
6. **Refusal shape.** If a non-owner asks for restricted information or an operation, reply briefly that the request requires the owner identity or an internal session. Do not explain internal policy details beyond the minimum needed.

### 4. `sessions.chat_name` — DEPRECATED in v1.0, decision deferred to v1.1

| Dimension | Contract |
|---|---|
| **Status** | **Deprecated for new use**. Effective 2026-05-02, no new writers; existing one row (future-teller='预言家') is grandfathered. |
| **Historical meaning** | Per `sessionLifecycle.ts:48,125-128,148`, `chat_name` was the **at-creation input** used as the prefix for the Feishu group name `{chat_name}-{name}-{backend}`. It was stored verbatim into `sessions.chat_name` but never read again after creation. In v1.0 the role of "group-name prefix" is taken over by `sessions.alias`. |
| **Why deprecated** | Two columns serving overlapping purposes (`alias` and `chat_name`) is a contract smell. `alias` is the live, sync-able value that already drives group rename; `chat_name` is a frozen creation-time copy with no consumer. Keeping both forces every reader to disambiguate, with no payoff. |
| **Open questions for v1.1** | (a) Drop the column entirely (requires migration); (b) Repurpose as "display name override" (separate from alias); (c) Repurpose as "chat title cache for sessions whose chat_id has been re-bound". FP recommends (a) but defers to root for migration cost analysis. |
| **Until v1.1** | Readers MUST treat `chat_name` as advisory only. No new code may write to it. Existing reads in `sessionLifecycle.ts` may stay since they only fire at session creation and are harmless. |

### 5. `sessions.heartbeat_enabled` — settled v1.2

| Dimension | Contract |
|---|---|
| **Format** | Integer `0` or `1`. `NOT NULL DEFAULT 0`. `1` = heartbeat platform session may include this session in its hourly patrol; `0` = excluded. |
| **Writer** | Two and only two writers: (a) `scripts/sync-session-table.sh` (pulls from Bitable column 「Heartbeat」 and writes the int); (b) future init-flow / migration code that wants to set an initial value on row creation. **No runtime code under heartbeat/ may UPDATE this column** — heartbeat is a read-only consumer (see `workspaces/heartbeat/docs/heartbeat-function-overview.md`). Owners change the value by toggling the Bitable checkbox, not by SQL. |
| **When sync** | Pull-only from Bitable: every run of `sync-session-table.sh`. Push direction (DB → Bitable) is forbidden — Bitable is the source of truth. Pull rule matches §1/§2/§3: Bitable non-empty overwrites local; **Bitable cleared back to off (False) DOES propagate** because checkboxes have no "absent" state and `False` is the explicit off value — this is the documented divergence from `purpose / 别称 / 头像 / 分类`, where "online empty" is treated as anomaly. The intended UX is: untick the checkbox to disable heartbeat for that session. |
| **Authoritative source** | Feishu Bitable table `<FP_SESSION_TABLE_ID>` column 「Heartbeat」 (field id `<FP_HEARTBEAT_FIELD_ID>`). |
| **Validation** | On read from DB: value MUST be `0` or `1`. On pull from Bitable: cast `True → 1`, `False → 0`, missing → leave local unchanged (defensive, in case the column is removed accidentally). |
| **Default for new sessions** | SQLite `DEFAULT 0` (opt-in). At `/new` time the Bitable row is created without the Heartbeat field set, which renders as unchecked. Owner must tick the box (or SuperMatrix init may set it via push at row creation in the future, contract-permitting). Rationale: heartbeat's `user_resume` action posts as the human owner, so enabling it should be an explicit decision per session. |
| **Hard exclusions (enforced in heartbeat code, not via this column)** | child sessions (`scope='child'`), heartbeat itself (`name='heartbeat'`), and `status='deleted'` rows are skipped by `heartbeat_patrol/sm_reader.list_enabled_sessions()` regardless of this flag. The flag only governs the `scope='user'`, non-deleted set. |
| **Relation to `FP管辖` (Bitable column)** | Independent toggles. `FP管辖` decides whether FP includes the session in its patrols and template conformance checks; `Heartbeat` decides whether the heartbeat session may include it. A session can be in FP's scope but opt out of heartbeat, or vice versa. |
| **Migration** | Initial backfill on 2026-05-14 wrote Bitable Heartbeat = current `sessions.heartbeat_enabled` for every existing row (65 ticked, 3 unticked: drawing / codexfp / heartbeat). No further migration needed. |

**Rationale.** Heartbeat is a platform-level patrol session that may post user-identity nudges (`user_resume`) to a target session's group. Owners of each session need a visible, one-click switch to opt in / out without touching SQL. The Bitable column gives them that surface; the SQLite column is the runtime read-path that heartbeat itself queries. Pull-only sync keeps the human-readable Bitable as source of truth and avoids race conditions with manual edits.

## Cross-field invariants

1. **alias vs chat_name disambiguation.** When generating Feishu group names, the prefix MUST come from `sessions.alias`, never from `sessions.chat_name`. (`chat_name` is frozen at creation; alias can be edited and is the live value.)

2. **Avatar / alias / category sync direction.** All three flow Bitable → DB on conflict. DB → Bitable only happens at init via `bitable-init-sync.sh` for first-time row creation. Owners change values by editing the Bitable cell, not by SQL.

3. **child sessions exemption.** Sessions with `scope='child'` (most `child_*` rows) are exempt from alias / category / avatar / heartbeat_enabled requirements; all four default to empty / 0 and stay that way. They are not pushed to Bitable.

4. **Per-session toggles use checkboxes with bidirectional False propagation.** `FP管辖` and `Heartbeat` are both Bitable checkbox columns mirrored to int columns in SQLite. Unlike text/select fields where Bitable-empty is treated as anomaly and local kept, checkbox columns explicitly propagate `False` to local — because there is no other way to express "off" through a checkbox UI.

## Non-conforming row inventory (snapshot 2026-05-02)

Detected during contract drafting; root will receive these as part of the implementation handoff.

| Session | Field | Current value | Issue | Status |
|---|---|---|---|---|
| todomaster | avatar | `https://i.pinimg.com/...` (URL) | Format violation | Pending |
| fuwuqi | avatar | `https://img1.baidu.com/...` (URL) | Format violation | Pending |
| deepautosearch | avatar | `data:image/jpeg;base64,...` (data URL, 10579 chars) | Format violation | Pending |
| final-answer | avatar | `<LOCAL_PATH>/oc_1bdb4ffd.../...` (filesystem path, 198 chars) | Format violation | Auto-excluded (status='deleted'; `findNonConformingAvatars` skips) |
| (many) | category | `''` for non-child sessions like `amn-automatedmessagenotifications`, `chenli`, `carddemo` | Missing required value | Pending separate sweep |
| future-teller | chat_name | `预言家` | Grandfathered, no action | Permanent grandfather |

FP will run the migration playbook (per §1 Migration) for the three remaining active avatar violations.

## Implementation handoff (for supermatrix-root via watchdog)

Once this contract is accepted, root SHOULD implement:

1. **Validation at write time.** In `adapters/store-sqlite/index.ts` `createSessionWithBinding` and any UPDATE path that touches the four columns: validate format per §1-3, throw `UserError` on violation. (chat_name: write only allowed via creation path, no UPDATE writers.)

2. **Reject non-file_token avatar at the migration boundary.** Add a one-shot maintenance function (or a SQL CHECK constraint via new migration) that flags non-conforming avatar rows for FP review. Do NOT auto-rewrite — FP runs the migration manually per §1.

3. **Drop `chat_name` writers in lifecycle.** Replace `chatName: input.chatName?.trim() || null` (`sessionLifecycle.ts:148`) with: stop persisting; pass through only as the in-memory `chatNamePrefix` for group naming. (This change is OK to land in v1.0 because no consumer reads it back.) Alternatively, leave the column populated until v1.1's deprecation decision lands. Root chooses.

4. **No data UPDATE.** Root MUST NOT bulk-rewrite existing row data; the inventory in §"Non-conforming row inventory" is FP's to resolve.

## Settled vs deferred (回执 summary)

| Field | v1.0 status |
|---|---|
| `avatar` | ✅ Settled — file_token canonical, 4 violations to migrate |
| `alias` | ✅ Settled — Bitable wins, uniqueness soft-flagged |
| `category` | ✅ Settled — closed 5-enum, `外部` carries strict answer-only security semantics |
| `chat_name` | ⚠ Deprecated, decision deferred to v1.1 (drop / repurpose) |
| `heartbeat_enabled` | ✅ Settled v1.2 — Bitable 「Heartbeat」 checkbox is canonical, pull-only with False propagation, default off, opt-in per session |

Three of four fields are fully settled; one (chat_name) is frozen with a clear deprecation marker. No staged delivery needed for v1.0.

## Revision history

| Rev | Date | Change |
|---|---|---|
| v1.0 | 2026-05-02 | Initial contract; triggered by watchdog issue 4ee73ee3 (todomaster avatar sync failure root cause). |
| v1.0.1 | 2026-05-02 | Inventory: marked final-answer auto-excluded by `findNonConformingAvatars` (deleted-row filter). Implementation accepted by supermatrix-root at SM commits 6de7448 + ddbd902 (watchdog issue 9496c92b); contract conformance verified. |
| v1.1 | 2026-05-11 | Added `外部` category for external-group sessions. The first migration target is `xjbc`; non-owner senders are restricted to answer-only public/general Q&A with no internal disclosure or SuperMatrix operations. |
| v1.1.1 | 2026-05-12 | Added mention gate: `外部` sessions ignore group messages unless the bot is explicitly @ mentioned. |
| v1.2 | 2026-05-14 | Added field #5 `sessions.heartbeat_enabled` with the Bitable 「Heartbeat」 checkbox (field id `<FP_HEARTBEAT_FIELD_ID>`) as authoritative source. Pull-only Bitable → DB, including explicit False propagation. Initial backfill aligned 68 existing Bitable rows to current SQLite state. New cross-field invariant #4 documents checkbox-column False propagation as the documented exception to §1-3 "online empty kept local" rule. |
