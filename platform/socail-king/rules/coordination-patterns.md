# 业务协作模式（field-observed）

这里记的是**实地观察出来的真相**——从 jsonl 里 verdict=准 的判断中提炼出来的具体业务级协作模式。

跟 `rules/gray-zones.md` 的区别：gray-zones 是"职责重叠的预测"，这里是"已经反复观察到的实际行为"。

每条结构：

- **模式**：一句话描述
- **观察来源**：judgment_id 列表
- **典型表现**：一个具体场景
- **为什么这样**：双方访谈给的根因
- **建议改动**：发起方该怎么写 / 接收方该怎么读

---

## #1 需求侧 / 检测侧错位

- **观察来源**：`judg-2026-05-05-001`（user verdict: 准）
- **模式**：当 A 跟 B 说"我没看见你的 X"，B 的默认反应是"让 A 改自己的判定逻辑"，而不是"我去 emit X"。
- **典型表现**：scheduler 检测 fp-daily-sync-review 跑完没回 `REPORT:` token，连发两轮 receipt_missing 告警。fp 两次都回的是"你把检测放宽点"或"PATCH 一下 receiptProof"——但 fp 自己 patrol 端从来没 emit 任何 receipt，反而越权改 scheduler 的检测规则。两轮 4 条往返 + 一次 ~2h 白跑，根因没动。
- **为什么这样**：跨执行器任务（http executor + delegation class）的 receipt 契约没明文化——B 不知道"我应该 emit 一个 token 给 A 看"是它的职责；A 又用"我没看见 X"这种描述告警，听起来像在抱怨自己的判定，B 自然会去帮"修判定"。
- **建议改动**：
  - **A（发起方 / verifier）**：告警 prompt 首句明示需求方向——"我需要你在 finalMessage 末尾 emit `REPORT:` 行"，而不是"我没看见你的 receipt"。
  - **B（接收方 / emitter）**：听到"我没看见你的 X"时，默认动作是"我去 emit X"，不是改对方的判定逻辑。
  - **结构层**：跨执行器任务应该在 task 创建时就把 emitter 端的 receipt 契约写在 description 里，让 owner 一开始就知道。

---

## 框架契约：spawn 想要"无回复"，请显式声明 `sink = audit_only`

> （这条是工程约定，不是 field-observed 模式；放在这里方便发起方写 spawn 时随手翻到。）

- **背景**：框架的"执行段"默认要求 child 产出非空。如果调用方真不需要 B 回内容（派出去做副作用、只看日志），需要**显式声明 sink = `audit_only`** —— 意思是"无送达目的地，只在日志留底"。
- **判定规则**（2026-05-21 起，见 `threePhaseCheck.ts:90`）：
  - 有效 sink 全是 `audit_only` → B 空回**合法**。
  - 任何一个 sink 是 `chat_post` / `parent_continuation_inject` / `pollable_endpoint` / `eventbus_publish` / `http_response` → B 空回判 `empty_output` **失败**（升级 SK）。
- **最常见的错配**：用 `caller_invocation = fire_and_forget`（"调用方等不等同步结果"）代替 sink 声明 —— **这两个是独立的轴**。fire_and_forget 设了之后**不再隐含**"B 可以空回"，两件事必须分开声明。
- **典型场景**：派一条"做完就退、不需要任何回执"的清理 / 副作用任务 → `resultSinks: [{ kind: 'audit_only' }]`。
- **如果不显式声明**：B 真空回 → 直接 `empty_output` 失败 → watcher 兜底 → 升级 SK。不要靠 prompt 里写"无须回复"这种文本约定 —— 框架不识别 prompt 文本，只看 sink 字段。
