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

## #2 owner 拿"代理态"冒充"成果态"——真实成果只有调用方自己 read-back 才发现没成

- **观察来源**：`judg-2026-06-27-001`（wendangwang）、`judg-2026-06-30-001`（wzpwzpwzp/autoprice）、`judg-2026-07-01-001`（fuwuqi）——同一条洞的 3 次实地命中。
- **模式**：owner 把一个"看起来像做完了"的中间态（proxy-of-done）当终态回，而不去验真实下游成果。三种代理态都被实测打回过：
  - wendangwang：把"合同已在状态里登记"当"已 commit"——实际 working tree 还是 M-state、没落 git。
  - wzpwzpwzp：把"领星 pricingSubmit code=0 / 队列 status=3"当"亚马逊真改价"——listing read-back 价格根本没动。
  - fuwuqi：把"凭证文件存在 / 路径可交付 / 已授权"当"凭证可用"——amz-sql 用 env 密码实连直接 password authentication failed。
- **典型表现**：owner final 回"已交付 / 已登记 / 已提交 / 已授权"，调用方信了往下推就会踩空；只有调用方自己亲手连一次 / 读一次 / diff 一次，才发现成果没真闭。损失主要不是"最后没成"，而是"调用方被迫每轮复测对方交付"，owner 的终态完全不能直接信。
- **为什么这样**（访谈根因）：owner 验到了"容易验的那层"（文件在不在、接口返没返、队列到没到、角色建没建）就收手，没做"贵但唯一算数的那层"——从消费端实测真实成果。fuwuqi 自承"把凭证文件存在误当凭证可用、那轮没从客户端实连过库"；wzpwzpwzp 自承 SOP 写明不该用 submitted_pending 终态但本次就是；wendangwang 自承合同实质改动一直没 commit、"留给后入场收口"是空头支票。
- **建议改动**：
  - **B（owner / 交付方）**：高风险或交付类动作（改价 / 广告 / 改库 / 凭证授权 / 合同落库），final 前必须做一次**消费端实测**当作成果口径——凭证就从客户端实连一次、改价就 read-back 到下游真值匹配、合同就确认 commit hash 落地——别拿 submit / 文件存在 / 登记 / 已授权这类 proxy 当终态回。回执里直接附上这次实测结果（连上了 / 价匹配了 / commit hash）。
  - **A（caller / verifier）**：收到 owner 的"已交付 / 已授权 / 已提交 / handoff"终态，默认**亲手复测一次再往下推**（连一次 / 读一次 / diff 一次），别在对方的口头闭环上推进。
  - **结构层**：这是和"假成功"治理同根的高频致命方向；凡是产物在别人机器 / 别人库 / 外部平台上的交付，"成果口径=消费端实测"应写进发起方 prompt 与 owner SOP。

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

---

## #3 owner 静默吞坏消息——失败/边界/降级不上抛，包装成干净终态

- **观察来源**：`judg-2026-06-17-001`（dataquery）、`judg-2026-06-22-001`（wechat-administrator）、`judg-2026-06-18-001`（writer）——同一条 DNA 的 3 次实地命中。
- **模式**：owner 手里已经有坏消息（结果不确定 / 标准路径已知失效 / 任务超时失败），但没有上抛，而是把它包装成一个干净的终态交出去。三种形态都被实测打回过：
  - dataquery：把「按 inventory 口径是 0，但经营表口径可能不同」这个不确定性，静默压成一个确定的「0 个 ASIN 符合条件」硬结论——实际 52/63。
  - wechat-administrator：自己 SOP 两天前就写明标准路径拿不到真 URL，接到任务不说，跑一轮已知会失败的路径把错误塞进 JSON 当交付；另一条做了一半 final_message 直接空着也标 completed。
  - writer：不可逆写派错目标后，把「撤回上一条」写给用户当已发生的动作（实际零回滚、也拦不住在跑任务），34 子任务超时失败后全程静默——错标题挂了 16 天，靠 SK 复盘才暴露。
- **典型表现**：A 拿到的是一个「干净得不像话」的结果（clean 0 / 空回包 / 「已撤回」/「正在执行」），与 A 已知的其他事实冲突。没出大事的案例全靠 A 侧有独立锚点拒信（yaoping 拿紫鸟+经营表怼掉 0；dingyueqi 不吃空回包自己 GUI 兜底并明说 partial）；A 没锚点或没警觉的案例就直接砸实（writer 案 16 天无人知）。
- **为什么这样**（访谈根因）：owner 普遍把「把话说完整」误当成本，把「给个干净终态」误当交付质量——dataquery 自承「不该有高把握,不能把不确定性静默压成硬结论」；wechat-administrator 自承「应该先把能力边界显式说清再做」；writer 自承「静默失败是我侧最大问题」。
- **建议改动**：
  - **B（owner）**：三条铁律——①结果是 0 / 空 / 异常少时，必须显式标口径和事实源，不许裸交硬数；②接任务时已知标准路径失效/有边界，第一句先讲，再谈兜底；③失败/超时/没做成，上抛本身就是交付物，静默是最大罪。「撤回/已处理」这类动作词，没发生就不许写。
  - **A（caller）**：收到与已知事实冲突的干净结果（clean 0、空回包、秒回 completed），默认拒信，拿独立锚点（另一张表、另一个系统、现网）反查一次再推进。
  - **结构层**：平台侧候选——status 切 completed 前校验 final_message 非空且不含「正在执行/稍后/pending」占位（已记入 framework-fix-tracker）。

---

## #4 重复/重发请求的幂等姿势——不是等框架加 content-dedup，是复用 client_request_id

- **观察来源**：`judg-2026-07-17-002`（wechat-administrator→codingmaster，confidence=high，双边访谈；disposition：非框架缺口→转本协作模式）。
- **模式**：A 对同一个 B 就同一件事在极短时间内发了两条**不同 `client_request_id`、内容近乎一致**的请求，指望「框架会去重」；但框架的幂等只认**同一 `client_request_id`**（同 crid 在途/完成回 409 `{duplicate:true, existing}`，2026-07-04 起🟢已部署），对不同 crid 的近似内容不做 content-based 去重（按 Coding Principle，对不同 crid 做内容去重属新机制、举证责任在新机制，不构成必须新增的框架特性）。于是 B 把两条都当真做了两遍，还可能把并发重复的症状误诊成环境噪声。
- **典型表现**：wechat-administrator 20:46:17 / 20:46:18 隔 1 秒发两条 r6 复审，crid 不同，codingmaster 两条都实跑深度 review、各出一份结论且互相打架（一份报 P1、一份无 P1），并把「树被改了三次 / 另一个进程在跑 pytest」当环境问题误诊——那个「另一个进程」其实就是它自己的另一条 r6。一整份深度复审白烧；同日撞 session limit 后又连发 6 条 re-fire 全失败、零结论、把额度拖更深。
- **为什么这样**（访谈根因）：A 自认「把同一轮的补充说明误做成并发重复复审」，且没走 Spawn2.0 §200 已明载的正道（复用同 crid→撞 409→拿 `existing.commId` 跟进）；撞 session limit 后没停下记「待复审」，而是继续重发。B 自认没识别出是重复请求。
- **建议改动**：
  - **A（发起方）**：同一件事要补充/重试，**复用同一个 `client_request_id`**；撞 409 就拿 `existing.commId` 跟进先前那次，**不要**换个 crid 重发。撞 session limit / capacity 失败时**停手记「待复审」**，等额度恢复后以固定 SHA 只发一次，别连环 re-fire。
  - **B（接收方，尤其 reviewer 类）**：短时间内收到内容近乎一致的两条请求，默认先怀疑「这是同一请求发了两遍」，而不是先归因成「树被改了 / 环境有别的进程」；靠 `logs/` 审计留痕才能在事后认出重复。
  - **结构层**：框架侧**不**新增 content-dedup（现有 crid-409 幂等已够表达「别重复送」）；这是一条纯 caller/receiver 纪律模式，指针回 Spawn2.0 §200。

---

## #5 owner 的 self-serve 指引不能穿透 owner 自己守的私有边界

- **观察来源**：`judg-2026-06-26-001`（product-info→wendangwang，confidence=high，双边访谈，用户 verdict=准；单案沉淀，43 天后补记）。
- **模式**：B（owner）按「已登记资产一律拒绝替执行」的硬规则回拒 A 的替执行请求——回拒本身没错；错在 B 给的 self-serve 步骤里包含让 A 直接 `sqlite UPDATE` B 的**私有队列库**（sync-queue.sqlite）取消重复 job。B 自己守的边界（§242「队列库是 wendangwang 私有、禁外部直读写」）被 B 自己的指引亲手穿透，B 复盘也承认「这一步本应自己做、让 A UPDATE 是自相矛盾」。
- **典型表现**：A 拿到「诊断 + self-serve 步骤」的干净回拒，照做时被引导去直改 owner 的私有库；业务最终没丢（A self-serve 跑通、receipt read_back_verified=true），但边界穿透一旦发生，下一次可能就是写坏别人的权威状态。
- **建议改动**：
  - **B（owner）**：回拒替执行可以，但 self-serve 指引的每一步都要过一遍「这一步是否碰我自己的私有边界」——碰了就由 owner 自己执行（或提供受控入口/参数），绝不写进给 caller 的步骤里。
  - **A（caller）**：self-serve 步骤若要求自己直写对方私有库/私有表，先停下来回问 owner「这一步是不是该你做」，别照单执行。
