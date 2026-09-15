from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


AuthorityModel = Literal[
    "feishu_only",
    "local_only",
    "local_authoritative",
    "feishu_authoritative",
    "field_split",
    "derived_mirror",
    "derived_projection",
]

AssetCategory = Literal[
    "platform_registry",
    "platform_sop",
    "platform_inventory",
    "platform_knowledge_doc",
    "platform_runtime_log",
    "business_knowledge_doc",
    "business_data_mirror",
    "business_execution_log",
    "business_parameter_table",
    "business_registry",
    "collaboration_doc",
    "personal_private",
]

SyncDirection = Literal[
    "none",
    "local_to_remote",
    "remote_to_local",
    "remote_to_local_to_remote",
    "two_way",
]


@dataclass
class FieldContract:
    name_zh: str  # 飞书 field.name，新建表 (pre_create=True) 必须中文
    type: str
    description_zh: str
    # feishu_on_edit_local_on_backend_switch：飞书人工编辑时为权威，切主 backend
    # 时本地按该 backend 默认值覆盖并回写；数据写入语义等同可写（仅 feishu/readonly
    # 被 upsert 权威闸拒绝），不得静默归并进 local/feishu/mixed。
    authority: Literal[
        "local", "feishu", "mixed", "derived", "readonly",
        "feishu_on_edit_local_on_backend_switch",
    ]
    required: bool = False
    allow_non_chinese_name: bool = False  # legacy 路径，新建表禁用
    non_chinese_reason: str = ""  # legacy 路径
    local_name: str = ""  # 本地代码/SQLite 列名，可英文；空表示 = name_zh；新建表必填，事故出处：ziniao summary_zh 字段绕过 wendangwang 直接在飞书 UI 加，无 receipt 留痕
    options: list[dict[str, Any]] = field(default_factory=list)
    # 可选的动态枚举来源。合同只显式 opt-in；建表 payload 与每日 reconcile 才会从
    # 表格王维护的 backend/model/effort catalog 投影，普通 select 字段仍完全按 options。
    option_source: dict[str, Any] | None = None
    # link 关联列专属：link_table = 关联目标表 table_id（tbl…）；新建 link 列 (pre_create) 必填，
    # 凭此在飞书随表预置关联并读回核对，绝不放宽「无目标表的 link」。存量 verify-existing 的 link
    # 列合同可留空（目标表在远端 schema）。bidirectional 默认单向；True 时飞书在对侧表自动建反向
    # 关联列。非 link 字段严禁携带这两项（validator 拒收）。
    link_table: str = ""
    bidirectional: bool = False
    # Existing UI button binding.  Buttons have no cell value; the contract
    # records only the observable native title used to bind the field safely.
    button_config: dict[str, Any] | None = None
    # Select defaults are option-name strings; user defaults are ID/slot
    # reference objects.  Both are normalized as a list at the schema boundary.
    default_value: list[Any] | None = None
    # Stable remote field identity.  Empty is retained for legacy contracts;
    # operations that require an ID binding validate it explicitly.
    field_id: str = ""


@dataclass
class TableContract:
    table_id: str
    name_zh: str
    description_zh: str
    unique_key: list[str]
    fields: list[FieldContract] = field(default_factory=list)
    # Table-header column groups (not record grouping).  Contracts address
    # members by stable field local_name; provision resolves them to field_id
    # only at the final Feishu IO hop.  The remote IDs are persisted from the
    # create response because Feishu currently exposes no list/get endpoint.
    field_groups: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class AssetContract:
    asset_id: str
    owner_session: str
    object_type: str
    title: str
    business_problem: str
    asset_category: AssetCategory
    placement_reason: str
    authority_model: AuthorityModel
    sync_direction: SyncDirection
    conflict_policy: str
    queue_pending_policy: str = "fifo"
    surface_in_session_menu: bool | None = None
    access_url: str = ""
    base_token: str = ""
    table_id: str = ""
    canonical_token: str = ""
    local_paths: list[str] = field(default_factory=list)
    skip_freshness_audit: bool = False
    # 行集由飞书而非本地源权威维护时，合同必须显式给出 kind/reason/evidence；缺省
    # 不等于豁免，巡检仍把无本地真源的合同列入补源待办。
    freshness_audit_exemption: dict[str, str] | None = None
    freshness_count_mode: str = ""
    freshness_expected_rows: int | None = None
    freshness_count_fields: list[str] = field(default_factory=list)
    freshness_count_paths: list[str] = field(default_factory=list)
    freshness_count_exclude_paths: list[str] = field(default_factory=list)
    # 仅 live-append 表显式 opt-in：允许本地领先远端的小滞后，并由 reconcile
    # 追踪其是否连续不增长；普通表仍保持严格的 0 差距审计。
    live_append_lag_policy: dict[str, int] = field(default_factory=dict)
    feishu_path: list[str] = field(default_factory=list)
    parent_ref: str = ""
    tables: list[TableContract] = field(default_factory=list)
    controlled_data_time_updates: list[dict] = field(default_factory=list)
    # 一次性 data-time 迁移写入例外：合同内显式声明，仅当写入的 op / caller / dedupe-key
    # 前缀三者精确匹配时，额外放行一组本来 authority=feishu（人手维护）的列（如 link 列）随
    # 该次 replace 落地。成功终态(done)即被消耗——换一把 key 不再授予，同 key 重放由队列去重
    # 天然幂等；绝不给日常写入留权限。None/缺省 = 无例外，日常保持字段级权威闸。
    migration_write_exception: dict | None = None
    # 多条一次性 upsert 例外：每个 entry 独立绑定 caller/key 前缀/目标唯一键并单独消费；
    # 与上面的历史单块并存，禁止通过修改历史块来表达第二个例外。
    migration_write_exceptions: list[dict] = field(default_factory=list)
    # 第二类一次性 data-time 恢复例外（migration_restore_exception）：与上面的单 key 消耗式
    # replace 例外不同，本块支持一个 campaign 用同一 key 前缀跑成百上千 job，按 op 声明放行：
    # - upsert：每行字段必须恰为 唯一键 ∪ writable_fields，据此放行 writable_fields 里的
    #   feishu 列；多带任何列即拒（守住「不放开日常写入」）。
    # - attachment_upload：field 必须恰为声明列、unique_key 必须恰为合同唯一键。
    # 不做单 key 消耗（campaign 天然多 key）；安全靠形状精确匹配，封口 = 迁移后 jianbiao 删本块。
    # None/缺省 = 无例外。与 migration_write_exception 并存、按 client_key_prefix 互相隔离。
    migration_restore_exception: dict | None = None
    # Optional display-only label for a session's group menu; title remains canonical.
    session_menu_label: str | None = None
    # Legacy/current registry contracts may keep the stable field binding at
    # asset level instead of repeating it on each FieldContract.
    field_ids: dict[str, str] = field(default_factory=dict)
