# card-callback — 飞书卡片回调实时回灌

Feishu 卡片按钮点击 → agent run 内嵌暂停/恢复。两个进程：

- **broker**（`src/broker.js`）— 长驻守护进程，HTTP-only：发卡 / patch 卡 / 持有待确认问题 + 超时。**自己不持有 WSClient**——共享 app 上唯一的 WS 长连接由框架 lark gateway 持有，它把 ask_user 点击转发到 broker 的 `POST /click`（见 §4「单 WS 入口」）。
- **ask_user MCP server**（`src/mcpAskServer.js`）— 每次 agent run 以 stdio JSON-RPC 方式挂入；run 调用 `ask_user` 工具时 POST 到 broker `/ask` 并阻塞，直到用户点击或 5 分钟超时，然后在同一次 tool_result 里返回选项，run 继续执行。

---

## 1. 启动 broker（真实飞书凭证）

```bash
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx \
LARK_APP_SECRET=<你的 appSecret> \
node src/broker.js
```

说明：

- `LARK_APP_ID` / `LARK_APP_SECRET` 是飞书开放平台该应用的凭证，与 `lark-cli` 自身 keychain 中的凭证**相互独立**——broker 直接用 `@larksuiteoapi/node-sdk` 初始化，不读 `lark-cli` 配置文件。
- `CHAT_ID`（向哪个群发卡片）**不是** broker 的 env，而是由调用方（MCP server 的 env）按每次 run 传入。
- 默认端口 `8787`，可用 `BROKER_PORT=<port>` 覆盖。
- 默认超时 5 分钟（300000 ms），可用 `ASK_TIMEOUT_MS=<ms>` 覆盖。

broker 启动后会打印：

```
[broker] listening on 127.0.0.1:8787 fake=false timeoutMs=300000
```

---

## 2. FAKE 模式自测（无真实飞书）

```bash
LARK_FAKE=1 BROKER_PORT=8788 node src/broker.js
```

然后验证健康：

```bash
curl localhost:8788/health
# 返回: ok
```

投递端点 `POST /click`：

| 端点 | 用途 | 可用性 |
|---|---|---|
| `POST /click` `{ "token": "...", "value": "..." }` | 投递一次点击（真实模式由框架 gateway 转发；测试里直接 POST 模拟） | **真实 + FAKE 都有** |
| `GET /_pending` | 返回当前所有等待中的 token 列表 | 仅 `LARK_FAKE=1`（真实模式 404） |

---

## 3. 超时行为

`ASK_TIMEOUT_MS`（默认 300000 = 5 分钟）控制 broker 等待用户点击的窗口：

- **用户点击**：broker 立即 deliver，MCP server 把 `"用户选择了：X"` 作为 tool_result 返回，run 继续。
- **超时未点击**：broker 用 `default` 值（调用 `ask_user` 时传入的 `default` 字段，或第一个 option 的 value）resolve，卡片被 patch 为「超时未选择，已走默认」，run 继续。

agent run 端 MCP server 的 HTTP client timeout 是 310s（比 broker 的 300s 多 10s），确保 broker 的超时总是先到。

---

## 4. 单 WS 入口：框架 gateway 转发点击

共享 app（`cli_...`）上**只能有一个** WS 长连接。生产形态里这个长连接归框架 lark gateway，broker 不再自起 WSClient。点击路径：

```
用户点卡片按钮 → 飞书 card.action.trigger → 框架 lark gateway（唯一 WS）
  → gateway 看 action.value：__ask_user===true 且含 token 字符串
                                  → POST {token,value} 到 broker /click（默认 127.0.0.1:${BROKER_PORT:-8787}）
                                  否则 → 当普通 CARD_ACTION 走 dispatcher
```

飞书开放平台该应用仍需开启 **长连接事件** + **卡片回调** 能力（gateway 用）。首次真实点击返回 `error 200671` = 权限/ACK 路径未打通，去检查「应用能力 → 机器人 → 卡片交互 → 回调配置」。

---

## 5. ask_user 点击的识别契约

按钮 value 形状 `{ __ask_user: true, token, value }`（`token` = 24-hex 待确认 id，由 broker 生成）。**判别字段是 `__ask_user === true`，不是 token 本身**——框架 gateway 据此把 ask_user 点击和普通 CARD_ACTION 区分开。

canonical 解析见 `src/cardAction.js` 的 `extractClick()`（有单测锁形状）——node-sdk `CardActionHandler` 把事件 `parse()` 摊平到顶层后，payload 落在 `data.action.value`（**不是** `data.event.action.value`）：

```js
const click = extractClick(data); // { token, value } 或 null（非本系统的点击）
// data.action.value === { __ask_user: true, token, value }
```

broker 自身不再调用 `extractClick`；它是**框架 gateway 要镜像的契约**。WS 入口对全 app 的 card click 都做这次判别，所以判别必须是 `__ask_user` 这个专用 marker，而非裸 `token` 字段——否则任何普通 CARD_ACTION 只要碰巧带 `token` 字段就会被误吞、永远到不了 dispatcher。框架侧 `extractCardAskClick` 须同样要求 `value.__ask_user === true`。

---

## 6. agent run 如何使用

**架构要点**：broker 作为守护进程启动一次（可用 `pm2` 或 systemd），每次 agent run 则把 `ask_user` MCP server 挂进 run 的 MCP 配置（详见同级文档 [`HANDOFF-adapter.md`](../HANDOFF-adapter.md)）。

### ask_user 工具输入格式

```json
{
  "question": "本次补货方案是否确认？",
  "options": [
    { "label": "确认执行", "value": "confirm" },
    { "label": "跳过本轮", "value": "skip" },
    { "label": "取消并人工处理", "value": "cancel" }
  ],
  "default": "skip"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `question` | `string` | 是 | 展示在卡片上的问题文字 |
| `options` | `array<{label, value}>` | 是 | 按钮列表；`value` 省略时等于 `label` |
| `default` | `string` | 否 | 超时走的 value；省略时取第一个 option 的 value |

调用后 run **暂停**直到用户点击或超时，然后在 tool_result 里收到选择结果，run 继续执行。

---

## 7. 快速参考

```
card-callback/
  src/
    broker.js          # 长驻 HTTP-only 守护进程（/ask /click /health）
    mcpAskServer.js    # stdio JSON-RPC MCP server（每次 run 独立启动）
    askBroker.js       # send/await/patch 核心逻辑
    pendingStore.js    # 待确认问题存储 + 超时 resolution
    cards.js           # 卡片 JSON 构造（ask/answered/timedout）
  test/
    unit.test.js
    e2e.test.js
```

spec: `docs/superpowers/specs/2026-06-01-card-callback-ack-design.md`（§4.3 adapter 表 + §4.5 锁定决策）
plan: `docs/superpowers/plans/2026-06-01-card-callback.md`
