# SPEC: spawn 结果投递 CAS 原子性修复（消除双投递）

日期：2026-07-30 ｜ 编排：socail-king（coding-mix，cursor-agent 单工具）｜ 目标仓：/Users/LOCAL_USER/SuperMatrix

## 背景（病灶，均已源码实证）

spawn2.0 结果有三条投递通道：通道1 sync-inline HTTP 响应、通道2 caller 主动 `POST /api/spawn_async_items/<ref>/take`、通道3 迟到结果经 `routeCompletedSpawnClosure` 推送 heartbeat todo。现状下三通道的去重存在三个原子性盲区，导致「caller 已实时拿到结果，待办池又推送一次」的双投递：

- **G1（主病灶）**：take 的消费记账 CAS 只认 `status IN ('pending','waiting_child')`（`closeSpawnAsyncItemConsumed`，src/adapters/store-sqlite/index.ts:2299-2312）。若 take 与推送路由并发，推送已把 item claim 成 `'delivering'`，take 的 CAS **静默失败**：结果照样经 HTTP 返回给 caller，但消费没记上账，推送路由继续 enqueue → 双投递。
- **G2**：sync-inline 响应写成功只落 `result_sink_attempts` 旁路日志（src/cli/apiServer.ts:2402-2414），从不迁移 `spawn_async_items` 状态机；推送闸口靠扫该日志（src/app/spawnClosure/fastPathRoute.ts:52,121-141），日志缺失时判不出、保守回投。
- **G3**：推送路由先 `enqueueHeartbeatTodo` 再 `markSpawnAsyncItemDelivered` finalize（fastPathRoute.ts:94-105），enqueue 期间（execFile 子进程，数十~数百 ms）被 take 偷家无感知，finalize 静默 0 行 → 双投递。

## 设计原则

- `spawn_async_items.status` 字段本身就是 delivery 状态机；**不加列、不加表、不做 schema 迁移**。
- 三通道在同一 `status` 字段上 CAS 竞争；take 必须能确定性偷赢进行中的推送。
- 对外契约（take 响应形状、todo_pool、switched_async、verdict 词汇）全部不变。
- 残余风险：enqueue 瞬间被偷家的 ms 级窗口（崩溃级概率），接受并留 warn 日志，不追求 exactly-once。

## 改动项（四层，逐层验收）

### L1 store 层（src/adapters/store-sqlite/index.ts + src/ports/BindingStore.ts）

1. **扩展 `closeSpawnAsyncItemConsumed`**：CAS 条件由 `status IN ('pending','waiting_child')` 扩为 `status IN ('pending','waiting_child','delivering')`。其余不变（返回 `changes > 0`）。BindingStore.ts 上该方法的 doc 注释同步更新：take 允许偷赢 in-flight 推送（claim 后、finalize 前）。
2. **新增 `closeSpawnAsyncItemSyncDelivered(commId: string, reason: string, now: Timestamp): Promise<number>`**：
   ```sql
   UPDATE spawn_async_items
   SET status='closed', verdict='delivered', verdict_reason=?, updated_at=?
   WHERE comm_id=? AND status IN ('pending','waiting_child','delivering')
   ```
   返回受影响行数（纯 sync 路径通常无 item，返回 0 是正常 no-op，不是错误）。verdict 用 `'delivered'`，与 fastPathRoute 现有词汇一致。
3. **`markSpawnAsyncItemDelivered` 返回值 `Promise<void>` → `Promise<boolean>`**（`changes > 0`），让调用方能感知 finalize 被偷家。BindingStore.ts 接口签名同步。

### L2 apiServer 接线（src/cli/apiServer.ts）

4. `writeVerifiedSyncInlineResponse` 成功分支（`responseWritten && !isSpawnChildQueuedResult`，约 apiServer.ts:2402-2422）：在 `recordResultSinkAttempt` 之后、`disconnectSwitch.dispose()` 之前，若 `result.spawnCommId` 非空，调用 `closeSpawnAsyncItemSyncDelivered(spawnCommId, "sync_inline response written; caller received the result over HTTP", Date.now() as Timestamp)`。与 sink 记录同样 try/catch 包裹只 warn——HTTP 响应已发出，绝不能因此抛错。`result_sink_attempts` 旁路日志保留照旧（诊断用途）。

### L3 fastPathRoute 接线（src/app/spawnClosure/fastPathRoute.ts）

5. **enqueue 前复检**：在 adjudication 检查之后、`enqueueHeartbeatTodo` 之前，重新 `getSpawnAsyncItem(ref)`；若 item 不存在或 `status !== 'delivering'` → 返回 `{ action: "noop", reason: "delivery claim lost before enqueue" }`，**不要** `releaseSpawnAsyncItemDelivery`（状态已被别人认领，release 会破坏新状态）。
6. **finalize 感知**：`markSpawnAsyncItemDelivered` 现返回 boolean；三处调用点若返回 false → `logger.warn`「delivery finalize lost; concurrent consumption may have occurred」。enqueue 已完成、不回滚。
7. `hasWrittenSyncInlineResponse` 日志扫描闸口**保留**（防御纵深 + 覆盖本修复上线前注册的存量 item）。

### L4 测试（与实现同层交付）

8. `tests/adapters/store-sqlite/crossSessionLog.test.ts:186` 现有用例「closeSpawnAsyncItemConsumed is a no-op on closed and delivering items」**显式授权修改**：closed 仍 no-op；`delivering` 改为 take 偷赢（返回 true，状态 closed/caller_consumed，随后 `claimSpawnAsyncItemForDelivery` 与 `markSpawnAsyncItemDelivered` 均失效）。
9. `tests/adapters/store-sqlite/` 新增 `closeSpawnAsyncItemSyncDelivered` 用例：pending / waiting_child / delivering 三种态都能关闭且 verdict='delivered'；closed / parked / re_driving 态不受影响；无匹配 comm 返回 0。
10. `tests/app/spawnClosure/fastPathRoute.test.ts` 新增：claim 成功后 enqueue 前 item 被外部关闭 → 不 enqueue、不 release、返回 noop；现有用例全绿。
11. `tests/cli/apiServer.test.ts` 新增/调整：sync-inline 成功后该 comm 的 open item 被关闭为 delivered；take 命中 delivering item 能完成消费记账。

## 验收口径（编排者自己复跑，不信 agent 自报）

- `npm run typecheck` 全绿
- `npx vitest run tests/adapters/store-sqlite` 全绿
- `npx vitest run tests/app/spawnClosure tests/cli/apiServer.test.ts` 全绿
- 上述新增用例真实存在且断言的是新语义（逐条读 diff 确认）

## 非目标（明确不做）

- 不改 `spawn_async_items` schema、不加 migration 文件
- 不改 prompt 交付规则文案、不改 closure/take/todo_pool 对外契约
- 不动 orphanSweep、不动裁决路径状态（parked / re_driving / escalated / adjudication 相关方法）
- 不追 exactly-once；ms 级残余窗口只留 warn 日志
- 不顺手重构相邻代码；commit 由编排者决定，agent 不做 git 操作
