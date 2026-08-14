---
id: kd7m2q
name: weekly-cli-upgrade-kimi-patch
description: 当 watchdog 通过任何 kimi-code 安装入口完成升级时，恢复并验证本机 SM-PATCH；不处理 Kimi 上游补丁实现本身。
status: active
owner: watchdog
created: 2026-07-22
updated: 2026-08-06
---
# SOP: Weekly CLI Upgrade Kimi SM-PATCH Recovery

## 核心目标

每次 kimi-code 覆盖 `~/.kimi-code/bin/kimi` 后，先恢复自治 turn ACP 可见性补丁，再允许升级链路继续审计或 review。

## When to Use

当 `src/scripts/weekly-upgrade.ts` 的 Kimi Code installer 成功返回后使用。**不适用**：修改 `/Users/LOCAL_USER/SuperMatrix/scripts/kimi-sea-autonomous-turn-patch.py`、Kimi ACP 业务行为、scheduler cron 生命周期或手工二进制修补；这些交给 `codexroot`（T800）。**hold 例外**：`data/kimi-upgrade-hold.json` 存在时（上游 SM-PATCH 修复期间，如 2026-08-06 的 SEA 空闲区差 1111 bytes），do-entry 跳过 Kimi installer，本 SOP 不触发；result 标 `held`，不算失败也不阻断 review。hold 文件在对应跟踪 issue 关闭（codexroot 修复经验证）后删除。

## Prerequisites

- `/Users/LOCAL_USER/SuperMatrix/scripts/kimi-sea-autonomous-turn-patch.py`、`~/.kimi-code/bin/kimi`、`python3`、`strings` 可执行；运行态由 `data/cli-upgrade.log`、`data/scheduler_receipts/weekly-cli-upgrade.receipt` 和 audit JSONL 留证。

### Step 1: 在唯一升级入口恢复补丁

- **输入**：已成功结束的 `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` installer run。
- **处理**：`weekly-upgrade.ts` 必须紧接 installer 调用 `runKimiAutonomousTurnPatch()`；该 helper 固定执行 `python3 /Users/LOCAL_USER/SuperMatrix/scripts/kimi-sea-autonomous-turn-patch.py`，不传 binary override。脚本自行幂等、首次备份、`node --check`、ad-hoc 重签和 `--version` 验证；watchdog 不复制、改写或手工替换其逻辑。
- **产物**：`kimiPatch:{status:"pass"|"fail",markerCount:<int>}`；所有未来 kimi-code installer 路径必须复用同一 helper。
- **失败回滚**：installer 自身失败时不运行补丁，按普通 kimi-code upgrade fail 留证；不要将 installer 失败伪装为 patch success。

### Step 2: 验证已安装二进制标记

- **输入**：Step 1 的 script exit 成功。
- **处理**：执行 `strings ~/.kimi-code/bin/kimi | grep -c "SM-PATCH"`，仅计数 `>= 1` 通过；helper 同步把该 count 写入 `kimiPatch.markerCount`。
- **产物**：成功样本 `{"date":"2026-07-22","kimiPatch":{"status":"pass","markerCount":1}}` 出现在 audit、`data/cli-upgrade.log` 和 weekly receipt。
- **失败回滚**：count 为 `0` 或 `strings` 命令失败时把 kimi-code result 标为 error，禁止启动 root compatibility review。

### Step 3: fail-closed 上报 T800

- **输入**：Step 1 脚本失败（锚点漂移/空闲区不足/签名或 version 验证失败）或 Step 2 count `< 1`。
- **处理**：写 `kimiPatch` 与错误到 weekly audit/receipt；以 idempotency key `<YYYY-MM-DD>:watchdog:kimi-sm-patch:codexroot` 调用 spawn2.0，固定 `from:"watchdog"`、`target:"codexroot"`、`closure:{kind:"message",target:{type:"todo_pool"}}`，提示包含脚本路径、二进制路径、markerCount 和原始失败摘要。
- **产物**：成功交接样本 `{"kimiPatchHandoff":{"status":"accepted"}}`；同日重跑的 409 duplicate 记为 `already-registered`，不是第二次派单。
- **失败回滚**：handoff 非 2xx/非 duplicate 时把 handoff error 追加到 kimi-code result，并由既有升级 Console error notification 报出；禁止静默继续、禁止自己修脚本、禁止 hand-edit `kimi` 二进制。

### Step 4: 审计与后续边界

- **输入**：Step 2 pass 或 Step 3 的 fail-closed evidence。
- **处理**：只有 `kimiPatch.status:"pass"` 才继续模型 surface audit 与正常 root review 判定。patch fail 触发快照回滚：回滚验证通过（版本恢复 + rerun SM-PATCH marker `>= 1` + recovery compatibility check ok）时 result 标 `recovered:true`——Kimi 本身仍记失败并 handoff T800，但**不再阻断其它已变更 CLI 的 root review**（2026-08-06 用户批准的 invariant 修改），review 材料附失败与回滚证据；回滚失败或未验证时维持 fail-closed 阻断全部 review。codexroot 的 accepted transport receipt 只证明交接，不能证明补丁已修复。
- **产物**：weekly receipt 中保留 patch 状态、marker count 和（若失败）handoff 状态。
- **失败回滚**：等待 T800 交付新的已验证补丁脚本或明确的人工处置；下次 installer run 才可用相同机制再次验证。

## 异常枚举

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| E1 installer 未完成 | installer command 非 0 | `UpgradeResult.error` 含 installer failure | 不运行 patch；记录 kimi-code upgrade failure | watchdog Console | 当次 run 结束前 |
| E2 patch drift | patch script 非 0（含 anchor count、SEA slack、签名或 version failure） | `kimiPatch.status="fail"` | audit/receipt + spawn `codexroot`；不要修改补丁脚本 | codexroot（T800）和 watchdog Console | 当次 run 结束前 |
| E3 marker 缺失 | `strings ~/.kimi-code/bin/kimi | grep -c "SM-PATCH"` 为 0 或 strings 非 0 | `markerCount < 1` 或 helper error | 与 E2 相同的 fail-closed T800 handoff | codexroot（T800）和 watchdog Console | 当次 run 结束前 |
| E4 handoff 未送达 | spawn2.0 非 2xx 且不是 duplicate 409 | `kimiPatchHandoff.status="failed"` | 把 transport error 追加结果并保留 Console error；不改脚本、不重建第二套路由 | watchdog Console | 当次 run 结束前 |

## 禁用项 (Do NOT during execution)

- 不要修改补丁脚本或手改 `~/.kimi-code/bin/kimi`。**Why**：锚点漂移和空闲区不足需要 T800 重审上游 SEA 布局。**How to apply**：只运行固定 helper，失败只 handoff。
- 不要把 script exit 0 当作成功而跳过 marker count。**Why**：成功替换后标记缺失仍会失去自治 turn ACP 可见性。**How to apply**：只接受 count `>= 1`。
- 不要把 codexroot spawn accepted/duplicate 当成补丁修复完成。**Why**：它只证明报告已登记。**How to apply**：保持 kimi-code result failed，待下次升级流程重新验证。

## Inputs & Outputs 契约

- **Input 样本**：`{"run_date":"2026-07-22","installer":"kimi-code","installer_exit":0,"binary":"/Users/LOCAL_USER/.kimi-code/bin/kimi"}`。
- **Output 样本**：`{"date":"2026-07-22","kimiPatch":{"status":"pass","markerCount":1},"results":[{"cli":"kimi-code","error":null}]}`。
- **幂等键**：`<YYYY-MM-DD>:watchdog:kimi-sm-patch:codexroot`；仅用于同日失败 handoff，重跑遵从 spawn2.0 duplicate receipt。
- **Receipt / 验证 token**：`kimiPatch.status:"pass"` 且 `markerCount >= 1`；不是 installer exit 0、root review child ref 或 T800 transport receipt。

## Companion Files

- `src/scripts/_weekly-upgrade-kimi-patch.ts`：唯一恢复、marker 验证和 failure handoff payload builder。
- `src/scripts/weekly-upgrade.ts`：唯一现存 kimi-code installer path、审计、receipt、Console 与 T800 handoff 调用者。
- `docs/weekly-cli-upgrade-checklist.md`：root review 的同一硬门摘要。
- `/Users/LOCAL_USER/SuperMatrix/docs/kimi-acp-autonomous-turn-patch.md`：补丁设计、探针依据和回滚背景。

## Verification

- `npx vitest run tests/scripts/weekly-upgrade-kimi-patch.test.ts tests/scripts/weekly-upgrade-shared.test.ts`
- `npm run build`
- `strings ~/.kimi-code/bin/kimi | grep -c "SM-PATCH"`（期望输出整数且 `>= 1`）
- `test "$(awk '/^### Step 1:/{print NR; exit}' sop/SOP-weekly-cli-upgrade-kimi-patch-active-20260806-kd7m2q.md)" -le 25`

## 提交前自检

- [x] Step 1 在第 25 行内，包含唯一入口、固定脚本和不可变边界。
- [x] 异常表覆盖 installer、patch drift、marker 缺失和 handoff 失败四类机械分支。
- [x] 输入/输出样本、幂等键和 receipt truth source 已锁定。
- [x] 文件名、frontmatter 和 `sop/INDEX.md` 使用同一稳定 ID `kd7m2q`。
