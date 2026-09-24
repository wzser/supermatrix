from __future__ import annotations

import re

from .models import AssetContract, FieldContract, TableContract


class ContractError(ValueError):
    pass


_CJK_RE = re.compile(r"[\u3400-\u9fff]")

_AUTHORITY_MODELS = {
    "feishu_only",
    "local_only",
    "local_authoritative",
    "feishu_authoritative",
    "field_split",
    "derived_mirror",
    "derived_projection",
}
_SYNC_DIRECTIONS = {
    "none",
    "local_to_remote",
    "remote_to_local",
    "remote_to_local_to_remote",
    "two_way",
}
_OBJECT_TYPES = {"document", "table"}
_ASSET_CATEGORIES = {
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
}
_CATEGORY_PATH_PREFIXES = {
    "platform_registry": [
        ["Supermatrix", "30 知识库", "FirstPrinciple"],
        ["Supermatrix", "00 入口与控制台"],
    ],
    "platform_sop": [
        ["Supermatrix", "30 知识库", "FirstPrinciple"],
        ["Supermatrix", "20 Agent SOP"],
        ["Supermatrix", "40 Agent 模块原版"],
    ],
    "platform_inventory": [["Supermatrix", "30 知识库", "FirstPrinciple"]],
    "platform_runtime_log": [["Supermatrix", "10 运行数据与台账"]],
    "platform_knowledge_doc": [
        ["Supermatrix", "30 知识库", "FirstPrinciple"],
        ["Supermatrix", "30 知识库", "codingmaster / SuperMatrix Architecture KB"],
        ["Supermatrix", "30 知识库", "wechat-administrator"],
        ["Supermatrix", "30 知识库", "ads-master"],
        ["Supermatrix", "30 知识库", "deepsearch"],
        ["Supermatrix", "30 知识库", "广目天王-外部知识库"],
        ["Supermatrix", "30 知识库", "qc-master"],
        ["Supermatrix", "30 知识库", "wytest 参考项目知识库"],
    ],
    "business_knowledge_doc": [["Supermatrix", "30 知识库", "业务知识库"]],
    "business_data_mirror": [["Supermatrix", "30 知识库", "业务知识库", "数据镜像（Data Mirrors）"]],
    "business_execution_log": [["Supermatrix", "30 知识库", "业务知识库", "运行日志（Runs）"]],
    "business_parameter_table": [["Supermatrix", "30 知识库", "业务知识库", "参数配置（Parameters）"]],
    "business_registry": [["Supermatrix", "30 知识库", "业务知识库", "来源索引（Sources）"]],
    "collaboration_doc": [["Supermatrix", "30 知识库", "业务知识库", "协作文档（Collaboration）"]],
    "personal_private": [["User private space"]],
}
# A managed Drive root is deliberately bound to its immutable folder token.  A
# A bare title is not a general directory-prefix exception: it is
# usable only with this exact parent_ref and only for the approved category.
_MANAGED_DRIVE_PARENT_PATH_PREFIXES: dict[str, dict[str, tuple[str, ...]]] = {}
_PERSONAL_SPACE_MARKERS = {
    "my_library",
    "personal",
    "个人空间",
    "我的空间",
    "个人文档",
}
_FIELD_AUTHORITIES = {
    "local", "feishu", "mixed", "tobedone", "derived", "readonly",
    # 飞书编辑时权威、切主 backend 时本地覆盖回写；写入闸为黑名单
    # （bitable.py 仅拒 feishu/readonly），该值保持可写、不归并进既有值。
    "feishu_on_edit_local_on_backend_switch",
}
_FIELD_TYPES = {
    "text",
    "single_select",
    "multi_select",
    "date",
    "date_time",
    "updated_at",
    "number",
    "attachment",
    "checkbox",
    "user",
    "auto_number",
    "link",
    "lookup",
    "formula",
    "button",
}
# T1 新建路径字段类型白名单（2026-08-05 根治方案）：_FIELD_TYPES 的真子集，
# 只在新建/draft 路径（create_table/template_clone 草稿、add_field/
# change_field_type/schema_batch 等价 change）收紧；存量合同加载/发布与
# data-time 调用点不经过这道闸、行为不变。绝不改 _FIELD_TYPES 本体
# （capability_probe.CONTRACT_FIELD_TYPES 直接从它派生探测计划）。
NEW_FIELD_TYPE_WHITELIST = frozenset({
    "text",
    "number",
    "single_select",
    "multi_select",
    "date_time",
    "date",
    "checkbox",
    "attachment",
    "link",
    "user",
    "auto_number",
})
_LOOKUP_FORMULA_RECIPE = (
    "由资产 owner 在飞书 UI 建好后，register_existing 按 field_id/类型/结构读回登记；"
    "派生结果不进入数据写入队列"
)
_BUTTON_RECIPE = (
    "由资产 owner 在飞书 UI 建按钮并 register_existing 为 readonly；"
    "按钮交互走 autobitable webhook（spawn autobitable）"
)
_UNKNOWN_TYPE_RECIPE = "人工在飞书 UI 建表后 register_existing 登记"

_CONTROLLED_DATA_TIME_OPS = {
    "bitable_record_delete_if_current",
    "bitable_record_update_if_current",
    "bitable_attachment_dedupe",
    "bitable_attachment_upload",
    "bitable_attachment_replace_if_current",
    "bitable_rows_update_existing",
    "bitable_rows_replace",
    "bitable_rows_create_if_absent",
    "bitable_rows_upsert",
}
# 迁移写入例外只可绑定 _dispatch_op 里真正透传 migration_grant_fields 的两个 op：
# bitable_rows_replace（set 收敛）与 bitable_rows_upsert（单 key 消耗 + 单行精确形状闸，见
# bitable.enforce_migration_write_upsert_shape）。update_existing 分支不透传 grant——声明它
# 等于给一个 drain 永不落实的假授权，故合同校验拒绝。别再往这里加 drain 不兑现的 op
# （否则=静默假授权，见 91a8a7e 教训）。
_MIGRATION_WRITE_EXCEPTION_OPS = {
    "bitable_rows_replace",
    "bitable_rows_upsert",
}
_MARKER_LINE_RE = re.compile(r"^[a-z][a-z0-9_-]*:v[1-9][0-9]*$")
MARKER_LINE_NAMESPACES = (
    "pta:v1",
    "ptr-contract:v1",
    "ptr-daily:v1",
)


def is_exact_separated_record_update_rule(rule: dict) -> bool:
    """Whether a CAS rule deliberately separates input snapshot from output patch.

    Validation owns the full shape checks.  This predicate is shared with the
    drain-time path so the contract distinction cannot be accepted at publish
    time and then interpreted more broadly when it executes.
    """
    writable = rule.get("writable_fields")
    expected = rule.get("expected_fields")
    return (
        rule.get("op") == "bitable_record_update_if_current"
        and rule.get("verify_fields_exact") is True
        and isinstance(writable, list)
        and isinstance(expected, list)
        and bool(writable)
        and bool(expected)
        and set(writable).isdisjoint(expected)
    )


def controlled_update_client_key_matches(
    rule: dict, client_key: str | None,
) -> bool:
    """Return whether a controlled CAS rule is in scope for this queue key.

    Most controlled updates remain key-agnostic.  A contract may opt into a
    full-match ``client_key_pattern`` to keep a broader, purpose-built rule from
    capturing an ordinary narrow CAS call from the same caller.
    """
    pattern = rule.get("client_key_pattern")
    if pattern is None:
        return True
    return isinstance(client_key, str) and re.fullmatch(pattern, client_key) is not None


def _require(value: str, label: str) -> None:
    if not value or not value.strip():
        raise ContractError(f"{label} is required")


def _has_chinese(value: str) -> bool:
    return bool(_CJK_RE.search(value or ""))


def _require_choice(value: str, label: str, allowed: set[str]) -> None:
    if value not in allowed:
        raise ContractError(f"{label} must be one of {', '.join(sorted(allowed))}: {value}")


def managed_parent_path_prefix(
    parent_ref: str, asset_category: str,
) -> tuple[str, ...] | None:
    """Return the policy-pinned Drive root prefix for one parent/category pair."""
    return _MANAGED_DRIVE_PARENT_PATH_PREFIXES.get(
        parent_ref.strip(), {}
    ).get(asset_category)


def validate_new_field_type(
    field_type: str,
    *,
    field_label: str,
    allow_lookup_formula: bool = False,
    allow_lookup: bool = False,
) -> None:
    """新建字段路径的类型白名单闸（独立函数承接路径信息）。

    只有明确处于新建路径的调用方（provision 的 create_table 草稿、schema_task
    的 add_field/change_field_type change）调用这里；validate_field/
    validate_asset_contract 等无 operation 上下文的链路不经过、行为不变。
    allow_lookup_formula 是 product-tracker 日表模板豁免（仿 validate_table
    的 template_name_exemption 布尔开关）。allow_lookup 只给 schema add_field
    执行器：其后的 native-ID precondition/v1 read-back 会继续把 lookup 收窄为
    已验证形状，不能借此放宽建表草稿。拒绝消息保持单行并包含替代配方。
    """
    if field_type in NEW_FIELD_TYPE_WHITELIST:
        return
    if allow_lookup and field_type == "lookup":
        return
    if allow_lookup_formula and field_type in {"lookup", "formula"}:
        return
    if field_type in {"lookup", "formula"}:
        recipe = _LOOKUP_FORMULA_RECIPE
    elif field_type == "button":
        recipe = _BUTTON_RECIPE
    else:
        recipe = _UNKNOWN_TYPE_RECIPE
    raise ContractError(
        f"field type {field_type!r} is not allowed on the new-field path"
        f"（{field_label}）：{recipe}"
    )


def validate_new_contract_field_types(
    tables: list, *, allow_lookup_formula: bool = False,
) -> None:
    """create_table/template_clone 草稿（raw payload dicts）的表级白名单闸。

    形状问题（非 dict、缺 type）不在这里拦——交由既有 _build_asset/
    validate_asset_contract 按原文案报错。
    """
    for table in tables or []:
        if not isinstance(table, dict):
            continue
        for field in table.get("fields") or []:
            if not isinstance(field, dict):
                continue
            field_type = str(field.get("type") or "").strip()
            if not field_type:
                continue
            validate_new_field_type(
                field_type,
                field_label=str(field.get("name_zh") or field.get("name") or ""),
                allow_lookup_formula=allow_lookup_formula,
            )


def validate_field(field: FieldContract) -> None:
    _require(field.name_zh, "field name_zh")
    _require(field.description_zh, "field description_zh")
    _require(field.type, "field type")
    _require(field.authority, "field authority")
    _require_choice(field.type, "field type", _FIELD_TYPES)
    _require_choice(field.authority, "field authority", _FIELD_AUTHORITIES)
    # button 列无 cell 数据，仅作人工触发入口（如 autobitable webhook 绑定）；
    # 强制 readonly 权威使 data-time 队列拒收 caller payload、镜像同步零比对。
    if field.type == "button" and field.authority != "readonly":
        raise ContractError(
            f"button field must declare readonly authority: {field.name_zh}"
        )
    if field.button_config is not None:
        if field.type != "button":
            raise ContractError(
                f"button_config is only valid for a button field: {field.name_zh}"
            )
        if set(field.button_config) != {"title"} or not isinstance(
            field.button_config.get("title"), str
        ) or not field.button_config["title"].strip():
            raise ContractError(
                f"button_config must contain one non-empty title: {field.name_zh}"
            )
    # link_table / bidirectional 仅 link 关联列可携带；其他类型带上视为合同书写错误（所有路径都拦）。
    # link 列本身是否必带 link_table 由建表严格闸（validate_table strict）执行，存量登记不卡。
    if field.type != "link":
        if field.link_table:
            raise ContractError(
                f"link_table is only valid for a link field: {field.name_zh}"
            )
        if field.bidirectional:
            raise ContractError(
                f"bidirectional is only valid for a link field: {field.name_zh}"
            )
    if not field.allow_non_chinese_name and not _has_chinese(field.name_zh):
        raise ContractError(f"field name must contain Chinese: {field.name_zh}")
    if field.allow_non_chinese_name and not field.non_chinese_reason.strip():
        raise ContractError(f"non_chinese_reason is required for field: {field.name_zh}")


def validate_table(
    table: TableContract, *, strict: bool = False, template_name_exemption: bool = False,
    approved_non_chinese_names: frozenset[str] | None = None,
) -> None:
    """strict=True (建表时) 执行 v2 硬规则：name_zh 必须中文 + local_name 必填。

    pre_create=False 时只跑基础结构校验，避免拦下历史 contract。

    template_name_exemption=True：本表是从一个「已发布 = 已被用户批准」的模板合同克隆出来的
    姊妹表（clone_template），字段名的批准早在模板发布时完成过。此时 strict 分支不再二次否决那些
    模板里就带 allow_non_chinese_name + non_chinese_reason 的既批字段（如 Acos/Tacos）；未带豁免的
    非中文名仍被 validate_field 拦下——ziniao summary_zh 绕过规范的硬化边界不放宽。

    approved_non_chinese_names：registry 证据白名单——只放行「字段名已在某份已发布合同里
    带 allow_non_chinese_name + non_chinese_reason 批准过」的非中文名（由 provision 层机械扫描
    registry 生成）。与 template_name_exemption 一样不放开任意新英文名：新名字必须先在既有
    合同里有过批准记录，这条闸才认。
    """
    _require(table.name_zh, "table name_zh")
    _require(table.description_zh, "table description_zh")
    if not _has_chinese(table.name_zh):
        raise ContractError(f"table name must contain Chinese: {table.name_zh}")
    field_names = [field.name_zh for field in table.fields]
    names = set(field_names)
    if len(names) != len(field_names):
        duplicates = sorted(name for name in names if field_names.count(name) > 1)
        raise ContractError(f"duplicate field name_zh: {', '.join(duplicates)}")
    for field in table.fields:
        validate_field(field)
        if strict:
            # v2 硬规则：每个 field 必须给 local_name (本地代码引用名)
            if not field.local_name.strip():
                raise ContractError(
                    f"local_name is required for new table field {field.name_zh!r}: "
                    "v2 contract 必须登记本地字段名→线上字段名 映射；空 local_name "
                    "视为兼容旧 contract，新建表不允许。"
                )
            # v2 硬规则：name_zh (飞书 field.name) 必须含中文，allow_non_chinese_name 不再有效。
            # 例外①：template_name_exemption 下，从已批准模板克隆过来、且模板里就带
            # allow_non_chinese_name + non_chinese_reason 的既批字段免除本条二次否决（批准已在
            # 模板发布时发生）。例外②：字段名在已发布合同里已有批准记录（registry 证据白名单
            # approved_non_chinese_names），且本字段自带同样的豁免声明——批准已在既有合同发布时发生。
            if not _has_chinese(field.name_zh):
                if not (
                    field.allow_non_chinese_name
                    and field.non_chinese_reason.strip()
                    and (
                        template_name_exemption
                        or (
                            approved_non_chinese_names
                            and field.name_zh in approved_non_chinese_names
                        )
                    )
                ):
                    raise ContractError(
                        f"name_zh must contain Chinese for new table field {field.name_zh!r}: "
                        f"飞书 field.name 必须中文 (本地代码引用走 local_name={field.local_name!r})；"
                        "allow_non_chinese_name 豁免在 v2 已废弃（事故出处：ziniao summary_zh 绕过"
                        "中文规范），仅 template 克隆或 registry 已批字段名可豁免。"
                    )
            # v2 硬规则：新建 link 关联列必须声明 link_table（关联目标表 table_id）。飞书建 link
            # 列必须指定目标表，凭空建的 link 列无意义；不放宽「无目标表的 link」。
            if field.type == "link" and not field.link_table.strip():
                raise ContractError(
                    f"link_table is required for new link field {field.name_zh!r}: "
                    "新建 link 关联列必须声明关联目标表 table_id（tbl…），不得凭空建无目标表的 link。"
                )
    fields_by_name = {field.name_zh: field for field in table.fields}
    for key in table.unique_key:
        if key not in names:
            raise ContractError(f"unique_key field not found: {key}")
        if fields_by_name[key].type == "button":
            raise ContractError(f"unique_key cannot use a button field: {key}")
    if table.field_groups:
        raise ContractError(
            "field_groups are schema-time only and are not supported by the public export"
        )


def _validate_migration_write_exception(asset: AssetContract) -> None:
    """一次性迁移写入例外块的结构与安全约束校验（缺省 None = 无例外，直接放过）。

    约束（缺一即 ContractError）：
    - op 必须是经字段级权威闸的行写入 op；
    - caller_session 必须是本 asset 的 owner（例外授予的是 owner 级、写人手维护列的特权，
      非 owner 走 controlled_data_time_updates（附件列只可经受控 bitable_attachment_upload
      规则授予，upsert/create 规则仍禁 attachment/derived/readonly））；
    - client_key_prefix 非空且以 ':' 收尾——钉死一个完整 key 段边界，杜绝相近前缀复用；
    - additional_writable_fields 非空、去重、均存在于表合同、且 authority 只能是 feishu
      （local 本就可写无需例外，readonly 机器只读不可写，都不许进例外）；
    - reason 非空，留审计。
    """
    _validate_migration_write_exception_entry(
        asset, asset.migration_write_exception, "migration_write_exception"
    )


def _validate_migration_write_exception_entry(
    asset: AssetContract, exc: object, label: str
) -> None:
    """Validate one single-key-consumed upsert/replace exception entry."""
    if exc is None:
        return
    if not isinstance(exc, dict):
        raise ContractError(f"{label} must be an object")
    if asset.object_type != "table" or not asset.tables:
        raise ContractError(f"{label} requires a table contract")

    op = exc.get("op")
    if op not in _MIGRATION_WRITE_EXCEPTION_OPS:
        raise ContractError(
            f"{label}.op must be one of "
            f"{', '.join(sorted(_MIGRATION_WRITE_EXCEPTION_OPS))}: {op}"
        )
    caller = exc.get("caller_session")
    if not isinstance(caller, str) or not caller.strip():
        raise ContractError(f"{label}.caller_session must be a non-empty string")
    if caller != asset.owner_session:
        raise ContractError(
            f"{label}.caller_session must be the asset owner ({asset.owner_session}); "
            f"the exception grants owner-level writes of feishu-authoritative fields: {caller}"
        )
    prefix = exc.get("client_key_prefix")
    if not isinstance(prefix, str) or not prefix.strip():
        raise ContractError(f"{label}.client_key_prefix must be a non-empty string")
    if not prefix.endswith(":"):
        raise ContractError(
            f"{label}.client_key_prefix must end with ':' to bind a full key segment "
            f"and prevent near-prefix reuse: {prefix}"
        )
    reason = exc.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ContractError(f"{label}.reason must be a non-empty string")

    fields = exc.get("additional_writable_fields")
    if not isinstance(fields, list) or not fields or not all(
        isinstance(value, str) and value.strip() for value in fields
    ):
        raise ContractError(
            f"{label}.additional_writable_fields must be a non-empty string list"
        )
    if len(set(fields)) != len(fields):
        raise ContractError(
            f"{label}.additional_writable_fields must not contain duplicates"
        )
    fields_by_name = {field.name_zh: field for field in asset.tables[0].fields}
    unknown = sorted(set(fields) - set(fields_by_name))
    if unknown:
        raise ContractError(
            f"{label}.additional_writable_fields references fields not found in the "
            f"table contract: {', '.join(unknown)}"
        )
    not_feishu = sorted(
        name for name in fields if fields_by_name[name].authority != "feishu"
    )
    if not_feishu:
        raise ContractError(
            f"{label}.additional_writable_fields may only grant feishu-authoritative "
            f"fields (local is already writable, readonly is machine-only): "
            f"{', '.join(not_feishu)}"
        )

    # target_unique_key（upsert-only 精确 locator，安全补强）：把 upsert 例外钉死到恰好一条既有
    # record。additional_writable_fields + 单行精确形状闸只锁「字段集」，不锁唯一键『值』——相近前缀
    # 的一把 key 仍可写任一既有 accepted 行，改动面没锁到用户指定的那一条。故 upsert 变体必须显式
    # 声明目标行的完整唯一键值（键恰为合同 unique_key），drain+enqueue 双闸按值比对，任一唯一键值
    # 不符即拒。replace 是 set 收敛（多行、删除靠 delete_guard/max_delete），单记录 pin 无意义故禁带。
    target = exc.get("target_unique_key")
    unique_key = list(asset.tables[0].unique_key)
    if op == "bitable_rows_upsert":
        if not isinstance(target, dict) or not target:
            raise ContractError(
                f"{label}.target_unique_key is required for bitable_rows_upsert: a dict pinning "
                f"the exact record's unique key values (keys must be {unique_key}); single-key "
                "consumption may only correct the one existing record the caller specified"
            )
        if set(target) != set(unique_key):
            raise ContractError(
                f"{label}.target_unique_key keys must be exactly the contract unique_key "
                f"{unique_key}: {sorted(target)}"
            )
        bad = sorted(
            key for key, value in target.items()
            if not isinstance(value, str) or not value.strip()
        )
        if bad:
            raise ContractError(
                f"{label}.target_unique_key values must be non-empty strings: {bad}"
            )
    elif target is not None:
        raise ContractError(
            f"{label}.target_unique_key is only valid for bitable_rows_upsert "
            f"(bitable_rows_replace converges a set and pins no single record): op={op}"
        )


def _validate_migration_write_exceptions(asset: AssetContract) -> None:
    entries = asset.migration_write_exceptions
    if not isinstance(entries, list):
        raise ContractError("migration_write_exceptions must be a list")
    prefixes: list[str] = []
    for index, entry in enumerate(entries):
        label = f"migration_write_exceptions[{index}]"
        _validate_migration_write_exception_entry(asset, entry, label)
        if not isinstance(entry, dict):
            continue
        expected_row = entry.get("expected_row")
        if not isinstance(expected_row, dict) or not expected_row:
            raise ContractError(f"{label}.expected_row must be a non-empty object")
        expected_keys = set(asset.tables[0].unique_key) | set(
            entry.get("additional_writable_fields") or []
        )
        if set(expected_row) != expected_keys:
            raise ContractError(
                f"{label}.expected_row keys must be exactly "
                f"unique_key plus additional_writable_fields: {sorted(expected_keys)}"
            )
        prefix = entry.get("client_key_prefix") if isinstance(entry, dict) else None
        if isinstance(prefix, str):
            prefixes.append(prefix)
    old_prefix = (
        asset.migration_write_exception.get("client_key_prefix")
        if isinstance(asset.migration_write_exception, dict)
        else None
    )
    all_prefixes = ([old_prefix] if isinstance(old_prefix, str) else []) + prefixes
    for index, prefix in enumerate(all_prefixes):
        for other in all_prefixes[index + 1:]:
            if prefix.startswith(other) or other.startswith(prefix):
                raise ContractError(
                    "migration write exception client_key_prefix values must not overlap: "
                    f"{prefix!r} and {other!r}"
                )
    for index, entry in enumerate(entries):
        if isinstance(entry, dict) and entry.get("op") != "bitable_rows_upsert":
            raise ContractError(
                f"migration_write_exceptions[{index}].op must be bitable_rows_upsert"
            )


# 恢复例外可绑定的 op → drain 侧真正 forward/enforce grant 的分支。upsert 透传
# migration_grant_fields 给 bitable_live_sync；attachment_upload 由 check_migration_restore_
# attachment 在 drain/enqueue 施加 field/unique_key 精确闸。白名单必须 ≤ 这两个真落实分支，
# 别再加一个 drain 不兑现的 op（否则=静默假授权，见 migration_write_exception 的 91a8a7e 教训）。
_MIGRATION_RESTORE_OP_KEYS = {
    "upsert": "bitable_rows_upsert",
    "attachment_upload": "bitable_attachment_upload",
}


def _validate_migration_restore_exception(asset: AssetContract) -> None:
    """第二类一次性恢复例外块（migration_restore_exception）的结构与安全约束校验。

    约束（缺一即 ContractError）：
    - caller_session 必须是本 asset 的 owner（例外授予 owner 级写人手维护列的特权）；
    - client_key_prefix 非空且以 ':' 收尾——钉死完整 key 段边界，杜绝相近前缀复用；
    - reason 非空，留审计；
    - 至少声明 upsert / attachment_upload 之一；
    - upsert.writable_fields 非空、去重、均存在于表合同、authority 只能是 feishu
      （local 本就可写、readonly 机器只读，都不进例外）；
    - attachment_upload.field 存在、type=attachment、authority=feishu（本地附件 owner 本就
      可写，无需例外）。
    """
    exc = asset.migration_restore_exception
    if exc is None:
        return
    label = "migration_restore_exception"
    if not isinstance(exc, dict):
        raise ContractError(f"{label} must be an object")
    if asset.object_type != "table" or not asset.tables:
        raise ContractError(f"{label} requires a table contract")

    caller = exc.get("caller_session")
    if not isinstance(caller, str) or not caller.strip():
        raise ContractError(f"{label}.caller_session must be a non-empty string")
    if caller != asset.owner_session:
        raise ContractError(
            f"{label}.caller_session must be the asset owner ({asset.owner_session}); "
            f"the exception grants owner-level writes of feishu-authoritative fields: {caller}"
        )
    prefix = exc.get("client_key_prefix")
    if not isinstance(prefix, str) or not prefix.strip():
        raise ContractError(f"{label}.client_key_prefix must be a non-empty string")
    if not prefix.endswith(":"):
        raise ContractError(
            f"{label}.client_key_prefix must end with ':' to bind a full key segment "
            f"and prevent near-prefix reuse: {prefix}"
        )
    reason = exc.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ContractError(f"{label}.reason must be a non-empty string")

    if "upsert" not in exc and "attachment_upload" not in exc:
        raise ContractError(
            f"{label} must declare at least one of upsert / attachment_upload"
        )

    fields_by_name = {field.name_zh: field for field in asset.tables[0].fields}
    if "upsert" in exc:
        upsert = exc.get("upsert")
        if not isinstance(upsert, dict):
            raise ContractError(f"{label}.upsert must be an object")
        writable = upsert.get("writable_fields")
        if not isinstance(writable, list) or not writable or not all(
            isinstance(value, str) and value.strip() for value in writable
        ):
            raise ContractError(
                f"{label}.upsert.writable_fields must be a non-empty string list"
            )
        if len(set(writable)) != len(writable):
            raise ContractError(
                f"{label}.upsert.writable_fields must not contain duplicates"
            )
        unknown = sorted(set(writable) - set(fields_by_name))
        if unknown:
            raise ContractError(
                f"{label}.upsert.writable_fields references fields not found in the "
                f"table contract: {', '.join(unknown)}"
            )
        not_feishu = sorted(
            name for name in writable if fields_by_name[name].authority != "feishu"
        )
        if not_feishu:
            raise ContractError(
                f"{label}.upsert.writable_fields may only grant feishu-authoritative "
                f"fields (local is already writable, readonly is machine-only): "
                f"{', '.join(not_feishu)}"
            )

    if "attachment_upload" in exc:
        attach = exc.get("attachment_upload")
        if not isinstance(attach, dict):
            raise ContractError(f"{label}.attachment_upload must be an object")
        field_name = attach.get("field")
        if not isinstance(field_name, str) or not field_name.strip():
            raise ContractError(
                f"{label}.attachment_upload.field must be a non-empty string"
            )
        field_def = fields_by_name.get(field_name)
        if field_def is None:
            raise ContractError(
                f"{label}.attachment_upload.field not found in the table contract: {field_name}"
            )
        if field_def.type != "attachment":
            raise ContractError(
                f"{label}.attachment_upload.field must be an attachment column: {field_name}"
            )
        if field_def.authority != "feishu":
            raise ContractError(
                f"{label}.attachment_upload.field may only grant feishu-authoritative "
                f"columns (local is already writable): {field_name}"
            )


def _validate_controlled_row_scope(
    scope: Any,
    *,
    label: str,
    fields_by_name: dict[str, Any],
    field_names: set[str],
    required: bool,
) -> None:
    if scope is None and not required:
        return
    if not isinstance(scope, dict):
        raise ContractError(f"{label}.row_scope must be an object")
    scope_field = scope.get("field")
    if not isinstance(scope_field, str) or not scope_field.strip():
        raise ContractError(f"{label}.row_scope.field must be a non-empty string")
    if scope_field not in field_names:
        raise ContractError(
            f"{label}.row_scope.field not found in the table contract: {scope_field}"
        )
    scope_shape = set(scope)
    if scope_shape == {"field", "non_empty"}:
        if fields_by_name[scope_field].type != "text":
            raise ContractError(
                f"{label}.row_scope.field must be a text column: {scope_field}"
            )
        if scope.get("non_empty") is not True:
            raise ContractError(f"{label}.row_scope.non_empty must be true")
        return
    if scope_shape != {"field", "allowed_values"}:
        raise ContractError(
            f"{label}.row_scope must contain exactly field plus non_empty or allowed_values"
        )
    if fields_by_name[scope_field].type not in {"single_select", "text"}:
        raise ContractError(
            f"{label}.row_scope.allowed_values requires a single_select or text field: "
            f"{scope_field}"
        )
    values = scope.get("allowed_values")
    if not isinstance(values, list) or not values or not all(
        isinstance(value, str) and value.strip() for value in values
    ):
        raise ContractError(
            f"{label}.row_scope.allowed_values must be a non-empty string list"
        )
    if len(set(values)) != len(values):
        raise ContractError(f"{label}.row_scope.allowed_values must not contain duplicates")


def _validate_controlled_value_link(
    value_link: Any,
    *,
    label: str,
    fields_by_name: dict[str, Any],
    writable_fields: set[str],
    table: TableContract,
) -> None:
    if value_link is None:
        return
    if not isinstance(value_link, dict) or not value_link:
        raise ContractError(f"{label}.value_link must be a non-empty object")
    unknown_fields = set(value_link) - writable_fields
    if unknown_fields:
        raise ContractError(
            f"{label}.value_link references fields outside writable_fields: "
            f"{', '.join(sorted(unknown_fields))}"
        )
    for field_name, constraint in value_link.items():
        if fields_by_name[field_name].type != "link":
            raise ContractError(
                f"{label}.value_link.{field_name} requires a link field"
            )
        if not isinstance(constraint, dict) or set(constraint) != {
            "max_targets", "same_table", "allow_clear"
        }:
            raise ContractError(
                f"{label}.value_link.{field_name} must contain exactly "
                "max_targets, same_table, and allow_clear"
            )
        max_targets = constraint["max_targets"]
        if isinstance(max_targets, bool) or not isinstance(max_targets, int) or max_targets != 1:
            raise ContractError(
                f"{label}.value_link.{field_name}.max_targets must be 1"
            )
        for key in ("same_table", "allow_clear"):
            if not isinstance(constraint[key], bool):
                raise ContractError(
                    f"{label}.value_link.{field_name}.{key} must be boolean"
                )
        if constraint["same_table"] is not True:
            raise ContractError(
                f"{label}.value_link.{field_name}.same_table must be true"
            )
        expected_table_id = table.table_id
        if not expected_table_id or fields_by_name[field_name].link_table != expected_table_id:
            raise ContractError(
                f"{label}.value_link.{field_name}.same_table requires the link "
                f"target table to equal {expected_table_id!r}"
            )


def _validate_controlled_data_time_updates(asset: AssetContract) -> None:
    rules = asset.controlled_data_time_updates
    if not isinstance(rules, list):
        raise ContractError("controlled_data_time_updates must be a list")
    if not rules:
        return
    if asset.object_type != "table" or not asset.tables:
        raise ContractError("controlled_data_time_updates requires a table contract")

    fields_by_name = {field.name_zh: field for field in asset.tables[0].fields}
    field_names = set(fields_by_name)
    for index, rule in enumerate(rules):
        label = f"controlled_data_time_updates[{index}]"
        if not isinstance(rule, dict):
            raise ContractError(f"{label} must be an object")
        op = rule.get("op")
        if op not in _CONTROLLED_DATA_TIME_OPS:
            raise ContractError(f"{label}.op is not supported: {op}")

        if op == "bitable_rows_create_if_absent":
            normalized: dict[str, list[str]] = {}
            for key in (
                "caller_sessions",
                "unique_key",
                "writable_fields",
                "required_fields",
            ):
                values = rule.get(key)
                if not isinstance(values, list) or not values or not all(
                    isinstance(value, str) and value.strip() for value in values
                ):
                    raise ContractError(f"{label}.{key} must be a non-empty string list")
                if len(set(values)) != len(values):
                    raise ContractError(f"{label}.{key} must not contain duplicates")
                normalized[key] = values
            if rule.get("write_mode") != "create_if_absent":
                raise ContractError(
                    f"{label}.write_mode must be create_if_absent"
                )
            if normalized["unique_key"] != asset.tables[0].unique_key:
                raise ContractError(
                    f"{label}.unique_key must exactly match the table unique_key"
                )
            writable_fields = set(normalized["writable_fields"])
            required_fields = set(normalized["required_fields"])
            unknown_fields = (writable_fields | required_fields) - field_names
            if unknown_fields:
                raise ContractError(
                    f"{label} references fields not found in the table contract: "
                    f"{', '.join(sorted(unknown_fields))}"
                )
            if writable_fields != required_fields:
                raise ContractError(
                    f"{label}.required_fields must exactly match writable_fields"
                )
            if not set(normalized["unique_key"]) <= writable_fields:
                raise ContractError(
                    f"{label}.writable_fields must include the full unique_key"
                )
            forbidden = sorted(
                field for field in writable_fields
                if fields_by_name[field].type == "attachment"
                or fields_by_name[field].authority in {"derived", "readonly"}
            )
            if forbidden:
                raise ContractError(
                    f"{label}.writable_fields cannot contain attachment, derived, or readonly fields: "
                    f"{', '.join(forbidden)}"
                )
            continue

        if op == "bitable_rows_upsert":
            # 受控镜像 upsert：非 owner caller 经公共队列按表唯一键回写一组窄字段。
            normalized: dict[str, list[str]] = {}
            for key in ("caller_sessions", "unique_key", "writable_fields"):
                values = rule.get(key)
                if not isinstance(values, list) or not values or not all(
                    isinstance(value, str) and value.strip() for value in values
                ):
                    raise ContractError(f"{label}.{key} must be a non-empty string list")
                if len(set(values)) != len(values):
                    raise ContractError(f"{label}.{key} must not contain duplicates")
                normalized[key] = values
            if normalized["unique_key"] != asset.tables[0].unique_key:
                raise ContractError(
                    f"{label}.unique_key must exactly match the table unique_key"
                )
            writable_fields = set(normalized["writable_fields"])
            unknown_fields = writable_fields - field_names
            if unknown_fields:
                raise ContractError(
                    f"{label} references fields not found in the table contract: "
                    f"{', '.join(sorted(unknown_fields))}"
                )
            if not set(normalized["unique_key"]) <= writable_fields:
                raise ContractError(
                    f"{label}.writable_fields must include the full unique_key"
                )
            link_fields = sorted(
                field for field in writable_fields
                if fields_by_name[field].type in {"link", "single_link", "duplex_link", "relation"}
            )
            if link_fields:
                raise ContractError(
                    f"{label}.writable_fields cannot contain link fields: "
                    f"{', '.join(link_fields)}"
                )
            attachment_fields = sorted(
                field for field in writable_fields
                if fields_by_name[field].type == "attachment"
            )
            if attachment_fields:
                # A controlled attachment rule is deliberately narrower than ordinary
                # controlled upsert. A non-owner may carry a feishu-authoritative
                # unique key solely as a locator (bitable_upsert_plan removes it from
                # write_fields), but every actual write target must be local. This
                # permits a contract-explicit machine report attachment without
                # turning the rule into a path for human fields or group/activity
                # links.
                nonlocal_attachments = sorted(
                    field for field in attachment_fields
                    if fields_by_name[field].authority != "local"
                )
                if nonlocal_attachments:
                    raise ContractError(
                        f"{label}.writable_fields cannot contain attachment, derived, or "
                        f"readonly fields unless it is an attachment field that is local; "
                        f"attachment fields must be local: "
                        f"{', '.join(nonlocal_attachments)}"
                    )
                nonlocal_fields = sorted(
                    field for field in writable_fields
                    if field not in set(normalized["unique_key"])
                    and fields_by_name[field].authority != "local"
                )
                if nonlocal_fields:
                    raise ContractError(
                        f"{label}.writable_fields with attachment may contain only "
                        f"local fields outside the unique-key locator; non-local: "
                        f"{', '.join(nonlocal_fields)}"
                    )
            else:
                forbidden = sorted(
                    field for field in writable_fields
                    if fields_by_name[field].authority in {"derived", "readonly"}
                )
                if forbidden:
                    raise ContractError(
                        f"{label}.writable_fields cannot contain attachment, derived, or readonly fields: "
                        f"{', '.join(forbidden)}"
                    )
            continue

        if op == "bitable_attachment_upload":
            # 受控附件上传：非 owner caller 经公共队列按表唯一键把附件补到既有记录的指定
            # 附件列。比 restore 例外更窄且常驻：只授 caller_sessions、只授声明列、唯一键
            # 必须恰为表唯一键；不授任何其他附件列，也不允许 create（记录必须已存在）。
            caller_sessions = rule.get("caller_sessions")
            if not isinstance(caller_sessions, list) or not caller_sessions or not all(
                isinstance(value, str) and value.strip() for value in caller_sessions
            ):
                raise ContractError(f"{label}.caller_sessions must be a non-empty string list")
            if len(set(caller_sessions)) != len(caller_sessions):
                raise ContractError(f"{label}.caller_sessions must not contain duplicates")
            unique_key = rule.get("unique_key")
            if not isinstance(unique_key, list) or not unique_key or not all(
                isinstance(value, str) and value.strip() for value in unique_key
            ):
                raise ContractError(f"{label}.unique_key must be a non-empty string list")
            if len(set(unique_key)) != len(unique_key):
                raise ContractError(f"{label}.unique_key must not contain duplicates")
            if unique_key != asset.tables[0].unique_key:
                raise ContractError(
                    f"{label}.unique_key must exactly match the table unique_key"
                )
            field_name = rule.get("field")
            if not isinstance(field_name, str) or not field_name.strip():
                raise ContractError(f"{label}.field must be a non-empty string")
            field_def = fields_by_name.get(field_name)
            if field_def is None:
                raise ContractError(
                    f"{label}.field not found in the table contract: {field_name}"
                )
            if field_def.type != "attachment":
                raise ContractError(
                    f"{label}.field must be an attachment column: {field_name}"
                )
            if field_def.authority != "feishu":
                raise ContractError(
                    f"{label}.field may only grant feishu-authoritative attachment "
                    f"columns (local attachment is already writable via controlled "
                    f"upsert): {field_name}"
                )
            scope = rule.get("row_scope")
            if scope is not None:
                if not isinstance(scope, dict):
                    raise ContractError(f"{label}.row_scope must be an object")
                scope_field = scope.get("field")
                if not isinstance(scope_field, str) or not scope_field.strip():
                    raise ContractError(f"{label}.row_scope.field must be a non-empty string")
                if scope_field not in field_names:
                    raise ContractError(
                        f"{label}.row_scope.field not found in the table contract: {scope_field}"
                    )
                if fields_by_name[scope_field].type != "text":
                    raise ContractError(
                        f"{label}.row_scope.field must be a text column: {scope_field}"
                    )
                if scope.get("non_empty") is not True:
                    raise ContractError(f"{label}.row_scope.non_empty must be true")
            continue

        if op == "bitable_attachment_replace_if_current":
            from .attachment_replace import validate_attachment_replace_rule

            try:
                validate_attachment_replace_rule(asset, rule, label)
            except ValueError as exc:
                raise ContractError(str(exc)) from exc
            continue

        if op == "bitable_rows_update_existing":
            # 受控既有行更新：非 owner 只能按合同唯一键定位既有记录，写明的
            # writable_fields，且目标记录必须落在声明的 row_scope 内。该 op
            # 不创建记录，也不要求把 locator unique_key 放入 writable_fields。
            normalized: dict[str, list[str]] = {}
            for key in ("caller_sessions", "unique_key", "writable_fields"):
                values = rule.get(key)
                if not isinstance(values, list) or not values or not all(
                    isinstance(value, str) and value.strip() for value in values
                ):
                    raise ContractError(f"{label}.{key} must be a non-empty string list")
                if len(set(values)) != len(values):
                    raise ContractError(f"{label}.{key} must not contain duplicates")
                normalized[key] = values
            if normalized["unique_key"] != asset.tables[0].unique_key:
                raise ContractError(
                    f"{label}.unique_key must exactly match the table unique_key"
                )
            writable_fields = set(normalized["writable_fields"])
            unknown_fields = writable_fields - field_names
            if unknown_fields:
                raise ContractError(
                    f"{label}.writable_fields references fields not found in the table contract: "
                    f"{', '.join(sorted(unknown_fields))}"
                )
            forbidden = sorted(
                field for field in writable_fields
                if fields_by_name[field].type == "attachment"
                or fields_by_name[field].authority in {"derived", "readonly"}
            )
            if forbidden:
                raise ContractError(
                    f"{label}.writable_fields cannot contain attachment, derived, or "
                    f"readonly fields: {', '.join(forbidden)}"
                )

            _validate_controlled_row_scope(
                rule.get("row_scope"),
                label=label,
                fields_by_name=fields_by_name,
                field_names=field_names,
                required=True,
            )
            required_non_empty = rule.get("required_non_empty_row_fields")
            if required_non_empty is not None:
                if (
                    not isinstance(required_non_empty, list)
                    or not required_non_empty
                    or len(set(required_non_empty)) != len(required_non_empty)
                    or not all(
                        isinstance(value, str) and value.strip()
                        for value in required_non_empty
                    )
                ):
                    raise ContractError(
                        f"{label}.required_non_empty_row_fields must be a non-empty unique string list"
                    )
                unknown_required = set(required_non_empty) - field_names
                if unknown_required:
                    raise ContractError(
                        f"{label}.required_non_empty_row_fields references fields not found in the table contract: "
                        f"{', '.join(sorted(unknown_required))}"
                    )
                non_text_required = sorted(
                    field for field in required_non_empty
                    if fields_by_name[field].type != "text"
                )
                if non_text_required:
                    raise ContractError(
                        f"{label}.required_non_empty_row_fields requires text fields: "
                        f"{', '.join(non_text_required)}"
                    )

            allowed_values = rule.get("allowed_values")
            if allowed_values is None:
                allowed_values = {}
            elif not isinstance(allowed_values, dict) or not allowed_values:
                raise ContractError(f"{label}.allowed_values must be a non-empty object")
            value_link = rule.get("value_link")
            if not allowed_values and rule.get("value_regex") is None and value_link is None:
                raise ContractError(
                    f"{label} must declare allowed_values, value_regex, or value_link"
                )
            unknown_allowed = set(allowed_values) - writable_fields
            if unknown_allowed:
                raise ContractError(
                    f"{label}.allowed_values references fields outside writable_fields: "
                    f"{', '.join(sorted(unknown_allowed))}"
                )
            for field_name, values in allowed_values.items():
                if not isinstance(values, list) or not values or not all(
                    isinstance(value, str) and value.strip() for value in values
                ):
                    raise ContractError(
                        f"{label}.allowed_values.{field_name} must be a non-empty string list"
                    )
                if len(set(values)) != len(values):
                    raise ContractError(
                        f"{label}.allowed_values.{field_name} must not contain duplicates"
                    )

            value_regex = rule.get("value_regex")
            if value_regex is not None:
                if not isinstance(value_regex, dict) or not value_regex:
                    raise ContractError(f"{label}.value_regex must be a non-empty object")
                unknown_regex = set(value_regex) - writable_fields
                if unknown_regex:
                    raise ContractError(
                        f"{label}.value_regex references fields outside writable_fields: "
                        f"{', '.join(sorted(unknown_regex))}"
                    )
                for field_name, pattern in value_regex.items():
                    if fields_by_name[field_name].type != "text":
                        raise ContractError(
                            f"{label}.value_regex.{field_name} requires a text field"
                        )
                    if not isinstance(pattern, str) or not pattern.strip():
                        raise ContractError(
                            f"{label}.value_regex.{field_name} must be a non-empty string"
                        )
                    try:
                        re.compile(pattern)
                    except re.error as exc:
                        raise ContractError(
                            f"{label}.value_regex.{field_name} must be a valid regular expression"
                        ) from exc

            _validate_controlled_value_link(
                value_link,
                label=label,
                fields_by_name=fields_by_name,
                writable_fields=writable_fields,
                table=asset.tables[0],
            )

            dedupe = rule.get("dedupe_key")
            if not isinstance(dedupe, dict):
                raise ContractError(f"{label}.dedupe_key must be an object")
            parts = dedupe.get("parts")
            if parts == ["record_id", "normalized_target_values"]:
                target_fields = dedupe.get("target_fields")
                if not isinstance(target_fields, list) or not target_fields or not all(
                    isinstance(value, str) and value.strip() for value in target_fields
                ):
                    raise ContractError(
                        f"{label}.dedupe_key.target_fields must be a non-empty string list"
                    )
                if len(set(target_fields)) != len(target_fields):
                    raise ContractError(
                        f"{label}.dedupe_key.target_fields must not contain duplicates"
                    )
                if set(target_fields) != writable_fields:
                    raise ContractError(
                        f"{label}.dedupe_key.target_fields must exactly match writable_fields"
                    )
            else:
                if not isinstance(parts, list) or not parts or not all(
                    isinstance(value, str) and value.strip() for value in parts
                ):
                    raise ContractError(f"{label}.dedupe_key.parts must be a non-empty string list")
                if len(set(parts)) != len(parts):
                    raise ContractError(f"{label}.dedupe_key.parts must not contain duplicates")
                if not set(asset.tables[0].unique_key).issubset(parts):
                    raise ContractError(
                        f"{label}.dedupe_key.parts must include the full table unique_key"
                    )
                if not writable_fields.issubset(parts):
                    raise ContractError(
                        f"{label}.dedupe_key.parts must include every writable field"
                    )
                if dedupe.get("clear_action") != "clear":
                    raise ContractError(
                        f"{label}.dedupe_key.clear_action must be clear for field-clearing rules"
                    )
            if dedupe.get("normalization") != "json_canonical":
                raise ContractError(
                    f"{label}.dedupe_key.normalization must be json_canonical"
                )
            continue

        if op == "bitable_rows_replace":
            # 受控替换（收敛式删除）：非 owner caller 经公共队列把 in-scope 集合收敛到
            # payload 行（孤儿行删除）。比 upsert 更窄且常驻：只授 caller_sessions、
            # writable_fields 只含唯一键（payload 行只能定位/收敛，不得改其他列）、
            # delete_guard 必须在合同内声明（field + values 精确锁定可删范围，防误删
            # 其他批次）、max_delete 是单次运行删除硬上限。
            normalized: dict[str, list[str]] = {}
            for key in ("caller_sessions", "unique_key", "writable_fields"):
                values = rule.get(key)
                if not isinstance(values, list) or not values or not all(
                    isinstance(value, str) and value.strip() for value in values
                ):
                    raise ContractError(f"{label}.{key} must be a non-empty string list")
                if len(set(values)) != len(values):
                    raise ContractError(f"{label}.{key} must not contain duplicates")
                normalized[key] = values
            if normalized["unique_key"] != asset.tables[0].unique_key:
                raise ContractError(
                    f"{label}.unique_key must exactly match the table unique_key"
                )
            writable_fields = set(normalized["writable_fields"])
            unknown_fields = writable_fields - field_names
            if unknown_fields:
                raise ContractError(
                    f"{label} references fields not found in the table contract: "
                    f"{', '.join(sorted(unknown_fields))}"
                )
            if not set(normalized["unique_key"]) <= writable_fields:
                raise ContractError(
                    f"{label}.writable_fields must include the full unique_key"
                )
            forbidden = sorted(
                field for field in writable_fields
                if fields_by_name[field].type == "attachment"
                or fields_by_name[field].authority in {"derived", "readonly"}
            )
            if forbidden:
                raise ContractError(
                    f"{label}.writable_fields cannot contain attachment, derived, or "
                    f"readonly fields: {', '.join(forbidden)}"
                )
            guard = rule.get("delete_guard")
            if not isinstance(guard, dict):
                raise ContractError(f"{label}.delete_guard must be an object")
            guard_field = guard.get("field")
            if not isinstance(guard_field, str) or not guard_field.strip():
                raise ContractError(f"{label}.delete_guard.field must be a non-empty string")
            if guard_field not in field_names:
                raise ContractError(
                    f"{label}.delete_guard.field not found in the table contract: "
                    f"{guard_field}"
                )
            guard_values = guard.get("values")
            if not isinstance(guard_values, list) or not guard_values or not all(
                isinstance(value, str) and value.strip() for value in guard_values
            ):
                raise ContractError(
                    f"{label}.delete_guard.values must be a non-empty string list"
                )
            if len(set(guard_values)) != len(guard_values):
                raise ContractError(
                    f"{label}.delete_guard.values must not contain duplicates"
                )
            max_delete = rule.get("max_delete")
            if not isinstance(max_delete, int) or isinstance(max_delete, bool) or max_delete <= 0:
                raise ContractError(f"{label}.max_delete must be a positive integer")
            continue

        if op == "bitable_record_delete_if_current":
            # 单行不可逆删除不是 replace 的简写。它只允许资产 owner 对合同逐条
            # 绑定的 record_id 做 "当前快照仍一致才删除"；confirmation_ref 绑定
            # 这一次破坏性业务决定，delete_bindings 则禁止把通用 owner 权限扩成
            # 任意 record-delete API。
            required_keys = {
                "op", "caller_sessions", "unique_key", "expected_fields",
                "confirmed_by_user", "confirmation_ref", "dedupe_key", "delete_bindings",
            }
            if set(rule) != required_keys:
                raise ContractError(
                    f"{label} must contain only "
                    "op, caller_sessions, unique_key, expected_fields, "
                    "confirmed_by_user, confirmation_ref, dedupe_key, and delete_bindings"
                )
            callers = rule.get("caller_sessions")
            if callers != [asset.owner_session]:
                raise ContractError(
                    f"{label}.caller_sessions must exactly equal [asset.owner_session]"
                )
            unique_key = rule.get("unique_key")
            expected_fields = rule.get("expected_fields")
            for key, values in (
                ("unique_key", unique_key),
                ("expected_fields", expected_fields),
            ):
                if not isinstance(values, list) or not values or not all(
                    isinstance(value, str) and value.strip() for value in values
                ):
                    raise ContractError(f"{label}.{key} must be a non-empty string list")
                if len(set(values)) != len(values):
                    raise ContractError(f"{label}.{key} must not contain duplicates")
            if unique_key != asset.tables[0].unique_key:
                raise ContractError(
                    f"{label}.unique_key must exactly match the table unique_key"
                )
            unknown_expected = set(expected_fields) - field_names
            if unknown_expected:
                raise ContractError(
                    f"{label}.expected_fields references fields not found in the table contract: "
                    f"{', '.join(sorted(unknown_expected))}"
                )
            if not set(unique_key).issubset(expected_fields):
                raise ContractError(
                    f"{label}.expected_fields must include the full table unique_key"
                )
            confirmation_ref = rule.get("confirmation_ref")
            if not isinstance(confirmation_ref, str) or not confirmation_ref.strip():
                raise ContractError(f"{label}.confirmation_ref must be a non-empty string")
            if rule.get("confirmed_by_user") is not True:
                raise ContractError(f"{label}.confirmed_by_user must be true")
            dedupe_key = rule.get("dedupe_key")
            if (
                not isinstance(dedupe_key, str)
                or not dedupe_key.strip()
                or dedupe_key != dedupe_key.strip()
            ):
                raise ContractError(f"{label}.dedupe_key must be a non-empty, trimmed string")
            field_ids = {
                str(field_name): str(field_id)
                for field_name, field_id in (asset.field_ids or {}).items()
                if isinstance(field_name, str) and isinstance(field_id, str) and field_id.strip()
            }
            id_to_name = {field_id: field_name for field_name, field_id in field_ids.items()}
            if len(id_to_name) != len(field_ids):
                raise ContractError(f"{label}.delete_bindings requires unique asset field_ids")
            if not field_ids or set(field_ids) != field_names:
                raise ContractError(
                    f"{label}.delete_bindings requires complete asset field_ids"
                )
            bindings = rule.get("delete_bindings")
            if (
                not isinstance(bindings, list)
                or len(bindings) != 1
                or not all(isinstance(binding, dict) for binding in bindings)
            ):
                raise ContractError(
                    f"{label}.delete_bindings must be a one-object list for one exact deletion"
                )
            seen_record_ids: set[str] = set()
            for binding_index, binding in enumerate(bindings):
                binding_label = f"{label}.delete_bindings[{binding_index}]"
                if set(binding) != {"record_id", "immutable_expected_fields"}:
                    raise ContractError(
                        f"{binding_label} must contain only record_id and "
                        "immutable_expected_fields"
                    )
                record_id = binding.get("record_id")
                if not isinstance(record_id, str) or not record_id.strip():
                    raise ContractError(f"{binding_label}.record_id must be non-empty")
                if record_id in seen_record_ids:
                    raise ContractError(
                        f"{label}.delete_bindings record_id must be unique: {record_id}"
                    )
                seen_record_ids.add(record_id)
                immutable = binding.get("immutable_expected_fields")
                if not isinstance(immutable, dict) or not immutable:
                    raise ContractError(
                        f"{binding_label}.immutable_expected_fields must be a non-empty object"
                    )
                unknown_ids = set(immutable) - set(id_to_name)
                if unknown_ids:
                    raise ContractError(
                        f"{binding_label}.immutable_expected_fields references an unknown field_id: "
                        f"{', '.join(sorted(unknown_ids))}"
                    )
                immutable_names = {id_to_name[field_id] for field_id in immutable}
                if immutable_names != set(expected_fields):
                    raise ContractError(
                        f"{binding_label}.immutable_expected_fields field_ids must "
                        "exactly map to expected_fields"
                    )
            continue

        normalized: dict[str, list[str]] = {}
        for key in ("caller_sessions", "writable_fields", "expected_fields"):
            values = rule.get(key)
            if not isinstance(values, list) or not values or not all(
                isinstance(value, str) and value.strip() for value in values
            ):
                raise ContractError(f"{label}.{key} must be a non-empty string list")
            if len(set(values)) != len(values):
                raise ContractError(f"{label}.{key} must not contain duplicates")
            normalized[key] = values

        writable_fields = set(normalized["writable_fields"])
        expected_fields = set(normalized["expected_fields"])
        unknown_fields = (writable_fields | expected_fields) - field_names
        if unknown_fields:
            raise ContractError(
                f"{label} references fields not found in the table contract: "
                f"{', '.join(sorted(unknown_fields))}"
            )

        composite_key_cas = rule.get("composite_key_cas")
        if composite_key_cas is not None:
            if op != "bitable_record_update_if_current":
                raise ContractError(
                    f"{label}.composite_key_cas is only supported for "
                    "bitable_record_update_if_current"
                )
            if not isinstance(composite_key_cas, dict):
                raise ContractError(f"{label}.composite_key_cas must be an object")
            if composite_key_cas.get("collision_guard") != "exact_remote_unique_key":
                raise ContractError(
                    f"{label}.composite_key_cas.collision_guard must be "
                    "exact_remote_unique_key"
                )
            composite_unique_key = composite_key_cas.get("unique_key")
            if composite_unique_key != asset.tables[0].unique_key:
                raise ContractError(
                    f"{label}.composite_key_cas.unique_key must exactly match "
                    "the table unique_key"
                )
            mutable_key_fields = composite_key_cas.get("mutable_key_fields")
            if (
                not isinstance(mutable_key_fields, list)
                or len(mutable_key_fields) != 1
                or not isinstance(mutable_key_fields[0], str)
                or not mutable_key_fields[0].strip()
                or mutable_key_fields[0] not in composite_unique_key
            ):
                raise ContractError(
                    f"{label}.composite_key_cas.mutable_key_fields must contain "
                    "exactly one field from the table unique_key"
                )
            snapshot_fields = composite_key_cas.get("snapshot_fields")
            if (
                not isinstance(snapshot_fields, list)
                or not snapshot_fields
                or len(set(snapshot_fields)) != len(snapshot_fields)
                or not all(isinstance(value, str) and value.strip() for value in snapshot_fields)
                or set(snapshot_fields) != field_names
            ):
                raise ContractError(
                    f"{label}.composite_key_cas.snapshot_fields must exactly list "
                    "all table fields"
                )
            if set(normalized["expected_fields"]) != set(snapshot_fields):
                raise ContractError(
                    f"{label}.expected_fields must exactly match "
                    "composite_key_cas.snapshot_fields"
                )
            mutable_key_field = mutable_key_fields[0]
            immutable_key_fields = set(composite_unique_key) - {mutable_key_field}
            if writable_fields.intersection(immutable_key_fields):
                raise ContractError(
                    f"{label}.writable_fields cannot patch immutable composite-key fields: "
                    f"{sorted(writable_fields.intersection(immutable_key_fields))}"
                )
            if mutable_key_field not in writable_fields:
                raise ContractError(
                    f"{label}.writable_fields must include the mutable composite-key field: "
                    f"{mutable_key_field}"
                )
            if rule.get("empty_expected_only") is True:
                raise ContractError(
                    f"{label}.empty_expected_only cannot be combined with composite_key_cas"
                )
            if rule.get("verify_fields") is not None or rule.get("verify_fields_exact") is True:
                raise ContractError(
                    f"{label}.composite_key_cas derives exact post-state from the full "
                    "snapshot; remove verify_fields/verify_fields_exact"
                )

        expected_fields_subset_allowed = rule.get("expected_fields_subset_allowed")
        if expected_fields_subset_allowed is not None:
            if op != "bitable_record_update_if_current":
                raise ContractError(
                    f"{label}.expected_fields_subset_allowed is only supported for "
                    "bitable_record_update_if_current"
                )
            if not isinstance(expected_fields_subset_allowed, bool):
                raise ContractError(
                    f"{label}.expected_fields_subset_allowed must be boolean"
                )
            if expected_fields_subset_allowed and rule.get("verify_fields_exact") is True:
                raise ContractError(
                    f"{label}.expected_fields_subset_allowed cannot be combined with "
                    "verify_fields_exact"
                )
        if (
            not is_exact_separated_record_update_rule(rule)
            and not expected_fields_subset_allowed
            and not writable_fields <= expected_fields
        ):
            raise ContractError(
                f"{label}.expected_fields must include every writable field"
            )

        client_key_pattern = rule.get("client_key_pattern")
        if client_key_pattern is not None:
            if op != "bitable_record_update_if_current":
                raise ContractError(
                    f"{label}.client_key_pattern is only supported for "
                    "bitable_record_update_if_current"
                )
            if not isinstance(client_key_pattern, str) or not client_key_pattern.strip():
                raise ContractError(f"{label}.client_key_pattern must be a non-empty string")
            try:
                re.compile(client_key_pattern)
            except re.error as exc:
                raise ContractError(
                    f"{label}.client_key_pattern must be a valid regular expression"
                ) from exc

        empty_expected_only = rule.get("empty_expected_only")
        if empty_expected_only is not None:
            if op != "bitable_record_update_if_current":
                raise ContractError(
                    f"{label}.empty_expected_only is only supported for "
                    "bitable_record_update_if_current"
                )
            if not isinstance(empty_expected_only, bool):
                raise ContractError(f"{label}.empty_expected_only must be boolean")
            if empty_expected_only:
                unsupported = sorted(
                    field for field in writable_fields
                    if fields_by_name[field].type not in {"text", "single_select", "checkbox"}
                )
                if unsupported:
                    raise ContractError(
                        f"{label}.empty_expected_only only supports text, single_select, "
                        "or checkbox writable fields: " + ", ".join(unsupported)
                    )

        verify_fields = rule.get("verify_fields")
        if verify_fields is not None:
            if not isinstance(verify_fields, list) or not verify_fields or not all(
                isinstance(value, str) and value.strip() for value in verify_fields
            ):
                raise ContractError(f"{label}.verify_fields must be a non-empty string list")
            if len(set(verify_fields)) != len(verify_fields):
                raise ContractError(f"{label}.verify_fields must not contain duplicates")
            unknown_verify_fields = set(verify_fields) - field_names
            if unknown_verify_fields:
                raise ContractError(
                    f"{label}.verify_fields references fields not found in the table contract: "
                    f"{', '.join(sorted(unknown_verify_fields))}"
                )
        if expected_fields_subset_allowed and verify_fields is None:
            raise ContractError(
                f"{label}.verify_fields is required when expected_fields_subset_allowed is true"
            )

        verify_fields_exact = rule.get("verify_fields_exact")
        if verify_fields_exact is not None:
            if op != "bitable_record_update_if_current":
                raise ContractError(
                    f"{label}.verify_fields_exact is only supported for bitable_record_update_if_current"
                )
            if not isinstance(verify_fields_exact, bool):
                raise ContractError(f"{label}.verify_fields_exact must be boolean")
            if verify_fields_exact and verify_fields is None:
                raise ContractError(
                    f"{label}.verify_fields_exact requires verify_fields"
                )

        if is_exact_separated_record_update_rule(rule):
            if set(verify_fields or []) != writable_fields:
                raise ContractError(
                    f"{label}.verify_fields must exactly match writable_fields "
                    "for an exact separated CAS rule"
                )
        elif verify_fields is not None and not writable_fields <= set(verify_fields):
            raise ContractError(
                f"{label}.verify_fields must include every writable field"
            )

        record_bindings = rule.get("record_bindings")
        if record_bindings is not None:
            if op != "bitable_record_update_if_current":
                raise ContractError(
                    f"{label}.record_bindings is only supported for "
                    "bitable_record_update_if_current"
                )
            if (
                not isinstance(record_bindings, list)
                or not record_bindings
                or not all(isinstance(binding, dict) for binding in record_bindings)
            ):
                raise ContractError(
                    f"{label}.record_bindings must be a non-empty object list"
                )
            field_ids = {
                str(field_name): str(field_id)
                for field_name, field_id in (asset.field_ids or {}).items()
                if (
                    isinstance(field_name, str)
                    and isinstance(field_id, str)
                    and field_id.strip()
                )
            }
            id_to_name = {field_id: field_name for field_name, field_id in field_ids.items()}
            if len(id_to_name) != len(field_ids):
                raise ContractError(
                    f"{label}.record_bindings requires unique asset field_ids"
                )
            if not field_ids or set(field_ids) != field_names:
                raise ContractError(
                    f"{label}.record_bindings requires complete asset field_ids"
                )
            if not isinstance(verify_fields, list) or set(verify_fields) != writable_fields:
                raise ContractError(
                    f"{label}.record_bindings requires verify_fields to exactly match writable_fields"
                )
            seen_record_ids: set[str] = set()
            for binding_index, binding in enumerate(record_bindings):
                binding_label = f"{label}.record_bindings[{binding_index}]"
                if set(binding) != {
                    "record_id", "immutable_expected_fields", "allowed_patch_values",
                }:
                    raise ContractError(
                        f"{binding_label} must contain only record_id, "
                        "immutable_expected_fields, and allowed_patch_values"
                    )
                record_id = binding.get("record_id")
                if not isinstance(record_id, str) or not record_id.strip():
                    raise ContractError(f"{binding_label}.record_id must be non-empty")
                if record_id in seen_record_ids:
                    raise ContractError(
                        f"{label}.record_bindings record_id must be unique: {record_id}"
                    )
                seen_record_ids.add(record_id)
                immutable = binding["immutable_expected_fields"]
                allowed = binding["allowed_patch_values"]
                if not isinstance(immutable, dict) or not immutable:
                    raise ContractError(
                        f"{binding_label}.immutable_expected_fields must be a non-empty object"
                    )
                if not isinstance(allowed, dict) or not allowed:
                    raise ContractError(
                        f"{binding_label}.allowed_patch_values must be a non-empty object"
                    )
                for field_id, value in immutable.items():
                    if field_id not in id_to_name:
                        raise ContractError(
                            f"{binding_label}.immutable_expected_fields references an unknown field_id: {field_id}"
                        )
                for field_id, values in allowed.items():
                    if field_id not in id_to_name:
                        raise ContractError(
                            f"{binding_label}.allowed_patch_values references an unknown field_id: {field_id}"
                        )
                    if not isinstance(values, list) or not values:
                        raise ContractError(
                            f"{binding_label}.allowed_patch_values[{field_id}] must be a non-empty list"
                        )
                immutable_names = {id_to_name[field_id] for field_id in immutable}
                allowed_names = {id_to_name[field_id] for field_id in allowed}
                if immutable_names != expected_fields:
                    raise ContractError(
                        f"{binding_label}.immutable_expected_fields field_ids must exactly map to expected_fields"
                    )
                if allowed_names != writable_fields:
                    raise ContractError(
                        f"{binding_label}.allowed_patch_values field_ids must exactly map to writable_fields"
                    )
        allowed_statuses = rule.get("allowed_statuses")
        if allowed_statuses is not None and (
            not isinstance(allowed_statuses, list)
            or not allowed_statuses
            or not all(isinstance(value, str) and value.strip() for value in allowed_statuses)
        ):
            raise ContractError(f"{label}.allowed_statuses must be a non-empty string list")

        protection = rule.get("marker_line_protection")
        if protection is not None:
            if not isinstance(protection, dict):
                raise ContractError(f"{label}.marker_line_protection must be an object")
            field = protection.get("field")
            if not isinstance(field, str) or not field.strip():
                raise ContractError(f"{label}.marker_line_protection.field is required")
            if field not in writable_fields or field not in expected_fields:
                raise ContractError(
                    f"{label}.marker_line_protection.field must be writable and expected"
                )
            if fields_by_name[field].type != "text":
                raise ContractError(
                    f"{label}.marker_line_protection.field must be a text field"
                )
            markers = protection.get("markers")
            if (
                not isinstance(markers, list)
                or not markers
                or not all(isinstance(marker, str) and _MARKER_LINE_RE.fullmatch(marker)
                           for marker in markers)
                or not set(markers) <= set(MARKER_LINE_NAMESPACES)
                or len(set(markers)) != len(markers)
            ):
                raise ContractError(
                    f"{label}.marker_line_protection.markers must be unique supported marker namespaces"
                )
            if protection.get("preserve_non_marker_lines") is not True:
                raise ContractError(
                    f"{label}.marker_line_protection.preserve_non_marker_lines must be true"
                )
            if protection.get("max_lines_per_marker") != 1:
                raise ContractError(
                    f"{label}.marker_line_protection.max_lines_per_marker must be 1"
                )

    for earlier_index, earlier in enumerate(rules):
        earlier_writable = set(earlier.get("writable_fields") or [])
        earlier_callers = set(earlier.get("caller_sessions") or [])
        earlier_key_pattern = earlier.get("client_key_pattern")
        for later_index, later in enumerate(rules[earlier_index + 1:], earlier_index + 1):
            if earlier.get("op") != later.get("op"):
                continue
            if not earlier_callers.intersection(later.get("caller_sessions") or []):
                continue
            # A keyed earlier rule does not shadow an unkeyed later rule outside
            # that key's scope.  Identical patterns do share a scope and retain
            # the original fail-closed ordering check.
            later_key_pattern = later.get("client_key_pattern")
            if (
                earlier_key_pattern is not None
                and earlier_key_pattern != later_key_pattern
            ):
                continue
            if earlier.get("op") == "bitable_attachment_upload":
                # The attachment field is the selector. Rules for different
                # fields under one caller are valid and must not be treated as
                # a shadowing pair merely because neither has writable_fields.
                if earlier.get("field") != later.get("field"):
                    continue
            elif earlier.get("op") == "bitable_rows_replace":
                # The delete guard is the selector for replace rules; distinct
                # guarded batches are not overlapping grants.
                if earlier.get("delete_guard") != later.get("delete_guard"):
                    continue
            elif earlier.get("op") == "bitable_record_delete_if_current":
                if earlier.get("dedupe_key") == later.get("dedupe_key"):
                    raise ContractError(
                        "controlled_data_time_updates"
                        f"[{later_index}] reuses exact-delete dedupe_key from [{earlier_index}]"
                    )
                earlier_ids = {
                    binding.get("record_id")
                    for binding in earlier.get("delete_bindings") or []
                    if isinstance(binding, dict)
                }
                later_ids = {
                    binding.get("record_id")
                    for binding in later.get("delete_bindings") or []
                    if isinstance(binding, dict)
                }
                if earlier_ids.isdisjoint(later_ids):
                    continue
                raise ContractError(
                    "controlled_data_time_updates"
                    f"[{later_index}] overlaps delete bindings in [{earlier_index}]"
                )
            if set(later.get("writable_fields") or []) <= earlier_writable:
                raise ContractError(
                    "controlled_data_time_updates"
                    f"[{later_index}] is shadowed by [{earlier_index}]; "
                    "narrow writable rules must precede broader rules"
                )


def validate_asset_contract(
    asset: AssetContract, *, pre_create: bool = False,
    template_name_exemption: bool = False,
    approved_non_chinese_names: frozenset[str] | None = None,
) -> None:
    """pre_create=True：建表前校验，容忍 base_token/access_url 为空（由创建产生），其余结构照常校验。

    template_name_exemption 仅在 clone_template 建姊妹表时置 True，透传给 validate_table 放行
    已批准模板里的既批非中文字段名（见 validate_table 文档）；approved_non_chinese_names
    是 registry 证据白名单（已发布合同里批准过的非中文名），由 provision 层扫描生成后透传。
    """
    _require(asset.asset_id, "asset_id")
    _require(asset.owner_session, "owner_session")
    _require(asset.object_type, "object_type")
    _require(asset.title, "title")
    _require(asset.business_problem, "business_problem")
    _require(asset.asset_category, "asset_category")
    _require(asset.placement_reason, "placement_reason")
    if not pre_create:
        _require(asset.access_url, "access_url")
    _require_choice(asset.object_type, "object_type", _OBJECT_TYPES)
    _require_choice(asset.asset_category, "asset_category", _ASSET_CATEGORIES)
    _require_choice(asset.authority_model, "authority_model", _AUTHORITY_MODELS)
    _require_choice(asset.sync_direction, "sync_direction", _SYNC_DIRECTIONS)
    if asset.authority_model == "derived_projection":
        if asset.sync_direction != "none":
            raise ContractError(
                "derived_projection requires sync_direction=none"
            )
        writable_fields = [
            field.name_zh
            for table in asset.tables
            for field in table.fields
            if field.authority != "readonly"
        ]
        if writable_fields:
            raise ContractError(
                "derived_projection fields must be readonly: "
                + ", ".join(writable_fields)
            )
        if asset.controlled_data_time_updates:
            raise ContractError(
                "derived_projection forbids controlled data-time updates"
            )
    _require_choice(
        asset.queue_pending_policy,
        "queue_pending_policy",
        {"fifo", "latest_by_unique_key"},
    )
    if asset.queue_pending_policy == "latest_by_unique_key":
        if asset.sync_direction != "local_to_remote":
            raise ContractError(
                "queue_pending_policy=latest_by_unique_key requires local_to_remote"
            )
        if len(asset.tables) != 1 or not asset.tables[0].unique_key:
            raise ContractError(
                "queue_pending_policy=latest_by_unique_key requires one table with unique_key"
            )
    if (
        asset.surface_in_session_menu is not None
        and not isinstance(asset.surface_in_session_menu, bool)
    ):
        raise ContractError("surface_in_session_menu must be boolean")
    if asset.session_menu_label is not None:
        if (
            not isinstance(asset.session_menu_label, str)
            or not asset.session_menu_label.strip()
            or not _has_chinese(asset.session_menu_label)
        ):
            raise ContractError(
                "session_menu_label must be a non-empty Chinese string"
            )
    if (
        pre_create
        and asset.object_type == "table"
        and asset.authority_model == "derived_mirror"
        and asset.surface_in_session_menu is None
    ):
        raise ContractError(
            "surface_in_session_menu is required for new derived_mirror table"
        )
    if not _has_chinese(asset.business_problem):
        raise ContractError("business_problem must contain Chinese")
    if not _has_chinese(asset.placement_reason):
        raise ContractError("placement_reason must contain Chinese")
    if not asset.parent_ref.strip():
        raise ContractError("parent_ref is required")
    if asset.parent_ref.strip() in _PERSONAL_SPACE_MARKERS:
        raise ContractError("parent_ref must not point to personal space")
    if not asset.feishu_path:
        raise ContractError("feishu_path is required")
    for segment in asset.feishu_path:
        if not segment.strip():
            raise ContractError("feishu_path segment must not be blank")
        if segment.strip() in _PERSONAL_SPACE_MARKERS:
            raise ContractError("feishu_path must not point to personal space")
    allowed_prefixes = list(_CATEGORY_PATH_PREFIXES[asset.asset_category])
    managed_prefix = managed_parent_path_prefix(
        asset.parent_ref, asset.asset_category,
    )
    if managed_prefix is not None:
        allowed_prefixes.append(list(managed_prefix))
        if len(asset.feishu_path) <= len(managed_prefix):
            raise ContractError(
                "managed Drive feishu_path must include an asset title after the root prefix"
            )
        if asset.feishu_path[-1] != asset.title:
            raise ContractError(
                "managed Drive feishu_path must end with asset title"
            )
    if not any(asset.feishu_path[:len(prefix)] == prefix for prefix in allowed_prefixes):
        expected = " or ".join(" / ".join(prefix) for prefix in allowed_prefixes)
        raise ContractError(
            "feishu_path prefix does not match asset_category "
            f"{asset.asset_category}: expected {expected}"
        )
    if asset.object_type == "table":
        if not asset.base_token and not pre_create:
            raise ContractError("base_token is required for table")
        if not asset.tables:
            raise ContractError("tables are required for table")
    for table in asset.tables:
        validate_table(
            table, strict=pre_create,
            template_name_exemption=template_name_exemption,
            approved_non_chinese_names=approved_non_chinese_names,
        )
    _validate_controlled_data_time_updates(asset)
    _validate_migration_write_exception(asset)
    _validate_migration_write_exceptions(asset)
    _validate_migration_restore_exception(asset)
