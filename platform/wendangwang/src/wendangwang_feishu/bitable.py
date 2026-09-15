from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .lark_cli import LarkCli, LarkCliError
from .models import AssetContract, TableContract
from .observability import feishu_number_equal, observe_key, receipt_tags
from .validation import (
    MARKER_LINE_NAMESPACES,
    controlled_update_client_key_matches,
    is_exact_separated_record_update_rule,
    validate_asset_contract,
)


# lark-cli base +record-upload-attachment help: max 2GB each; Feishu upload_all is
# 20MB, and this CLI switches files >20MB to multipart automatically.
ATTACHMENT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
_MARKER_LINE_TAIL_TOKEN_RE = re.compile(
    "〔(?P<marker>(?P<namespace>"
    + "|".join(re.escape(namespace) for namespace in MARKER_LINE_NAMESPACES)
    + r"):(?P<identity>[^〔〕\r\n]+))〕$"
)
_CREATE_IF_ABSENT_LOCK_ROOT = (
    Path(__file__).resolve().parents[2] / "data" / "create-if-absent-locks"
)
_FEISHU_DISPLAY_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


def _normalize_field_type(value: Any) -> str:
    """把类型标识归一化后再比对，吸收 lark field-list 的表示差异
    （single_select vs select、date_time vs datetime、大小写）。"""
    return str(value or "").strip().lower().replace("_", "")



def _field_authority(asset: AssetContract) -> dict[str, str]:
    if not asset.tables:
        return {}
    return {field.name_zh: field.authority for field in asset.tables[0].fields}


def resolve_migration_write_grant(
    asset: AssetContract, *, op: str, caller_session: str, client_key: str | None
) -> set[str]:
    """一次性迁移例外授予的『额外可写 feishu 权威字段』集合。

    仅当合同显式声明 migration_write_exception 且本次写入的 op / caller / dedupe-key 前缀
    三者全部精确匹配时才非空；相近前缀、其他 caller、其他 op、缺省声明、空 key 一律返回空集，
    退回日常字段级权威闸。是否越到未声明字段（其他字段隔离）由字段级闸按本集合逐字段裁决。
    本函数不做消耗判定（消耗是 queue DB 侧状态，见 sync_queue.migration_exception_consumer）。"""
    exc = getattr(asset, "migration_write_exception", None)
    if not isinstance(exc, dict):
        entry = resolve_migration_write_exception(
            asset, op=op, caller_session=caller_session, client_key=client_key
        )
        return {
            str(name) for name in (entry.get("additional_writable_fields") or [])
        } if entry else set()
    if op == exc.get("op") and caller_session == exc.get("caller_session"):
        prefix = exc.get("client_key_prefix")
        if isinstance(prefix, str) and prefix and client_key and str(client_key).startswith(prefix):
            return {str(name) for name in (exc.get("additional_writable_fields") or [])}
    entry = resolve_migration_write_exception(
        asset, op=op, caller_session=caller_session, client_key=client_key
    )
    return {
        str(name) for name in (entry.get("additional_writable_fields") or [])
    } if entry else set()


def resolve_migration_write_exception(
    asset: AssetContract, *, op: str, caller_session: str, client_key: str | None
) -> dict | None:
    """Return the matching entry from the multi-entry one-shot exception contract."""
    for exc in getattr(asset, "migration_write_exceptions", []) or []:
        if not isinstance(exc, dict):
            continue
        if op != exc.get("op") or caller_session != exc.get("caller_session"):
            continue
        prefix = exc.get("client_key_prefix")
        if isinstance(prefix, str) and prefix and client_key and str(client_key).startswith(prefix):
            return exc
    return None


def enforce_migration_write_upsert_shape(
    asset: AssetContract, rows: Any, grant_fields: set[str],
    exception: dict | None = None,
    label: str = "migration_write_exception",
) -> set[str]:
    """迁移写入例外的 upsert 单行形状闸（单 key 消耗式 upsert 的核心安全约束）。

    grant_fields 为空（非例外写入 / 未命中 op/caller/key）→ 直接返回空集，不约束日常 upsert。
    命中授予时机械保证「一把匹配 key 不写多行、不写非授权字段、不改非指定既有 record」：
    - payload 必须恰为 1 行（多行 / 0 行一律拒）——单 key 消耗只允许改这一条既有 record；
    - 该行字段必须恰为 唯一键 ∪ grant_fields，多带任何列（含 local 列或其他 feishu 列）或缺列
      一律拒，形状精确锁死改动面；
    - 该行的唯一键『值』必须恰为合同 migration_write_exception.target_unique_key（精确 locator）——
      字段集对了还不够，任一唯一键值不符即拒，把改动面钉死到用户指定的那一条既有 record（而非任一
      相近前缀 key 可命中的 accepted 行）。validator 保证 upsert 例外必带 target_unique_key。
    返回被授 feishu 字段集（== grant_fields），供 bitable_upsert_plan(migration_grant_fields=)
    放行字段级权威闸。违反 raise ValueError（入队机械校验拒 / drain terminal failed）。

    与 replace 变体（set 收敛，孤儿删除由 max_delete/delete_guard 兜底）语义不同：upsert 无删除
    授权，故这里用「单行 + 精确形状」把改动面收窄到恰好一条记录的授权列。多行 campaign 走
    migration_restore_exception（多 key、无单 key 消耗、形状=唯一键∪writable_fields）。"""
    if not grant_fields:
        return set()
    if not asset.tables:
        raise ValueError("asset has no table contract")
    rows_list = rows if isinstance(rows, list) else None
    if rows_list is None or len(rows_list) != 1:
        raise ValueError(
            "migration_write_exception bitable_rows_upsert must carry exactly one row "
            "(single-key consumption grants a one-shot correction of one existing record): "
            f"got {len(rows_list) if rows_list is not None else rows!r}")
    required = set(asset.tables[0].unique_key) | set(grant_fields)
    row = rows_list[0]
    actual = set(row) if isinstance(row, dict) else None
    if actual != required:
        raise ValueError(
            "migration_write_exception bitable_rows_upsert row fields must be exactly "
            f"{sorted(required)}: got {sorted(actual) if actual is not None else row!r}")
    # 精确 locator（安全补强）：字段集对了还不够——唯一键『值』必须恰为合同 target_unique_key，
    # 否则相近前缀的一把 key 可写任一 accepted 行。此闸在派发/消耗之前（enqueue + drain 双闸），故
    # 值不符的 key 在入队前和 drain 时均被拒、绝不落表也绝不消耗例外。validator 保证 upsert 例外必带
    # target_unique_key；此处对缺失做 fail-safe（宁拒不放）。按 str 归一化比对（唯一键是业务标识串）。
    exc = exception if isinstance(exception, dict) else (
        getattr(asset, "migration_write_exception", None) or {}
    )
    target = exc.get("target_unique_key")
    if not isinstance(target, dict) or not target:
        raise ValueError(
            f"{label} bitable_rows_upsert requires target_unique_key to pin the "
            "exact record (contract is missing target_unique_key)")
    want_uk = {str(k): ("" if v is None else str(v)) for k, v in target.items()}
    actual_uk = {
        str(k): ("" if row.get(k) is None else str(row.get(k)))
        for k in asset.tables[0].unique_key
    }
    if actual_uk != want_uk:
        raise ValueError(
            f"{label} bitable_rows_upsert row unique key must be exactly "
            f"{want_uk}: got {actual_uk}")
    expected_row = exc.get("expected_row")
    if label == "migration_write_exceptions" and not isinstance(expected_row, dict):
        raise ValueError(
            f"{label} bitable_rows_upsert requires expected_row in contract"
        )
    if expected_row is not None and row != expected_row:
        raise ValueError(
            f"{label} bitable_rows_upsert row values must exactly match expected_row: "
            f"{expected_row!r}: got {row!r}")
    return set(grant_fields)


def resolve_migration_restore_grant(
    asset: AssetContract, *, op: str, caller_session: str, client_key: str | None
) -> dict | None:
    """第二类一次性恢复例外（migration_restore_exception）按 op 解析授予配置。

    仅当合同声明该块、caller / dedupe-key 前缀精确匹配、且本 op 在块内声明时才返回该 op 的
    配置 dict（upsert → {"writable_fields": [...]}；attachment_upload → {"field": ...}）；
    相近前缀 / 其他 caller / 其他 op / 未声明该 op / 空 key 一律返回 None。前缀必须以 ':' 收尾
    （validator 强制），startswith 借此挡住相近前缀（含旧 migration_write_exception 的 key）。
    与 resolve_migration_write_grant 独立：两块按各自 client_key_prefix 互相隔离。
    本函数只解析、不施加形状闸（形状校验见 migration_restore_upsert_grant /
    check_migration_restore_attachment），也不做消耗判定（本例外按设计不做单 key 消耗）。"""
    exc = getattr(asset, "migration_restore_exception", None)
    if not isinstance(exc, dict):
        return None
    if caller_session != exc.get("caller_session"):
        return None
    prefix = exc.get("client_key_prefix")
    if not isinstance(prefix, str) or not prefix or not client_key:
        return None
    if not str(client_key).startswith(prefix):
        return None
    if op == "bitable_rows_upsert" and isinstance(exc.get("upsert"), dict):
        return dict(exc["upsert"])
    if op == "bitable_attachment_upload" and isinstance(exc.get("attachment_upload"), dict):
        return dict(exc["attachment_upload"])
    return None


def _canon_uk_tuple(mapping: Any, unique_key: list[str]) -> tuple[str, ...]:
    """把一条记录的唯一键『值』归一化成有序字符串元组，供 pin 命中判定。

    与 enforce_migration_write_upsert_shape 的 target_unique_key 比对同一套归一化
    （None→""、其余 str()），保证 pin 声明值与 payload 值按同一口径比较。"""
    get = mapping.get if isinstance(mapping, dict) else (lambda _k: None)
    return tuple("" if get(k) is None else str(get(k)) for k in unique_key)


def _restore_target_pin(asset: AssetContract, unique_key: list[str]) -> set[tuple[str, ...]]:
    """恢复例外的目标记录身份 pin：合同 migration_restore_exception.target_unique_keys 声明的
    「本 campaign 只许触碰这几条既有 record」的完整唯一键值元组集合。

    fail-closed 是安全核心：命中授予（caller+前缀+op 全对）后**必须**有本 pin，缺失 / 非法一律
    raise ValueError（入队机械拒 / drain terminal failed），绝不退回「无 pin＝随便写」。这样堵住
    与 migration_write_exception upsert 同类的目标记录身份漏洞——旧块只声明 caller/前缀/可写列、
    不含具体 record 值，一把匹配 key 可对任一 tuple upsert、甚至新建行。

    要求 target_unique_keys 为非空 list，每条是 dict 且键集恰为合同唯一键；否则视作缺失/非法
    （宁拒不放）。返回归一化元组集合，供 upsert 逐行、attachment 逐次上传做「值必须命中其一」判定。"""
    exc = getattr(asset, "migration_restore_exception", None) or {}
    targets = exc.get("target_unique_keys")
    if not isinstance(targets, list) or not targets:
        raise ValueError(
            "migration_restore_exception requires target_unique_keys to pin the exact "
            "record(s) the campaign may touch (contract is missing target_unique_keys); "
            "refusing to grant a restore write with no record-identity pin")
    pin: set[tuple[str, ...]] = set()
    for entry in targets:
        if not isinstance(entry, dict) or set(entry) != set(unique_key):
            raise ValueError(
                "migration_restore_exception target_unique_keys entry keys must be exactly "
                f"the contract unique_key {sorted(unique_key)}: got "
                f"{sorted(entry) if isinstance(entry, dict) else entry!r}")
        pin.add(_canon_uk_tuple(entry, unique_key))
    return pin


def migration_restore_upsert_grant(
    asset: AssetContract, rows: Any, *, caller_session: str, client_key: str | None
) -> set[str]:
    """恢复例外的 upsert 授予：命中(caller+key前缀+op)则校验每行字段恰为
    唯一键 ∪ writable_fields 并返回被授 feishu 字段集；未命中返回空集（不约束日常 upsert）。

    形状精确闸是「不放开日常写入」的核心：日常 payload 会带 MSKU/ASIN/价格 等多列，形状与
    {唯一键, 产品运营状态} 不同，绝不会命中；命中的恢复行也只许带唯一键 + 被授列，多带（含
    local 列或其他 feishu 列）一律拒。返回的字段集喂给 bitable_upsert_plan(migration_grant_
    fields=) 放行 feishu 权威闸。"""
    grant = resolve_migration_restore_grant(
        asset, op="bitable_rows_upsert",
        caller_session=caller_session, client_key=client_key)
    if grant is None:
        return set()
    if not asset.tables:
        raise ValueError("asset has no table contract")
    table = asset.tables[0]
    writable = {str(name) for name in (grant.get("writable_fields") or [])}
    required = set(table.unique_key) | writable
    # 目标记录身份 pin（fail-closed）：命中授予后，每一行的唯一键『值』必须命中合同
    # target_unique_keys 里声明的既有 record 之一；否则拒——既不改任一别的 tuple，也不 upsert
    # 出新行。缺 pin 的旧块在此 raise（不授予）。此闸在入队与 drain 双序调用（见 cli / sync_drain）。
    pin = _restore_target_pin(asset, table.unique_key)
    for row in rows if isinstance(rows, list) else []:
        actual = set(row) if isinstance(row, dict) else None
        if actual != required:
            raise ValueError(
                "migration_restore_exception bitable_rows_upsert row fields must be exactly "
                f"{sorted(required)}: got {sorted(actual) if actual is not None else row!r}"
            )
        got = _canon_uk_tuple(row, table.unique_key)
        if got not in pin:
            raise ValueError(
                "migration_restore_exception bitable_rows_upsert row unique key must pin one of "
                f"target_unique_keys {sorted(pin)}: got {list(got)}")
    return writable


def _restore_attachment_guarded_field(asset: AssetContract) -> str | None:
    """资产若声明了 migration_restore_exception.attachment_upload，返回其被守附件列名，否则 None。
    与 caller/key 无关——仅表达「本资产哪一列受恢复例外守护」，供 fail-closed 判定用。"""
    exc = getattr(asset, "migration_restore_exception", None)
    if not isinstance(exc, dict):
        return None
    attach = exc.get("attachment_upload")
    if not isinstance(attach, dict):
        return None
    field = attach.get("field")
    return field if isinstance(field, str) and field else None


def check_migration_restore_attachment(
    asset: AssetContract, *, field: Any, unique_key_values: Any,
    caller_session: str, client_key: str | None,
) -> bool:
    """恢复例外的附件上传闸（asset-scoped fail-closed）。

    一旦合同为某附件列声明 attachment_upload，那一列即「restore-guarded」：**任何**打向它的上传
    都必须 caller=声明 owner、client_key 命中声明前缀、field 恰为该列、unique_key 恰为合同唯一键，
    满足返回 True、否则 raise ValueError（入队与 drain 同序拒）。这样堵住授权缺口——旧行为在
    caller/key 不匹配时返回 False 放行日常上传，而 bitable_attachment_upload 只校验 caller==owner、
    不校验 authority，于是 owner 可用任意非本前缀 key 覆盖该 feishu 列。

    未命中守护的上传返回 False（不约束、维持既有语义），仅两种：本资产没声明该块 / 本次 field 不是
    被守列且无匹配的 restore 授予。据此保证「无恢复块的资产」与「本资产其他附件列」零回归、不波及
    其他资产 owner 的写入。"""
    grant = resolve_migration_restore_grant(
        asset, op="bitable_attachment_upload",
        caller_session=caller_session, client_key=client_key)
    guarded_field = _restore_attachment_guarded_field(asset)
    if grant is not None:
        # caller+前缀+op 全对（合法 restore 请求）：field 必须恰为被守列、unique_key 恰为合同唯一键。
        if not asset.tables:
            raise ValueError("asset has no table contract")
        table = asset.tables[0]
        allowed_field = grant.get("field")
        if field != allowed_field:
            raise ValueError(
                f"migration_restore_exception attachment field must be exactly "
                f"{allowed_field}: got {field!r}")
        keys = set(unique_key_values) if isinstance(unique_key_values, dict) else set()
        if keys != set(table.unique_key):
            raise ValueError(
                f"migration_restore_exception attachment unique_key must be exactly "
                f"{sorted(table.unique_key)}: got {sorted(keys)}")
        # 目标记录身份 pin（fail-closed）：唯一键『值』必须命中 target_unique_keys 之一，否则拒——
        # 附件只补到用户列出的既有 record，不落到任一别的 record。缺 pin 的旧块在此 raise。
        pin = _restore_target_pin(asset, table.unique_key)
        got = _canon_uk_tuple(unique_key_values, table.unique_key)
        if got not in pin:
            raise ValueError(
                "migration_restore_exception attachment unique key must pin one of "
                f"target_unique_keys {sorted(pin)}: got {list(got)}")
        return True
    # grant 为 None（无块 / 错 caller / 错前缀 / 空 key）。授权缺口修复的核心：若本次恰好打向
    # 被守列 → fail-closed 拒（不能像旧行为那样返回 False 放行日常上传）；打向其他列 / 无块 →
    # 返回 False 维持既有语义。
    if guarded_field is not None and field == guarded_field:
        exc = asset.migration_restore_exception or {}
        raise ValueError(
            f"migration_restore_exception attachment field {guarded_field!r} is "
            f"restore-guarded: uploads require caller={exc.get('caller_session')!r} with "
            f"client_key prefix {exc.get('client_key_prefix')!r}; refusing "
            f"caller={caller_session!r} client_key={client_key!r}")
    return False


def _controlled_attachment_grant(
    asset: AssetContract, *, caller_session: str, field: str | None = None,
) -> dict | None:
    """受控附件上传规则解析：从 controlled_data_time_updates 找 op=bitable_attachment_upload
    且 caller_session 命中的规则，返回规则 dict；无命中返回 None。只解析不施加形状闸
    （形状校验见 check_controlled_attachment_upload）。"""
    candidates = []
    for rule in asset.controlled_data_time_updates:
        if not isinstance(rule, dict) or rule.get("op") != "bitable_attachment_upload":
            continue
        callers = rule.get("caller_sessions")
        if not isinstance(callers, list) or caller_session not in callers:
            continue
        if field is not None and rule.get("field") != field:
            continue
        candidates.append(rule)
    if len(candidates) > 1:
        raise ValueError(
            "overlapping controlled bitable_attachment_upload rules: "
            f"caller_session={caller_session} field={field!r}"
        )
    return candidates[0] if candidates else None


def _controlled_rows_update_existing_grant(
    asset: AssetContract, *, caller_session: str,
    patch_fields: set[str] | None = None,
) -> dict | None:
    """Return the caller-scoped existing-row rule, if one is declared."""
    candidates = []
    for rule in asset.controlled_data_time_updates:
        if not isinstance(rule, dict) or rule.get("op") != "bitable_rows_update_existing":
            continue
        if caller_session in (rule.get("caller_sessions") or []):
            if patch_fields is None or patch_fields <= set(rule.get("writable_fields") or []):
                candidates.append(rule)
    if not candidates:
        return None
    if patch_fields is not None:
        smallest = min(len(set(rule.get("writable_fields") or [])) for rule in candidates)
        candidates = [
            rule for rule in candidates
            if len(set(rule.get("writable_fields") or [])) == smallest
        ]
    if len(candidates) > 1:
        raise ValueError(
            "overlapping controlled bitable_rows_update_existing rules: "
            f"caller_session={caller_session} fields={sorted(patch_fields or set())}"
        )
    return candidates[0]


def _enforce_controlled_row_scope(
    rule: dict[str, Any], record_fields: dict[str, Any], *, required: bool = False,
) -> None:
    scope = rule.get("row_scope")
    if scope is None and not required:
        return
    if not isinstance(scope, dict):
        raise ValueError("controlled row update requires a row_scope")
    field = scope.get("field")
    value = record_fields.get(field)
    if set(scope) == {"field", "non_empty"}:
        if scope.get("non_empty") is not True:
            raise ValueError("controlled row update row_scope.non_empty must be true")
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"row scope field must be non-empty: {field}")
    elif set(scope) != {"field", "allowed_values"}:
        raise ValueError("controlled row update row_scope has an invalid shape")
    else:
        allowed_values = scope.get("allowed_values")
        if (
            not isinstance(allowed_values, list)
            or not allowed_values
            or len(set(allowed_values)) != len(allowed_values)
            or not all(isinstance(item, str) and item.strip() for item in allowed_values)
        ):
            raise ValueError("controlled row update row_scope.allowed_values is invalid")
        if not isinstance(value, str) or value not in allowed_values:
            raise ValueError(
                f"row scope field value is not in allowed values: {field}={value!r}"
            )
    for required_field in rule.get("required_non_empty_row_fields") or []:
        required_value = record_fields.get(required_field)
        if not isinstance(required_value, str) or not required_value.strip():
            raise ValueError(f"row scope field must be non-empty: {required_field}")


def _enforce_controlled_value_link_constraints(
    rule: dict[str, Any], row: dict[str, Any],
) -> None:
    for field, constraint in (rule.get("value_link") or {}).items():
        if field not in row:
            continue
        value = row[field]
        if value is None or value == "" or value == []:
            if constraint["allow_clear"]:
                continue
            raise ValueError(
                f"controlled update link field {field} does not allow clear"
            )
        if not isinstance(value, list):
            raise ValueError(
                f"controlled update link field {field} must be a list of record references"
            )
        if len(value) > constraint["max_targets"]:
            raise ValueError(
                f"controlled update link field {field} exceeds max_targets="
                f"{constraint['max_targets']}"
            )
        target_ids: list[str] = []
        for target in value:
            if isinstance(target, str):
                target_id = target
            elif isinstance(target, dict) and set(target) in ({"record_id"}, {"id"}):
                target_id = target.get("record_id") or target.get("id")
            else:
                raise ValueError(
                    f"controlled update link field {field} must contain record_id references"
                )
            if not isinstance(target_id, str) or not target_id.strip():
                raise ValueError(
                    f"controlled update link field {field} contains an empty record_id"
                )
            target_ids.append(target_id)
        if len(target_ids) != len(set(target_ids)):
            raise ValueError(
                f"controlled update link field {field} must not contain duplicate "
                "record_id references"
            )


def check_controlled_rows_update_existing(
    asset: AssetContract, *, caller_session: str,
    rows: list[dict[str, Any]],
) -> dict | None:
    """Validate the no-I/O half of the controlled existing-row gate."""
    validate_asset_contract(asset)
    if not asset.tables:
        raise ValueError("asset has no table contract")
    table = asset.tables[0]
    unique_key = set(table.unique_key)
    field_types = _field_types(asset, table)
    if not isinstance(rows, list) or not rows:
        raise ValueError("bitable_rows_update_existing requires a non-empty row list")
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("bitable_rows_update_existing rows must be objects")
    patch_fields = set().union(*(set(row) - unique_key for row in rows))
    rule = _controlled_rows_update_existing_grant(
        asset, caller_session=caller_session, patch_fields=patch_fields)
    if rule is None:
        if caller_session == asset.owner_session:
            return None
        caller_rules = [
            item for item in asset.controlled_data_time_updates
            if isinstance(item, dict)
            and item.get("op") == "bitable_rows_update_existing"
            and caller_session in (item.get("caller_sessions") or [])
        ]
        if caller_rules:
            raise ValueError(
                "controlled update row fields exceed writable_fields: "
                + ", ".join(sorted(patch_fields))
            )
        raise ValueError(
            f"caller_session {caller_session} cannot write asset owned by "
            f"{asset.owner_session} (no controlled bitable_rows_update_existing rule)"
        )
    writable = set(rule.get("writable_fields") or [])
    allowed_fields = unique_key | writable
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("bitable_rows_update_existing rows must be objects")
        missing = [field for field in table.unique_key if not row.get(field)]
        if missing:
            raise ValueError(f"missing unique key {missing[0]}")
        extra = sorted(set(row) - allowed_fields)
        if extra:
            raise ValueError(
                "controlled update row fields exceed writable_fields: "
                + ", ".join(extra)
            )
        for field, allowed_values in (rule.get("allowed_values") or {}).items():
            if field not in row:
                continue
            value = row[field]
            field_type = field_types.get(field, "")
            if field_type == "multi_select":
                value_allowed = (
                    isinstance(value, list)
                    and all(isinstance(item, str) and item.strip() for item in value)
                    and len(set(value)) == len(value)
                    and all(item in allowed_values for item in value)
                )
            else:
                value_allowed = value in allowed_values
            if not value_allowed:
                raise ValueError(
                    f"controlled update field {field} value is not in allowed values: "
                    f"{value!r}"
                )
        for field, pattern in (rule.get("value_regex") or {}).items():
            if field not in row:
                continue
            value = row[field]
            if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
                raise ValueError(
                    f"controlled update field {field} value does not match regex: "
                    f"{value!r}"
                )
        _enforce_controlled_value_link_constraints(rule, row)
    return rule


def check_controlled_attachment_upload(
    asset: AssetContract, *, field: Any, unique_key_values: Any,
    caller_session: str,
) -> bool:
    """受控附件上传闸（asset-scoped fail-closed，入队与 drain 同序调用）。

    owner 直接放行（既有语义：owner 可写本资产任意附件列）；非 owner 必须命中合同
    controlled_data_time_updates 里 op=bitable_attachment_upload 的规则：caller 在
    caller_sessions、field 恰为声明列、unique_key 键集恰为表唯一键，否则 raise ValueError
    （入队机械拒 / drain terminal failed）。"""
    if caller_session == asset.owner_session:
        return True
    grant = _controlled_attachment_grant(
        asset, caller_session=caller_session, field=field)
    if grant is None:
        caller_rules = [
            rule for rule in asset.controlled_data_time_updates
            if isinstance(rule, dict)
            and rule.get("op") == "bitable_attachment_upload"
            and caller_session in (rule.get("caller_sessions") or [])
        ]
        if len(caller_rules) == 1:
            raise ValueError(
                f"controlled attachment_upload field must be exactly "
                f"{caller_rules[0].get('field')}: got {field!r}"
            )
        if caller_rules:
            raise ValueError(
                "controlled attachment_upload field must be one of "
                f"{sorted(rule.get('field') for rule in caller_rules)}: got {field!r}"
            )
        raise ValueError(
            f"caller_session {caller_session} cannot write asset owned by "
            f"{asset.owner_session} (no controlled bitable_attachment_upload rule)")
    allowed_field = grant.get("field")
    if field != allowed_field:
        raise ValueError(
            f"controlled attachment_upload field must be exactly {allowed_field}: "
            f"got {field!r}")
    if not asset.tables:
        raise ValueError("asset has no table contract")
    keys = set(unique_key_values) if isinstance(unique_key_values, dict) else set()
    if keys != set(asset.tables[0].unique_key):
        raise ValueError(
            f"controlled attachment_upload unique_key must be exactly "
            f"{sorted(asset.tables[0].unique_key)}: got {sorted(keys)}")
    return True


def _controlled_replace_grant(
    asset: AssetContract, *, caller_session: str,
    delete_guard: dict[str, Any] | None = None,
) -> dict | None:
    """受控替换规则解析：从 controlled_data_time_updates 找 op=bitable_rows_replace
    且 caller_session 命中的规则，返回规则 dict；无命中返回 None。只解析不施加形状闸
    （形状校验见 check_controlled_rows_replace）。"""
    candidates = []
    for rule in asset.controlled_data_time_updates:
        if not isinstance(rule, dict) or rule.get("op") != "bitable_rows_replace":
            continue
        callers = rule.get("caller_sessions")
        if not isinstance(callers, list) or caller_session not in callers:
            continue
        candidates.append(rule)
    if delete_guard is not None:
        exact = [
            rule for rule in candidates
            if rule.get("delete_guard") == delete_guard
        ]
        if exact:
            candidates = exact
    if len(candidates) > 1:
        raise ValueError(
            "overlapping controlled bitable_rows_replace rules: "
            f"caller_session={caller_session} delete_guard={delete_guard!r}"
        )
    return candidates[0] if candidates else None


def check_controlled_rows_replace(
    asset: AssetContract, *, caller_session: str,
    rows: list[dict[str, Any]], delete_guard: dict[str, Any] | None,
    max_delete: int,
) -> bool:
    """受控替换（收敛式删除）闸（asset-scoped fail-closed，入队与 drain 同序调用）。

    owner 直接放行（既有语义：owner 可对本资产任意行做 replace）；非 owner 必须命中合同
    controlled_data_time_updates 里 op=bitable_rows_replace 的规则：caller 在
    caller_sessions、payload 行字段 ⊆ 规则 writable_fields、delete_guard 与规则声明
    逐字一致（field + values 精确锁定可删范围）、max_delete ≤ 规则硬上限，否则 raise
    ValueError（入队机械拒 / drain terminal failed）。"""
    if caller_session == asset.owner_session:
        return True
    grant = _controlled_replace_grant(
        asset, caller_session=caller_session, delete_guard=delete_guard)
    if grant is None:
        raise ValueError(
            f"caller_session {caller_session} cannot write asset owned by "
            f"{asset.owner_session} (no controlled bitable_rows_replace rule)")
    writable = set(grant.get("writable_fields") or [])
    for row in rows:
        extra = sorted(set(row) - writable)
        if extra:
            raise ValueError(
                f"controlled replace row fields exceed rule writable_fields: "
                f"{', '.join(extra)}")
    guard = grant.get("delete_guard")
    if guard is None:
        raise ValueError("controlled replace rule must declare delete_guard")
    if delete_guard is None or (
        delete_guard.get("field") != guard.get("field")
        or sorted(str(v) for v in (delete_guard.get("values") or []))
        != sorted(str(v) for v in (guard.get("values") or []))
    ):
        raise ValueError(
            f"controlled replace delete_guard must exactly match rule: "
            f"{json.dumps(guard, ensure_ascii=False)}")
    cap = grant.get("max_delete")
    if not isinstance(cap, int) or isinstance(cap, bool) or cap <= 0:
        raise ValueError("controlled replace rule must declare a positive max_delete")
    if max_delete > cap:
        raise ValueError(
            f"controlled replace max_delete {max_delete} exceeds rule cap {cap}")
    return True


_NON_SCALAR_KEY_TYPES = {
    "link",
    "single_link",
    "duplex_link",
    "relation",
    "user",
}


def _collect_cell_ids(value: Any) -> set[str]:
    ids: set[str] = set()
    if value is None or value == "":
        return ids
    if isinstance(value, str):
        ids.add(value)
        return ids
    if isinstance(value, dict):
        for key in ("id", "record_id", "open_id", "union_id", "user_id"):
            if value.get(key):
                ids.add(str(value[key]))
        record_ids = value.get("record_ids")
        if isinstance(record_ids, list):
            for item in record_ids:
                ids.update(_collect_cell_ids(item))
        records = value.get("records")
        if isinstance(records, list):
            for item in records:
                ids.update(_collect_cell_ids(item))
        return ids
    if isinstance(value, list):
        for item in value:
            ids.update(_collect_cell_ids(item))
        return ids
    return {str(value)}


def _canonical_key_value(value: Any, field_type: str) -> str | frozenset[str]:
    if field_type in _NON_SCALAR_KEY_TYPES:
        return frozenset(_collect_cell_ids(value))
    if field_type in {"date", "date_time"}:
        if field_type == "date_time":
            # Feishu date-time cells are instants.  Epoch values are UTC; an
            # explicit ISO offset is authoritative; legacy display strings
            # without a timezone are Feishu's Asia/Shanghai display time.
            # Keeping that naive-string rule explicit preserves existing
            # contracts while making UTC writes and +08 readbacks equal.
            if isinstance(value, datetime):
                parsed = value
            elif isinstance(value, (int, float)) or (
                isinstance(value, str)
                and re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value.strip())
            ):
                timestamp = float(value)
                if abs(timestamp) >= 10_000_000_000:
                    timestamp /= 1000
                parsed = datetime.fromtimestamp(timestamp, tz=timezone.utc)
            else:
                text = str(value).strip()
                if not text:
                    return ""
                if text.endswith(("Z", "z")):
                    text = text[:-1] + "+00:00"
                parsed = datetime.fromisoformat(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=_FEISHU_DISPLAY_TIMEZONE)
            # Feishu's tabular readback is second precision.  Sub-second
            # differences are not observable and were historically ignored.
            return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat(
                timespec="seconds"
            ).replace(
                "+00:00", "Z"
            )

        if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
            timestamp = float(value)
            if abs(timestamp) >= 10_000_000_000:
                timestamp /= 1000
            text = datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")
        else:
            text = str(value).strip()
        if field_type == "date":
            return text[:10]
        if len(text) == 10:
            return f"{text} 00:00:00"
        # Date fields retain calendar-day semantics; normalize a legacy ISO
        # separator before taking the calendar-day prefix.
        if len(text) > 10 and text[10] in {"T", "t"}:
            text = f"{text[:10]} {text[11:]}"
        return text[:19]
    return str(value)


def _wire_write_value(value: Any, field_type: str) -> Any:
    """Adapt a date-time instant to lark-cli's documented cell value shape.

    ``record-upsert`` accepts a datetime display string, not an ISO value with
    an offset. Sending the latter has produced an eight-hour shift on live
    creates. Planning and read-back keep the original source value; only the
    final IO value is adapted.
    """
    if field_type != "date_time" or value is None or value == "":
        return value
    instant = _canonical_key_value(value, field_type)
    if not isinstance(instant, str) or not instant:
        return value
    return datetime.fromisoformat(instant.replace("Z", "+00:00")).astimezone(
        _FEISHU_DISPLAY_TIMEZONE
    ).strftime("%Y-%m-%d %H:%M:%S")


def _wire_write_fields(
    fields: dict[str, Any],
    field_types: dict[str, str],
    *,
    field_ids: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Return the final-IO representation without mutating receipt data.

    When a live field-id map is supplied, bind every wire key to that map and
    fail closed if the live schema did not expose one of the requested fields.
    Contract names remain the in-memory/read-back representation only.
    """
    if field_ids is not None:
        missing = sorted(set(fields) - set(field_ids))
        if missing:
            raise ValueError(f"live field ids missing for writable fields: {missing}")
    return {
        (field_ids[field] if field_ids is not None else field):
        _wire_write_value(value, field_types.get(field, ""))
        for field, value in fields.items()
    }


def _record_key(
    row: dict[str, Any],
    unique_key: list[str],
    field_types: dict[str, str] | None = None,
) -> tuple[str | frozenset[str], ...]:
    if field_types is None:
        return tuple(str(row.get(key, "")) for key in unique_key)
    return tuple(
        _canonical_key_value(row.get(key, ""), field_types.get(key, ""))
        for key in unique_key
    )


def _filter_value_for_key(value: Any, field_type: str) -> Any:
    if field_type == "user":
        return [{"id": user_id} for user_id in sorted(_collect_cell_ids(value))]
    if field_type == "date_time":
        # Keep the Feishu filter wire shape as a naive display value; the
        # canonical instant is only for client-side equality after readback.
        instant = _canonical_key_value(value, field_type)
        if instant == "":
            return ""
        return datetime.fromisoformat(instant.replace("Z", "+00:00")).astimezone(
            _FEISHU_DISPLAY_TIMEZONE
        ).strftime("%Y-%m-%d %H:%M:%S")
    return str(value)


# link/关联族字段的 record_id 无法用飞书 filter-json 服务端等值匹配：== 语义匹配的是被
# 关联记录的主字段显示文本，而不是 record_id，所以拿 record_id（无论 str(value) 还是
# [{"id":..}] 引用数组）当 filter 一律 0 命中。这些类型的唯一键不能做服务端收窄键，必须整表
# 枚举后按 canonical record_id 客户端精确匹配。user 字段可用 [{"id":..}] 引用数组服务端
# 过滤（见 _filter_value_for_key 与 test_search_records_by_user_key_...），故不在此列。
_LINK_FILTER_UNSUPPORTED_TYPES = {
    "link",
    "single_link",
    "duplex_link",
    "relation",
}


def _strict_key_filter_json(
    table: TableContract,
    field_types: dict[str, str],
    row: dict[str, Any],
) -> str | None:
    """将所有可服务端等值匹配的唯一键分量合成 AND filter-json。

    link/关联族按 record_id 无法由飞书 filter-json 等值匹配，故跳过；若全为这类字段则
    返回 None，调用方整表分页枚举并做客户端 canonical 匹配。只要有可匹配分量，仍必须
    取完该 filter 的所有分页并按完整复合键裁决：部分 filter 不是完整唯一键，完整 AND
    filter 也仍可能暴露远端重复行。
    """
    conditions = []
    for key in table.unique_key:
        field_type = field_types.get(key, "")
        if field_type in _LINK_FILTER_UNSUPPORTED_TYPES:
            continue
        conditions.append([key, "==", _filter_value_for_key(row[key], field_type)])
    if not conditions:
        return None
    return json.dumps({"logic": "and", "conditions": conditions}, ensure_ascii=False)


def _index_existing_records(
    existing_records: list[dict[str, Any]],
    unique_key: list[str],
    field_types: dict[str, str] | None = None,
) -> dict[tuple[str | frozenset[str], ...], dict[str, Any]]:
    indexed: dict[tuple[str | frozenset[str], ...], dict[str, Any]] = {}
    for record in existing_records:
        fields = record.get("fields", record)
        key = _record_key(fields, unique_key, field_types)
        if key in indexed:
            raise ValueError(f"duplicate existing unique key: {key}")
        indexed[key] = record
    return indexed


def bitable_upsert_plan(
    asset: AssetContract,
    rows: list[dict[str, Any]],
    *,
    caller_session: str,
    existing_records: list[dict[str, Any]],
    existing_records_complete: bool = True,
    queue_op: str | None = None,
    migration_grant_fields: set[str] | None = None,
) -> dict[str, Any]:
    """existing_records_complete=False：existing_records 只是占位（如入队前机械校验不触网），
    不得据此判定记录不存在 → 跳过 locator-only 唯一键的"不可创建"闸（留给 drain 时真值枚举判定）。

    queue_op：本次校验对应的公共队列 op。queue_op ∈ {"bitable_rows_upsert",
    "bitable_rows_update_existing", "bitable_rows_replace"} 时才查询合同
    controlled_data_time_updates 里的同名规则；不传保持 owner-only fail
    closed。"""
    validate_asset_contract(asset)
    controlled_rules: list[dict[str, Any]] = []
    if (
        queue_op == "bitable_rows_update_existing"
        or caller_session != asset.owner_session
    ) and queue_op in {
        "bitable_rows_upsert", "bitable_rows_update_existing", "bitable_rows_replace",
    }:
        controlled_rules = [
            rule for rule in asset.controlled_data_time_updates
            if rule.get("op") == queue_op
            and caller_session in (rule.get("caller_sessions") or [])
        ]
    if caller_session != asset.owner_session:
        if not controlled_rules:
            raise ValueError(f"caller_session {caller_session} cannot write asset owned by {asset.owner_session}")
    if not asset.tables:
        raise ValueError("asset has no table contract")
    table = asset.tables[0]
    field_types = _field_types(asset)
    unique_key = table.unique_key
    if not unique_key:
        raise ValueError(
            f"asset {asset.asset_id} contract has no unique_key; "
            "data-time sync requires a stable registered key"
        )
    unique_key_set = set(unique_key)
    allowed = {field.name_zh for field in table.fields}
    authorities = _field_authority(asset)
    # 迁移写入例外授予的额外可写 feishu 列（已由调用方按 op/caller/key 解析，见
    # resolve_migration_write_grant）；这些列绕过下面的 feishu/readonly 拒绝闸并进 write_fields。
    grant_fields = migration_grant_fields or set()
    # 唯一键里若有 feishu/readonly 权威字段，则它是"仅定位键"：caller 不拥有该列，
    # 不能创建新行（行由飞书/人工创建），只能定位既有行回写自有字段。
    locator_only_key = any(
        authorities.get(key) in {"feishu", "readonly"} for key in unique_key
    )
    existing_by_key = _index_existing_records(existing_records, unique_key, field_types)
    input_keys: set[tuple[str | frozenset[str], ...]] = set()
    planned = []
    counts = {"created": 0, "updated": 0, "skipped": 0, "failed": 0}
    for row in rows:
        for key in unique_key:
            value = row.get(key)
            if value is None or (isinstance(value, str) and not value.strip()):
                raise ValueError(f"missing unique key {key}")
        key_tuple = _record_key(row, unique_key, field_types)
        if key_tuple in input_keys:
            raise ValueError(f"duplicate input unique key: {key_tuple}")
        input_keys.add(key_tuple)
        extra = sorted(set(row) - allowed)
        if extra:
            raise ValueError(f"fields not allowed by contract: {', '.join(extra)}")
        # 受控 caller：每行字段必须是某条授权规则 writable_fields 的子集
        # （唯一键在上方已强制存在），任何规则外字段 fail closed。
        row_controlled_rules = controlled_rules
        if queue_op == "bitable_rows_update_existing" and controlled_rules:
            selected = _controlled_rows_update_existing_grant(
                asset,
                caller_session=caller_session,
                patch_fields=set(row) - unique_key_set,
            )
            if selected is None:
                row_controlled_rules = []
            else:
                row_controlled_rules = [selected]
        if controlled_rules:
            if not row_controlled_rules:
                raise ValueError(
                    f"row fields exceed controlled {queue_op} rule for "
                    f"caller {caller_session}: {', '.join(sorted(row))}"
                )
            if queue_op != "bitable_rows_update_existing":
                allowed_fields = set(row_controlled_rules[0].get("writable_fields") or [])
                if not set(row) <= allowed_fields:
                    raise ValueError(
                        f"row fields exceed controlled {queue_op} rule for "
                        f"caller {caller_session}: {', '.join(sorted(row))}"
                    )
        # 唯一键字段是定位键：允许出现在 payload 里用于定位，但不写入飞书；
        # 非唯一键的 feishu/readonly 字段仍禁止 caller 覆盖。
        readonly = sorted(
            field
            for field in row
            if field not in unique_key_set
            and authorities.get(field) in {"feishu", "readonly"}
            and field not in grant_fields
            and not (
                queue_op == "bitable_rows_update_existing"
                and any(field in (rule.get("writable_fields") or []) for rule in row_controlled_rules)
            )
        )
        if readonly:
            raise ValueError(f"fields not writable by caller: {', '.join(readonly)}")
        # 实际写入飞书的字段：剔除所有 feishu/readonly 字段（含 feishu 权威的定位键），
        # 但迁移例外显式授予的列（grant_fields）保留写入，守住 field_split 字段级权威边界。
        write_fields = {
            field: value
            for field, value in row.items()
            if authorities.get(field) not in {"feishu", "readonly"}
            or field in grant_fields
            or (
                queue_op == "bitable_rows_update_existing"
                and any(field in (rule.get("writable_fields") or []) for rule in row_controlled_rules)
            )
        }
        existing = existing_by_key.get(key_tuple)
        if not existing:
            if locator_only_key and existing_records_complete:
                raise ValueError(
                    f"cannot create record for locator-only unique key {key_tuple}:"
                    " unique key authority is feishu/readonly; record must pre-exist in Feishu"
                )
            action = "create"
            counts["created"] += 1
            record_id = ""
        else:
            record_id = str(existing.get("record_id", ""))
            existing_fields = existing.get("fields", existing)
            changed = any(
                not _field_value_matches(
                    existing_fields.get(field), value, field_types.get(field, "")
                )
                for field, value in write_fields.items()
            )
            if changed:
                action = "update"
                counts["updated"] += 1
            else:
                action = "skip"
                counts["skipped"] += 1
        planned.append({
            "action": action,
            "record_id": record_id,
            "unique_key": {key: row[key] for key in unique_key},
            "fields": row,
            "write_fields": write_fields,
        })
    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "dry_run",
        "created": counts["created"],
        "updated": counts["updated"],
        "skipped": counts["skipped"],
        "failed": counts["failed"],
        "read_back_verified": False,
        "rows": planned,
    }


def _field_types(asset: AssetContract, table: TableContract | None = None) -> dict[str, str]:
    if table is not None:
        return {field.name_zh: field.type for field in table.fields}
    if not asset.tables:
        return {}
    return {field.name_zh: field.type for field in asset.tables[0].fields}


def _normalize_lark_cell(value: Any, field_type: str) -> Any:
    if field_type == "multi_select":
        if value is None or value == "":
            return []
        values = value if isinstance(value, list) else [value]
        return sorted({str(item) for item in values})
    if value is None:
        return ""
    if field_type == "single_select" and isinstance(value, list):
        return value[0] if value else ""
    if field_type == "text" and isinstance(value, str):
        # A text field styled as URL is read back by lark-cli as Markdown even
        # when the exact write value was the bare URL.  Only unwrap Feishu's
        # own lossless display shape; arbitrary Markdown remains text so this
        # cannot hide a changed label or target.
        if value.startswith("[") and "](" in value and value.endswith(")"):
            label, separator, target = value[1:].partition("](")
            target = target[:-1]
            if (
                separator
                and label == target
                and label.startswith(("https://", "http://"))
            ):
                return label
    return value


def _readback_cell_type(remote_type: Any, fallback_type: str) -> str:
    """Map lark-cli's field type labels to the cell-shape labels we normalize."""
    # lark-cli reports both single_select and multi_select as ``select`` in
    # field_type_list.  Preserve the contract's multi_select shape instead of
    # silently reducing a returned list to its first value.
    if _normalize_field_type(remote_type) == "select" and fallback_type == "multi_select":
        return fallback_type
    aliases = {
        "select": "single_select",
        "multiselect": "multi_select",
        "datetime": "date_time",
        "autonumber": "auto_number",
    }
    normalized = _normalize_field_type(remote_type)
    return aliases.get(normalized, fallback_type) if normalized else fallback_type


def _lark_records_from_list(payload: dict[str, Any], field_types: dict[str, str] | None = None) -> list[dict[str, Any]]:
    data = payload.get("data") or {}
    types = field_types or {}
    # lark-cli renders long display names as ``prefix...`` even when that field
    # was explicitly projected.  Restore only a unique contract-name prefix;
    # an ambiguous abbreviation deliberately stays unresolved so a later
    # read-back comparison fails closed instead of comparing the wrong field.
    fields = []
    raw_field_types = data.get("field_type_list")
    if not isinstance(raw_field_types, list):
        raw_field_types = []
    for index, raw_field in enumerate(data.get("fields", [])):
        field = str(raw_field)
        if field not in types and field.endswith("..."):
            candidates = [name for name in types if name.startswith(field[:-3])]
            if len(candidates) == 1:
                field = candidates[0]
        remote_type = raw_field_types[index] if index < len(raw_field_types) else ""
        fields.append((field, _readback_cell_type(remote_type, types.get(field, ""))))
    rows = data.get("data", [])
    record_ids = data.get("record_id_list", [])
    records = []
    for index, row in enumerate(rows):
        field_map = {
            field: _normalize_lark_cell(value, readback_type)
            for (field, readback_type), value in zip(fields, row)
        }
        records.append({
            "record_id": str(record_ids[index]) if index < len(record_ids) else "",
            "fields": field_map,
        })
    return records


def _table_id(asset: AssetContract, table: TableContract) -> str:
    return table.table_id or asset.table_id


def _attachment_table(asset: AssetContract, field: str, unique_key_values: dict[str, Any]) -> TableContract:
    candidates = [
        table for table in asset.tables
        if any(f.name_zh == field and f.type == "attachment" for f in table.fields)
    ]
    if not candidates:
        raise ValueError(f"attachment field not in contract: {field}")
    keyed = [
        table for table in candidates
        if all(unique_key_values.get(key) for key in table.unique_key)
    ]
    if len(keyed) == 1:
        return keyed[0]
    if len(keyed) > 1:
        names = ", ".join(table.name_zh for table in keyed)
        raise ValueError(f"ambiguous attachment field table for {field}: {names}")
    missing = {
        table.name_zh: [key for key in table.unique_key if not unique_key_values.get(key)]
        for table in candidates
    }
    raise ValueError(f"missing unique key for attachment field {field}: {missing}")


def _search_records_by_key(cli: Any, asset: AssetContract, table: TableContract,
                           row: dict[str, Any], *, actor: str) -> list[dict[str, Any]]:
    """逐键精确查重：服务端将全部可等值匹配的唯一键合成 AND filter-json，客户端仍对
    完整唯一键做精确 AND。用 filter-json 而非 record-search --keyword，因为 keyword 有 50
    字符上限，复合业务键（如 货件候选ID|ASIN|MSKU|店铺）会超限被拒。
    唯一键全为 link/关联族（record_id 无法服务端匹配）时退回整表分页枚举，仅靠客户端
    canonical 匹配定位——否则对 link 键发 filter 会 0 命中、被静默当作不存在。"""
    field_types = _field_types(asset, table)
    filter_json = _strict_key_filter_json(table, field_types, row)
    target = _record_key(row, table.unique_key, field_types)
    # The server-side narrowing key is not necessarily unique by itself (for
    # example, ``店铺`` can match hundreds of rows), so enumerate every filtered
    # page before applying the full composite-key match locally.  A one-page
    # lookup silently classifies later-page records as absent and turns an
    # idempotent upsert into a create.
    records = _list_all_records(
        cli, asset, table, actor=actor, filter_json=filter_json,
    )
    return [
        record for record in records
        if _record_key(record.get("fields", {}), table.unique_key, field_types) == target
    ]


def _search_all_records_by_key(
    cli: Any,
    asset: AssetContract,
    table: TableContract,
    row: dict[str, Any],
    *,
    actor: str,
) -> list[dict[str, Any]]:
    """Find every exact key match across all pages for strict no-create plans.

    The update-existing operation needs a stronger predicate than the legacy
    one-page helper: a later page with the same composite key must fail the whole
    plan before any mutation.  ``_strict_key_filter_json`` narrows on every
    server-matchable unique-key component, or returns None (full enumeration)
    when every unique key is a link/relation field whose record_id cannot be
    filtered.
    """
    field_types = _field_types(asset, table)
    filter_json = _strict_key_filter_json(table, field_types, row)
    target = _record_key(row, table.unique_key, field_types)
    return [
        record
        for record in _list_all_records(
            cli,
            asset,
            table,
            actor=actor,
            filter_json=filter_json,
        )
        if _record_key(record.get("fields", {}), table.unique_key, field_types) == target
    ]


_AMBIGUOUS_CREATE_READBACK_ATTEMPTS = 2


def _bounded_strict_create_readback(
    cli: Any,
    asset: AssetContract,
    table: TableContract,
    item: dict[str, Any],
    *,
    actor: str,
) -> tuple[dict[str, Any] | None, str]:
    """Bounded exact-key read-back after a no-record-id create becomes uncertain.

    This never replays the create. Each attempt exhausts the applicable server
    filter pages and compares the complete canonical composite key locally; a
    record is accepted only when its requested writable fields also match.
    """
    field_types = _field_types(asset, table)
    last_error = ""
    for attempt in range(1, _AMBIGUOUS_CREATE_READBACK_ATTEMPTS + 1):
        try:
            matches = _search_records_by_key(
                cli, asset, table, item["unique_key"], actor=actor,
            )
        except Exception as exc:  # noqa: BLE001 - uncertain creates must not be replayed
            last_error = (
                f"strict create read-back attempt {attempt}/"
                f"{_AMBIGUOUS_CREATE_READBACK_ATTEMPTS} failed: {exc}"
            )
            continue
        if len(matches) != 1:
            last_error = (
                f"strict create read-back attempt {attempt}/"
                f"{_AMBIGUOUS_CREATE_READBACK_ATTEMPTS} expected exactly one record, got {len(matches)}"
            )
            continue
        record = matches[0]
        if not str(record.get("record_id") or ""):
            last_error = (
                f"strict create read-back attempt {attempt}/"
                f"{_AMBIGUOUS_CREATE_READBACK_ATTEMPTS} returned no record_id"
            )
            continue
        if _write_fields_match(record, item, field_types):
            return record, ""
        last_error = (
            f"strict create read-back attempt {attempt}/"
            f"{_AMBIGUOUS_CREATE_READBACK_ATTEMPTS} field mismatch"
        )
    return None, last_error or "strict create read-back was not verified"


def _record_get(cli: Any, asset: AssetContract, table: TableContract,
                record_id: str, *, actor: str) -> dict[str, Any] | None:
    payload = cli.run_json([
        "base", "+record-get", "--as", actor,
        "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
        "--record-id", record_id,
    ])
    records = _lark_records_from_list(payload, _field_types(asset))
    if not records:
        return None
    if len(records) != 1:
        raise ValueError(
            "record-get must return at most one record for an exact record_id: "
            f"requested={record_id} actual_count={len(records)}"
        )
    actual_record_id = str(records[0].get("record_id") or "")
    if actual_record_id != record_id:
        raise ValueError(
            "record-get identity mismatch: "
            f"requested={record_id} actual={actual_record_id or '<missing>'}"
        )
    return records[0]


def _run_json_single_attempt(
    cli: Any,
    args: list[str],
    *,
    cwd: str | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Use a caller-provided no-retry path when the mutation cannot replay.

    ``PacedLarkCli`` exposes ``run_json_no_retry`` for this narrow case.  A
    plain ``LarkCli`` has one process invocation per call already, so its
    normal method remains the one-shot fallback.
    """
    one_shot = getattr(cli, "run_json_no_retry", None)
    if callable(one_shot):
        return one_shot(args, cwd=cwd, timeout=timeout)
    return cli.run_json(args, cwd=cwd, timeout=timeout)


_RECORD_GET_BATCH = 100


def _records_get_by_ids(
    cli: Any,
    asset: AssetContract,
    table: TableContract,
    record_ids: list[str],
    *,
    actor: str,
    field_names: list[str],
) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for start in range(0, len(record_ids), _RECORD_GET_BATCH):
        chunk = record_ids[start:start + _RECORD_GET_BATCH]
        command = [
            "base", "+record-get", "--as", actor,
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
            "--json", json.dumps({"record_id_list": chunk}, ensure_ascii=False),
        ]
        for field_name in field_names:
            command.extend(["--field-id", field_name])
        payload = cli.run_json(command)
        for record in _lark_records_from_list(payload, _field_types(asset)):
            record_id = str(record.get("record_id") or "")
            if record_id:
                records[record_id] = record
    return records


def _upsert_record_id(payload: dict[str, Any]) -> str:
    data = payload.get("data") or {}
    record = data.get("record") or {}
    return str(data.get("record_id") or record.get("record_id") or "")


_BULK_SYNC_THRESHOLD = 200  # 行数达阈值→整表预取+批量创建：逐行 search/逐行读回在万行级 job 上是数十小时级、
                            # 任何 tick/工具超时内都跑不完（2026-07-04 job 24946 14288 行实测，attempts 全耗在搜索阶段被杀）
_CREATE_BATCH = 200  # 飞书 batch_create 单请求记录数上限


class AmbiguousCreateReadBackError(RuntimeError):
    """A create may have committed, but bounded strict read-back could not decide."""


class AmbiguousDeleteReadBackError(ValueError):
    """A single-record delete might have committed, but read-back cannot prove it."""


def _group_records_by_key(
    records: list[dict[str, Any]],
    unique_key: list[str],
    field_types: dict[str, str] | None = None,
) -> dict[tuple[str | frozenset[str], ...], list[dict[str, Any]]]:
    grouped: dict[tuple[str | frozenset[str], ...], list[dict[str, Any]]] = {}
    for record in records:
        grouped.setdefault(
            _record_key(record.get("fields", {}), unique_key, field_types), []).append(record)
    return grouped


def _row_field_summary(item: dict[str, Any]) -> dict[str, str]:
    """失败行字段摘要（观测用）：前 8 个写入字段，值截断 60 字符——够 owner 认出是哪行/哪个脏值。"""
    fields = item.get("write_fields") or {}
    return {k: str(v)[:60] for k, v in list(fields.items())[:8]}


def _bulk_create_records(cli: Any, asset: AssetContract, table: TableContract,
                         items: list[dict[str, Any]], *, actor: str,
                         field_types: dict[str, str]
                         ) -> tuple[list[dict[str, Any]], int]:
    """batch-create 分批新建；返回抛错批次的观测信息（error/批范围/键样本），交终局读回裁决真缺行。

    绕过 PacedLarkCli 自动重试：飞书限流响应不代表事务已回滚（800004135，2026-06-26 实测），
    盲重试会按业务键造重复行。异常批不在本轮重试；调用方经有界严格读回仍不能裁决时
    必须把 job 终态化，绝不把同一个 create 放回 pending。批错误只观测、不改写入语义。"""
    raw = getattr(cli, "inner", cli)
    columns: list[str] = []
    for item in items:
        for field in item["write_fields"]:
            if field not in columns:
                columns.append(field)
    batch_errors: list[dict[str, Any]] = []
    batch_error_total = 0
    for start in range(0, len(items), _CREATE_BATCH):
        chunk = items[start:start + _CREATE_BATCH]
        if start:
            time.sleep(0.25)  # raw 调用没有 PacedLarkCli 节奏，手动限速
        payload = {"fields": columns, "rows": [
            [
                _wire_write_value(item["write_fields"].get(col), field_types.get(col, ""))
                for col in columns
            ]
            for item in chunk
        ]}
        try:
            raw.run_json([
                "base", "+record-batch-create", "--as", actor,
                "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
                "--json", json.dumps(payload, ensure_ascii=False),
            ])
        except Exception as exc:  # noqa: BLE001 观测：记飞书错误+本批范围，终局读回定位真缺行
            batch_error_total += 1
            if len(batch_errors) < 50:
                batch_errors.append({
                    "error": str(exc)[:800],
                    "batch_start": start,
                    "batch_rows": len(chunk),
                    "sample_unique_keys": [item["unique_key"] for item in chunk[:3]],
                })
    return batch_errors, batch_error_total


def _live_field_ids(
    cli: Any, asset: AssetContract, table: TableContract, *, actor: str
) -> dict[str, str]:
    payload = cli.run_json([
        "base", "+field-list", "--as", actor,
        "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
        "--limit", "200",
    ])
    data = payload.get("data") or {}
    fields = data.get("fields") or data.get("items") or []
    result: dict[str, str] = {}
    for field in fields:
        if not isinstance(field, dict):
            continue
        name = str(field.get("name") or field.get("field_name") or "").strip()
        field_id = str(field.get("id") or field.get("field_id") or "").strip()
        if name and field_id:
            result[name] = field_id
    return result


_SELECT_OPTION_PAGE_SIZE = 200


def _select_values_for_preflight(value: Any, field_type: str, *, field: str) -> set[str]:
    """Normalize a writable select value into the exact option names it needs.

    This is deliberately stricter than read-back normalization: an invalid wire
    shape must fail locally before a full replace can partially mutate the table.
    """
    if value is None or value == "":
        return set()
    values = value if isinstance(value, list) else [value]
    if field_type == "single_select" and len(values) > 1:
        raise ValueError(f"single_select field {field} accepts at most one option")
    names: set[str] = set()
    for item in values:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(
                f"{field_type} field {field} must contain non-empty option names"
            )
        names.add(item)
    return names


def _live_select_option_names(
    cli: Any,
    asset: AssetContract,
    table: TableContract,
    *,
    actor: str,
    field: str,
    field_id: str,
) -> set[str]:
    """Read every live option page for one select field, or fail closed.

    ``+field-list`` intentionally truncates large option sets.  The option-search
    endpoint gives a total plus offset pages, which lets a data-time replace
    prove that each value exists before its first remote record mutation.
    """
    offset = 0
    total: int | None = None
    seen = 0
    names: set[str] = set()
    while True:
        payload = cli.run_json([
            "base", "+field-search-options", "--as", actor,
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
            "--field-id", field_id, "--limit", str(_SELECT_OPTION_PAGE_SIZE),
            "--offset", str(offset),
        ])
        data = payload.get("data") or {}
        options = data.get("options")
        page_total = data.get("total")
        if (
            not isinstance(options, list)
            or not isinstance(page_total, int)
            or isinstance(page_total, bool)
            or page_total < 0
        ):
            raise ValueError(
                f"cannot verify live select options for {field}: malformed option response"
            )
        if total is None:
            total = page_total
        elif page_total != total:
            raise ValueError(
                f"cannot verify live select options for {field}: option total changed during read"
            )
        for option in options:
            name = option.get("name") if isinstance(option, dict) else None
            if not isinstance(name, str) or not name:
                raise ValueError(
                    f"cannot verify live select options for {field}: option name missing"
                )
            # A repeated page (for example an ignored offset) can otherwise
            # make ``seen == total`` while silently omitting a later page.
            # Option names are the values we must prove writable, so duplicate
            # names make this pagination proof ambiguous; fail closed.
            if name in names:
                raise ValueError(
                    f"cannot verify live select options for {field}: "
                    "duplicate option name in pagination"
                )
            names.add(name)
        seen += len(options)
        if seen == total:
            return names
        if seen > total or not options:
            raise ValueError(
                f"cannot verify live select options for {field}: incomplete option pagination"
            )
        offset += len(options)


def _preflight_declared_select_options(
    asset: AssetContract,
    table: TableContract,
    plan_rows: list[dict[str, Any]],
    *,
    cli: Any,
    actor: str,
) -> None:
    """Fail a replace before writing when declared select values drift live.

    The contract is the intended schema, while the paginated live read is the
    executable schema.  For select fields that declare static options (or an
    option source), both must admit every value the replace would write.
    Legacy fields without either declaration retain their existing compatibility
    path; this guard does not silently invent a schema contract for them.
    """
    fields_by_name = {field.name_zh: field for field in table.fields}
    values_by_field: dict[str, set[str]] = {}
    for item in plan_rows:
        if item.get("action") == "skip":
            continue
        for name, value in (item.get("write_fields") or {}).items():
            contract_field = fields_by_name.get(name)
            if contract_field is None or contract_field.type not in {
                "single_select", "multi_select",
            }:
                continue
            if not contract_field.options and contract_field.option_source is None:
                continue
            values_by_field.setdefault(name, set()).update(
                _select_values_for_preflight(value, contract_field.type, field=name)
            )
    if not values_by_field:
        return

    field_ids = _live_field_ids(cli, asset, table, actor=actor)
    for name, wanted in sorted(values_by_field.items()):
        if not wanted:
            continue
        contract_field = fields_by_name[name]
        declared = {
            str(option.get("name"))
            for option in contract_field.options
            if isinstance(option, dict) and isinstance(option.get("name"), str)
        }
        missing_contract = sorted(wanted - declared) if declared else []
        if missing_contract:
            raise ValueError(
                f"select values missing from contract options for {name}: "
                + ", ".join(missing_contract)
            )
        field_id = field_ids.get(name)
        if not field_id:
            raise ValueError(f"cannot verify live select options: field id missing for {name}")
        live = _live_select_option_names(
            cli, asset, table, actor=actor, field=name, field_id=field_id,
        )
        missing_live = sorted(wanted - live)
        if missing_live:
            raise ValueError(
                f"live select options missing for {name}: " + ", ".join(missing_live)
            )


class UnverifiedUpdateResponse(LarkCliError):
    """The API returned success, but did not prove the requested update applied."""


class RemoteReadonlyUpdateResponse(UnverifiedUpdateResponse):
    """Feishu explicitly rejected an update because the field is upstream-synced."""


def _ignored_fields_are_readonly(ignored: list[Any]) -> bool:
    for item in ignored:
        reason = item.get("reason", "") if isinstance(item, dict) else item
        if "READONLY:" in str(reason):
            return True
    return False


def _require_verified_update_response(response: dict[str, Any], command: str) -> None:
    data = response.get("data") or {}
    record = data.get("record")
    if isinstance(record, dict):
        ignored = record.get("ignored_fields") or []
        update = record.get("update")
        if ignored or not isinstance(update, dict) or not update:
            error_type = (
                RemoteReadonlyUpdateResponse
                if _ignored_fields_are_readonly(ignored)
                else UnverifiedUpdateResponse
            )
            raise error_type(
                f"{command} update response not verified: "
                + json.dumps(
                    {"update": update, "ignored_fields": ignored},
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
        return
    ignored = data.get("ignored_fields") or response.get("ignored_fields") or []
    updated = data.get("updated", response.get("updated"))
    # Some Feishu batch-update responses have no record-level result and expose
    # ``updated: null``.  The caller's mandatory final read-back is the
    # authoritative write proof; only an explicit false remains a response
    # failure here.  Keep ignored fields fail-closed because they can indicate
    # a silently discarded readonly patch.
    if ignored or (updated is not True and updated is not None):
        error_type = (
            RemoteReadonlyUpdateResponse
            if _ignored_fields_are_readonly(ignored)
            else UnverifiedUpdateResponse
        )
        raise error_type(
            f"{command} update response not verified: "
            + json.dumps(
                {"updated": updated, "ignored_fields": ignored},
                ensure_ascii=False,
                sort_keys=True,
            )
        )


def _bulk_update_same_patch_records(cli: Any, asset: AssetContract, table: TableContract,
                                    items: list[dict[str, Any]], *, actor: str,
                                    field_ids: dict[str, str],
                                    field_types: dict[str, str]
                                    ) -> tuple[list[dict[str, Any]], int, set[str]]:
    """按相同 PATCH 分组 batch-update 已有记录。

    lark-cli `record-batch-update` 只支持同一个 patch 应用到多个 record_id。这里剔除
    unique_key 字段后分组，避免把定位键（如 日期）改成同一个值；终局读回仍按完整
    write_fields（含 unique_key）校验，确保定位键和补写字段都正确。单记录 patch
    改走 `record-upsert --record-id`：高基数更新若退化为大量单 record-batch-update，
    在真实 Feishu 上可能逐条未落地，且只会在终局读回时表现为整批 mismatch。
    """
    groups: dict[str, dict[str, Any]] = {}
    unique_key_set = set(table.unique_key)
    for item in items:
        patch = {
            field: value
            for field, value in item["write_fields"].items()
            if field not in unique_key_set
        }
        if not patch:
            continue
        # The live field list is both the existence gate and the source of the
        # ID-bound wire keys. Contract names are not safe mutation keys.
        wire_patch = _wire_write_fields(patch, field_types, field_ids=field_ids)
        key = json.dumps(wire_patch, ensure_ascii=False, sort_keys=True)
        groups.setdefault(key, {"patch": wire_patch, "items": []})["items"].append(item)

    batch_errors: list[dict[str, Any]] = []
    batch_error_total = 0
    unverified_record_ids: set[str] = set()
    for group in groups.values():
        group_items = group["items"]
        for start in range(0, len(group_items), _CREATE_BATCH):
            chunk = group_items[start:start + _CREATE_BATCH]
            try:
                if len(chunk) == 1:
                    response = cli.run_json([
                        "base", "+record-upsert", "--as", actor,
                        "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
                        "--record-id", chunk[0]["record_id"],
                        "--json", json.dumps(group["patch"], ensure_ascii=False),
                    ])
                    _require_verified_update_response(response, "record-upsert")
                else:
                    payload = {
                        "record_id_list": [item["record_id"] for item in chunk],
                        "patch": group["patch"],
                    }
                    response = cli.run_json([
                        "base", "+record-batch-update", "--as", actor,
                        "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
                        "--json", json.dumps(payload, ensure_ascii=False),
                    ])
                    _require_verified_update_response(response, "record-batch-update")
            except RemoteReadonlyUpdateResponse:
                raise
            except Exception as exc:  # noqa: BLE001 终局读回会定位真未落地行
                if getattr(exc, "snapshot_budget_exceeded", False):
                    raise
                batch_error_total += 1
                if isinstance(exc, UnverifiedUpdateResponse):
                    unverified_record_ids.update(
                        str(item["record_id"]) for item in chunk
                    )
                if len(batch_errors) < 50:
                    batch_errors.append({
                        "error": str(exc)[:800],
                        "batch_start": start,
                        "batch_rows": len(chunk),
                        "sample_unique_keys": [item["unique_key"] for item in chunk[:3]],
                    })
    return batch_errors, batch_error_total, unverified_record_ids


_RECEIPT_LIST_BUDGET_BYTES = 128 * 1024


def _bounded_receipt_list(
    items: list[Any], *, max_bytes: int = _RECEIPT_LIST_BUDGET_BYTES
) -> tuple[list[Any], int]:
    selected: list[Any] = []
    used = 2  # JSON []
    for item in items:
        encoded = json.dumps(
            item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        extra = len(encoded) + (1 if selected else 0)
        if used + extra > max_bytes:
            break
        selected.append(item)
        used += extra
    return selected, len(items) - len(selected)


def _is_blank_cell(value: Any) -> bool:
    return value is None or value == "" or value == []


def _canonical_field_value(value: Any, field_type: str) -> Any:
    if field_type == "multi_select":
        return _normalize_lark_cell(value, field_type)
    if _is_blank_cell(value):
        return ""
    if field_type in _NON_SCALAR_KEY_TYPES or field_type in {"date", "date_time"}:
        return _canonical_key_value(value, field_type)
    return _normalize_lark_cell(value, field_type)


def _field_value_matches(remote_value: Any, write_value: Any, field_type: str) -> bool:
    if field_type == "number":
        if _is_blank_cell(remote_value) or _is_blank_cell(write_value):
            return _is_blank_cell(remote_value) and _is_blank_cell(write_value)
        # 第 16 位起有效数字在远端不可观测——比对语义统一在 observability。
        return feishu_number_equal(remote_value, write_value)
    return (
        _canonical_field_value(remote_value, field_type)
        == _canonical_field_value(write_value, field_type)
    )


def _write_fields_match(
    record: dict[str, Any],
    item: dict[str, Any],
    field_types: dict[str, str] | None = None,
) -> bool:
    fields = record.get("fields", {})
    types = field_types or {}
    return all(
        _field_value_matches(fields.get(field), value, types.get(field, ""))
        for field, value in item["write_fields"].items()
    )


def bitable_rows_update_existing(
    asset: AssetContract,
    rows: list[dict[str, Any]],
    *,
    caller_session: str,
    lark: LarkCli | None = None,
    actor: str = "user",
) -> dict[str, Any]:
    """Strictly update already-existing rows, never creating a record.

    This is intentionally separate from ``bitable_live_sync``: every input key is
    resolved before the first update, and zero or multiple matches abort the whole
    job before any remote mutation.  The input key remains a locator even when the
    contract marks it local-authoritative.
    """
    if not isinstance(rows, list):
        raise ValueError("rows must be a list for bitable_rows_update_existing")

    controlled_rule = check_controlled_rows_update_existing(
        asset, caller_session=caller_session, rows=rows,
    )

    # Phase 0 validates caller, key presence/uniqueness, declared fields, and
    # field authority without touching Feishu.  ``existing_records_complete`` is
    # false because existence is established in the strict remote plan below.
    bitable_upsert_plan(
        asset,
        rows,
        caller_session=caller_session,
        existing_records=[],
        existing_records_complete=False,
        queue_op="bitable_rows_update_existing",
    )
    table = asset.tables[0]
    field_types = _field_types(asset, table)
    cli = lark or LarkCli()

    # Phase 1: collect the full remote plan.  Do not move into the mutation loop
    # until every requested business key has exactly one existing record.
    existing_records: list[dict[str, Any]] = []
    for row in rows:
        matches = _search_all_records_by_key(cli, asset, table, row, actor=actor)
        key = {name: row[name] for name in table.unique_key}
        if not matches:
            raise ValueError(f"missing remote unique key: {key}")
        if len(matches) != 1:
            raise ValueError(f"duplicate remote unique key: {key}")
        record_id = str(matches[0].get("record_id") or "")
        if not record_id:
            raise ValueError(f"remote record missing record_id for unique key: {key}")
        if controlled_rule is not None:
            _enforce_controlled_row_scope(
                controlled_rule, matches[0].get("fields", matches[0]), required=True,
            )
        existing_records.append(matches[0])

    plan = bitable_upsert_plan(
        asset,
        rows,
        caller_session=caller_session,
        existing_records=existing_records,
        queue_op="bitable_rows_update_existing",
    )
    if plan["created"]:
        # The strict remote phase above should make this unreachable.  Keep a
        # mechanical fail-closed guard so a future planner change cannot create.
        raise ValueError("missing remote unique key during strict existing-row plan")

    existing_by_id = {
        str(record.get("record_id") or ""): record
        for record in existing_records
    }
    updated = 0
    skipped = 0
    for item in plan["rows"]:
        record_id = str(item["record_id"])
        existing = existing_by_id.get(record_id)
        if existing is None:
            raise ValueError(f"strict existing-row plan lost record_id: {record_id}")
        # The unique key is a locator for this operation, never a mutation field.
        # If it is locally authoritative it remains in ``verify_fields``: the
        # read-back receipt must cover every writable input field even though the
        # locator itself is deliberately not written.
        item["verify_fields"] = dict(item["write_fields"])
        write_fields = {
            field: value
            for field, value in item["write_fields"].items()
            if field not in table.unique_key
        }
        item["write_fields"] = write_fields
        existing_fields = existing.get("fields", existing)
        item["action"] = (
            "update"
            if any(
                not _field_value_matches(
                    existing_fields.get(field), value, field_types.get(field, "")
                )
                for field, value in write_fields.items()
            )
            else "skip"
        )
        if item["action"] == "update":
            updated += 1
        else:
            skipped += 1

    # Resolve the live schema before the first mutation. This keeps the
    # strict update-existing operation fail-closed and prevents a name-keyed
    # acknowledgement from being mistaken for a successful cell update.
    live_field_ids = _live_field_ids(cli, asset, table, actor=actor) if updated else {}

    failed_record_ids: set[str] = set()
    row_failures: list[dict[str, Any]] = []
    for item in plan["rows"]:
        if item["action"] != "update":
            continue
        record_id = str(item["record_id"])
        try:
            response = cli.run_json([
                "base", "+record-upsert", "--as", actor,
                "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
                "--record-id", record_id,
                "--json", json.dumps(
                    _wire_write_fields(
                        item["write_fields"], field_types, field_ids=live_field_ids,
                    ),
                    ensure_ascii=False,
                    sort_keys=True,
                ),
            ])
            _require_verified_update_response(response, "record-upsert")
        except Exception as exc:  # noqa: BLE001 - final read-back still records outcome
            failed_record_ids.add(record_id)
            row_failures.append({
                "phase": "update",
                "record_id": record_id,
                "unique_key": item["unique_key"],
                "error": str(exc)[:800],
            })

    # Phase 3: every input record, including skips, is read back and every
    # requested writable field is compared with the existing normalizer.
    for item in plan["rows"]:
        record_id = str(item["record_id"])
        try:
            after = _record_get(cli, asset, table, record_id, actor=actor)
        except Exception as exc:  # noqa: BLE001 - receipt must distinguish failed verification
            failed_record_ids.add(record_id)
            row_failures.append({
                "phase": "read_back",
                "record_id": record_id,
                "unique_key": item["unique_key"],
                "error": str(exc)[:800],
            })
            continue
        if after is None:
            failed_record_ids.add(record_id)
            row_failures.append({
                "phase": "read_back",
                "record_id": record_id,
                "unique_key": item["unique_key"],
                "error": "record missing during read-back",
            })
            continue
        after_fields = after.get("fields", after)
        for field, expected in item["verify_fields"].items():
            actual = after_fields.get(field)
            if _field_value_matches(actual, expected, field_types.get(field, "")):
                continue
            failed_record_ids.add(record_id)
            row_failures.append({
                "phase": "read_back",
                "record_id": record_id,
                "unique_key": item["unique_key"],
                "field": field,
                "expected": expected,
                "actual": actual,
                "error": f"field mismatch {field}",
            })

    all_record_ids = [str(item["record_id"]) for item in plan["rows"]]
    all_result_rows = [
        {
            "action": item["action"],
            "record_id": item["record_id"],
            "unique_key": item["unique_key"],
            "writable_fields": sorted(item["verify_fields"]),
        }
        for item in plan["rows"]
    ]
    record_ids, record_ids_omitted = _bounded_receipt_list(all_record_ids)
    result_rows, rows_omitted = _bounded_receipt_list(all_result_rows)
    bounded_row_failures, row_failures_omitted = _bounded_receipt_list(row_failures)
    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "update_existing",
        "op": "bitable_rows_update_existing",
        "created": 0,
        "updated": updated,
        "skipped": skipped,
        "failed": len(failed_record_ids),
        "record_ids": record_ids,
        "record_ids_total": len(all_record_ids),
        "record_ids_omitted": record_ids_omitted,
        "read_back_verified": not failed_record_ids,
        "rows": result_rows,
        "rows_total": len(all_result_rows),
        "rows_omitted": rows_omitted,
        "row_failures": bounded_row_failures,
        "row_failures_total": len(row_failures),
        "row_failures_omitted": row_failures_omitted,
        "batch_errors": [],
        "batch_errors_total": 0,
        "batch_errors_omitted": 0,
    }


def _controlled_update_rule(
    asset: AssetContract,
    *,
    caller_session: str,
    op: str,
    patch_fields: set[str],
    client_key: str | None = None,
) -> dict[str, Any]:
    candidates = []
    for rule in asset.controlled_data_time_updates:
        if rule.get("op") != op:
            continue
        callers = rule.get("caller_sessions") or []
        writable = set(rule.get("writable_fields") or [])
        if (
            caller_session in callers
            and patch_fields <= writable
            and controlled_update_client_key_matches(rule, client_key)
        ):
            candidates.append(rule)
    if not candidates:
        raise ValueError(
            f"controlled update not allowed: caller_session={caller_session}"
            f" op={op} fields={sorted(patch_fields)} asset={asset.asset_id}"
        )
    smallest = min(len(set(rule.get("writable_fields") or [])) for rule in candidates)
    candidates = [
        rule for rule in candidates
        if len(set(rule.get("writable_fields") or [])) == smallest
    ]
    if len(candidates) == 1:
        return candidates[0]
    raise ValueError(
        "overlapping controlled update rules: "
        f"caller_session={caller_session} op={op} fields={sorted(patch_fields)}"
    )


def _empty_expected_snapshot_value(value: Any, field_type: str) -> bool:
    """Whether the fixed CAS snapshot proves this field is still safe to fill."""
    if field_type == "checkbox":
        # False is an explicit human choice; only an absent checkbox is a gap.
        return value is None
    if field_type in {"text", "single_select"}:
        return isinstance(value, str) and not value.strip()
    return False


def _controlled_create_if_absent_rule(
    asset: AssetContract,
    *,
    caller_session: str,
    row_fields: set[str],
) -> dict[str, Any]:
    candidates = []
    for rule in asset.controlled_data_time_updates:
        if rule.get("op") != "bitable_rows_create_if_absent":
            continue
        if rule.get("write_mode") != "create_if_absent":
            continue
        if caller_session not in (rule.get("caller_sessions") or []):
            continue
        if row_fields != set(rule.get("writable_fields") or []):
            continue
        candidates.append(rule)
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        raise ValueError(
            "overlapping controlled create_if_absent rules: "
            f"caller_session={caller_session} fields={sorted(row_fields)}"
        )
    raise ValueError(
        "row fields must exactly match controlled create contract: "
        f"caller_session={caller_session} fields={sorted(row_fields)} "
        f"asset={asset.asset_id}"
    )


def validate_rows_create_if_absent_payload(
    asset: AssetContract,
    rows: list[dict[str, Any]],
    *,
    caller_session: str,
) -> tuple[TableContract, dict[str, Any]]:
    """Validate the one-row, creation-only initialization exception without I/O."""
    validate_asset_contract(asset)
    if not asset.tables:
        raise ValueError("asset has no table contract")
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ValueError("bitable_rows_create_if_absent requires exactly one object row")
    table = asset.tables[0]
    row = rows[0]
    rule = _controlled_create_if_absent_rule(
        asset, caller_session=caller_session, row_fields=set(row),
    )
    if list(rule.get("unique_key") or []) != table.unique_key:
        raise ValueError("controlled create unique_key does not match table contract")
    declared_fields = set(rule.get("required_fields") or [])
    if set(row) != declared_fields:
        raise ValueError("row fields must exactly match controlled create contract")
    field_types = _field_types(asset, table)
    for field in table.unique_key:
        value = row.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"missing unique key {field}")
    field_definitions = {field.name_zh: field for field in table.fields}
    for field in declared_fields:
        value = row[field]
        field_type = field_types.get(field, "")
        field_definition = field_definitions[field]
        if field_type in {"text", "single_select"}:
            if not isinstance(value, str):
                raise ValueError(
                    f"controlled create requires a {field_type} string field: {field}"
                )
            if field_definition.required and not value.strip():
                raise ValueError(
                    f"controlled create requires a non-empty {field_type} field: {field}"
                )
        if field_type == "checkbox" and type(value) is not bool:
            raise ValueError(f"controlled create requires a boolean checkbox field: {field}")
    return table, rule


def _create_if_absent_lock_path(
    asset: AssetContract,
    table: TableContract,
    row: dict[str, Any],
) -> Path:
    """Return the local cross-process lock for one create-if-absent business key."""
    scope = {
        "asset_id": asset.asset_id,
        "base_token": asset.base_token,
        "table_id": _table_id(asset, table),
        "unique_key": [row[key] for key in table.unique_key],
    }
    digest = hashlib.sha256(
        json.dumps(scope, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return _CREATE_IF_ABSENT_LOCK_ROOT / f"{digest}.lock"


@contextmanager
def _create_if_absent_key_lock(
    asset: AssetContract,
    table: TableContract,
    row: dict[str, Any],
) -> Iterator[None]:
    """Serialize check-create-readback for one key across full/scoped drains."""
    lock_path = _create_if_absent_lock_path(asset, table, row)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _expected_fields_match(
    fields: dict[str, Any],
    expected: dict[str, Any],
    field_types: dict[str, str],
) -> tuple[bool, str, Any, Any]:
    for field, value in expected.items():
        if not _field_value_matches(fields.get(field), value, field_types.get(field, "")):
            return False, field, value, fields.get(field)
    return True, "", None, None


def _validate_record_binding_payload(
    asset: AssetContract,
    rule: dict[str, Any],
    *,
    record_id: str,
    expected: dict[str, Any],
    patch: dict[str, Any],
    verify: dict[str, Any],
    field_types: dict[str, str],
) -> None:
    """Apply an optional contract-level record/value allowlist before any I/O.

    The binding is deliberately expressed in field IDs in the contract, while
    queue payloads retain the existing field-name shape.  This makes the
    contract the only place that can translate the caller's values to a row and
    prevents changing a record/key/type/code by changing payload names or values.
    """
    bindings = rule.get("record_bindings")
    if bindings is None:
        return
    candidates = [binding for binding in bindings if binding.get("record_id") == record_id]
    if len(candidates) != 1:
        raise ValueError(
            "record binding not allowed: record_id is not bound by the controlled update contract: "
            + record_id
        )
    binding = candidates[0]
    field_ids = {str(name): str(field_id) for name, field_id in (asset.field_ids or {}).items()}
    id_to_name = {field_id: name for name, field_id in field_ids.items()}
    immutable = binding["immutable_expected_fields"]
    allowed = binding["allowed_patch_values"]
    expected_by_name = {id_to_name[field_id]: value for field_id, value in immutable.items()}
    allowed_by_name = {id_to_name[field_id]: values for field_id, values in allowed.items()}
    if expected != expected_by_name:
        raise ValueError(
            "record binding expected_fields mismatch for record_id=" + record_id
        )
    if set(patch) != set(allowed_by_name):
        raise ValueError(
            "record binding patch fields mismatch for record_id=" + record_id
        )
    if verify != patch:
        raise ValueError(
            "record binding verify_fields must exactly match patch for record_id="
            + record_id
        )
    for field, values in allowed_by_name.items():
        if not any(
            _field_value_matches(patch[field], allowed_value, field_types.get(field, ""))
            for allowed_value in values
        ):
            raise ValueError(
                "record binding patch value is not allowed: "
                f"record_id={record_id} field={field} value={patch[field]!r}"
            )


def _validate_record_binding_live_field_ids(
    asset: AssetContract,
    rule: dict[str, Any],
    live_field_ids: dict[str, str],
) -> None:
    """Require every bound field to retain its contract field ID before writing."""
    bindings = rule.get("record_bindings")
    if bindings is None:
        return
    bound_ids = set()
    for binding in bindings:
        bound_ids.update(binding["immutable_expected_fields"])
        bound_ids.update(binding["allowed_patch_values"])
    for field_id in bound_ids:
        field_name = next(
            name for name, candidate_id in asset.field_ids.items()
            if candidate_id == field_id
        )
        if live_field_ids.get(field_name) != field_id:
            raise ValueError(
                "record binding live field_id mismatch: "
                f"field={field_name} expected={field_id} actual={live_field_ids.get(field_name)!r}"
            )


def _controlled_record_delete_rule(
    asset: AssetContract,
    *,
    caller_session: str,
    record_id: str,
) -> dict[str, Any]:
    """Resolve the one exact delete grant for this owner and record.

    A contract for this operation is intentionally not a broad owner privilege:
    validation requires its sole caller to be ``asset.owner_session`` and every
    candidate record to be named in an ID-bound binding.  Looking up by target
    record here means a second rule for another record cannot accidentally
    authorize this deletion.
    """
    candidates = []
    for rule in asset.controlled_data_time_updates:
        if rule.get("op") != "bitable_record_delete_if_current":
            continue
        if caller_session not in (rule.get("caller_sessions") or []):
            continue
        bindings = rule.get("delete_bindings") or []
        if any(binding.get("record_id") == record_id for binding in bindings):
            candidates.append(rule)
    if not candidates:
        raise ValueError(
            "controlled delete not allowed: "
            f"caller_session={caller_session} record_id={record_id} asset={asset.asset_id}"
        )
    if len(candidates) != 1:
        raise ValueError(
            "overlapping controlled delete rules: "
            f"caller_session={caller_session} record_id={record_id} asset={asset.asset_id}"
        )
    return candidates[0]


def _validate_delete_binding_payload(
    asset: AssetContract,
    rule: dict[str, Any],
    *,
    record_id: str,
    expected: dict[str, Any],
) -> None:
    """Match a delete payload to the contract's exact ID-bound preimage."""
    candidates = [
        binding for binding in rule["delete_bindings"]
        if binding["record_id"] == record_id
    ]
    if len(candidates) != 1:
        raise ValueError(
            "delete binding not allowed: record_id is not bound by the controlled delete "
            "contract: " + record_id
        )
    id_to_name = {
        str(field_id): str(name)
        for name, field_id in (asset.field_ids or {}).items()
    }
    expected_by_name = {
        id_to_name[field_id]: value
        for field_id, value in candidates[0]["immutable_expected_fields"].items()
    }
    if expected != expected_by_name:
        raise ValueError(
            "delete binding expected_fields mismatch for record_id=" + record_id
        )


def _validate_delete_binding_live_field_ids(
    asset: AssetContract,
    rule: dict[str, Any],
    live_field_ids: dict[str, str],
) -> None:
    """Refuse to delete if any ID-bound snapshot field drifted live."""
    bound_ids = set()
    for binding in rule["delete_bindings"]:
        bound_ids.update(binding["immutable_expected_fields"])
    for field_id in bound_ids:
        field_name = next(
            name for name, candidate_id in asset.field_ids.items()
            if candidate_id == field_id
        )
        if live_field_ids.get(field_name) != field_id:
            raise ValueError(
                "delete binding live field_id mismatch: "
                f"field={field_name} expected={field_id} "
                f"actual={live_field_ids.get(field_name)!r}"
            )


def _marker_for_line(line: str, markers: list[str]) -> str | None:
    if line.endswith("\r\n"):
        body = line[:-2]
    elif line.endswith(("\r", "\n")):
        body = line[:-1]
    else:
        body = line
    token = _MARKER_LINE_TAIL_TOKEN_RE.search(body)
    if token is None or token.group("namespace") not in markers:
        return None
    return token.group("marker")


def _validate_marker_line_protection(
    rule: dict[str, Any], expected: dict[str, Any], patch: dict[str, Any],
) -> None:
    protection = rule.get("marker_line_protection")
    if protection is None:
        return
    field = protection["field"]
    if field not in patch:
        return
    before = expected[field]
    after = patch[field]
    if not isinstance(before, str) or not isinstance(after, str):
        raise ValueError("marker line protection requires text expected_fields and patch values")
    markers = list(protection["markers"])

    def split(value: str) -> tuple[list[str], dict[str, list[str]]]:
        manual: list[str] = []
        marker_lines: dict[str, list[str]] = {}
        for line in value.splitlines(keepends=True):
            marker = _marker_for_line(line, markers)
            if marker is None:
                manual.append(line)
            else:
                marker_lines.setdefault(marker, []).append(line)
        return manual, marker_lines

    before_manual, before_markers = split(before)
    after_manual, after_markers = split(after)
    separator_only_append = (
        any(after_markers.values())
        and bool(before_manual)
        and len(before_manual) == len(after_manual)
        and before_manual[:-1] == after_manual[:-1]
        and not before_manual[-1].endswith(("\n", "\r"))
        and after_manual[-1] in {
            f"{before_manual[-1]}\n", f"{before_manual[-1]}\r\n",
        }
    )
    if before_manual != after_manual and not separator_only_append:
        raise ValueError(
            f"marker line protection would overwrite non-marker text: field={field}"
        )
    for marker in set(before_markers) | set(after_markers):
        if len(before_markers.get(marker, [])) > 1 or len(after_markers.get(marker, [])) > 1:
            raise ValueError(
                f"marker line protection allows at most 1 line for marker={marker}"
            )
        if before_markers.get(marker) and not after_markers.get(marker):
            raise ValueError(
                f"marker line protection cannot remove marker line: marker={marker}"
            )
    replaced = [
        marker for marker in before_markers
        if marker in after_markers and before_markers[marker] != after_markers[marker]
    ]
    if len(replaced) > 1:
        raise ValueError(
            "marker line protection allows at most one existing marker identity replacement"
        )


def validate_record_update_if_current_payload(
    asset: AssetContract,
    payload: dict[str, Any],
    *,
    caller_session: str,
    client_key: str | None = None,
) -> tuple[TableContract, str, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Validate a controlled conditional update without touching Feishu."""
    validate_asset_contract(asset)
    if not asset.tables:
        raise ValueError("asset has no table contract")
    table = asset.tables[0]
    record_id = str(payload.get("record_id") or "")
    if not record_id:
        raise ValueError("record_id is required")
    if payload.get("app_token") != asset.base_token:
        raise ValueError("payload app_token does not match asset")
    if payload.get("table_id") != _table_id(asset, table):
        raise ValueError("payload table_id does not match asset")
    expected = payload.get("expected_fields")
    patch = payload.get("patch")
    verify = payload.get("verify_fields") or {}
    if not isinstance(expected, dict) or not expected:
        raise ValueError("expected_fields must be a non-empty object")
    if not isinstance(patch, dict) or not patch:
        raise ValueError("patch must be a non-empty object")
    if not isinstance(verify, dict):
        raise ValueError("verify_fields must be an object")

    # 2026-07-18 授权仪式退役：条件更新只认合同 controlled_data_time_updates 规则，
    # 不再有 message-bound value authorization 兜底。
    rule = _controlled_update_rule(
        asset,
        caller_session=caller_session,
        op="bitable_record_update_if_current",
        patch_fields=set(patch),
        client_key=client_key,
    )
    is_exact_separated_rule = is_exact_separated_record_update_rule(rule)
    if is_exact_separated_rule:
        required_patch_fields = set(rule.get("writable_fields") or [])
        if set(patch) != required_patch_fields:
            raise ValueError(
                "patch fields must exactly match controlled update contract: "
                f"required={sorted(required_patch_fields)} actual={sorted(patch)}"
            )
    if rule.get("composite_key_cas") is not None and "verify_fields" in payload:
        raise ValueError(
            "composite-key CAS derives exact post-state from expected_fields and patch; "
            "verify_fields must be omitted"
        )
    required_expected_fields = set(rule.get("expected_fields") or [])
    if rule.get("expected_fields_subset_allowed"):
        if not set(expected) <= required_expected_fields:
            raise ValueError(
                "expected_fields must be a subset of controlled update contract: "
                f"allowed={sorted(required_expected_fields)} actual={sorted(expected)}"
            )
    elif set(expected) != required_expected_fields:
        raise ValueError(
            "expected_fields must exactly match controlled update contract: "
            f"required={sorted(required_expected_fields)} actual={sorted(expected)}"
        )
    if rule.get("empty_expected_only"):
        field_types = _field_types(asset, table)
        for field in patch:
            if not _empty_expected_snapshot_value(expected[field], field_types.get(field, "")):
                raise ValueError(
                    "controlled update requires an empty expected snapshot for "
                    f"patch field {field}"
                )
    allowed_verify_fields = rule.get("verify_fields")
    if rule.get("verify_fields_exact"):
        required_verify_fields = set(allowed_verify_fields or [])
        if set(verify) != required_verify_fields:
            raise ValueError(
                "verify_fields must exactly match controlled update contract: "
                f"required={sorted(required_verify_fields)} actual={sorted(verify)}"
            )
    elif allowed_verify_fields is not None and not set(verify) <= set(allowed_verify_fields):
        raise ValueError(
            "verify_fields contains fields outside controlled update contract: "
            f"allowed={sorted(allowed_verify_fields)} actual={sorted(verify)}"
        )
    if rule.get("expected_fields_subset_allowed") and not set(patch) <= set(verify):
        raise ValueError(
            "verify_fields must include every patch field for a partial controlled update: "
            f"patch={sorted(patch)} verify={sorted(verify)}"
        )
    if is_exact_separated_rule and verify != patch:
        raise ValueError(
            "verify_fields values must match patch for an exact separated CAS rule"
        )
    _validate_marker_line_protection(rule, expected, patch)
    _validate_record_binding_payload(
        asset,
        rule,
        record_id=record_id,
        expected=expected,
        patch=patch,
        verify=verify,
        field_types=_field_types(asset, table),
    )
    return table, record_id, expected, patch, verify, rule


def validate_record_delete_if_current_payload(
    asset: AssetContract,
    payload: dict[str, Any],
    *,
    caller_session: str,
    client_key: str | None = None,
) -> tuple[TableContract, str, dict[str, Any], dict[str, Any]]:
    """Validate a contract-bound, exact single-record deletion without I/O.

    This deliberately has no generic owner fallback.  A deletion request must
    carry the exact registry-bound record ID, immutable preimage, and the same
    explicit confirmation reference that was published with the rule.
    """
    validate_asset_contract(asset)
    if not asset.tables:
        raise ValueError("asset has no table contract")
    if not isinstance(payload, dict):
        raise ValueError("delete payload must be an object")
    expected_payload_keys = {
        "app_token", "table_id", "record_id", "expected_fields", "confirmation_ref",
    }
    if set(payload) != expected_payload_keys:
        raise ValueError(
            "delete payload must contain only app_token, table_id, record_id, "
            "expected_fields, and confirmation_ref"
        )
    table = asset.tables[0]
    record_id = str(payload.get("record_id") or "")
    if not record_id:
        raise ValueError("record_id is required")
    if payload.get("app_token") != asset.base_token:
        raise ValueError("payload app_token does not match asset")
    if payload.get("table_id") != _table_id(asset, table):
        raise ValueError("payload table_id does not match asset")
    expected = payload.get("expected_fields")
    if not isinstance(expected, dict) or not expected:
        raise ValueError("expected_fields must be a non-empty object")

    rule = _controlled_record_delete_rule(
        asset, caller_session=caller_session, record_id=record_id,
    )
    if not isinstance(client_key, str) or not client_key:
        raise ValueError("controlled delete requires a queue dedupe key")
    if client_key != rule["dedupe_key"]:
        raise ValueError("dedupe key does not match controlled delete contract")
    required_expected_fields = set(rule["expected_fields"])
    if set(expected) != required_expected_fields:
        raise ValueError(
            "expected_fields must exactly match controlled delete contract: "
            f"required={sorted(required_expected_fields)} actual={sorted(expected)}"
        )
    if payload.get("confirmation_ref") != rule["confirmation_ref"]:
        raise ValueError("confirmation_ref does not match controlled delete contract")
    _validate_delete_binding_payload(
        asset, rule, record_id=record_id, expected=expected,
    )
    return table, record_id, expected, rule


def _bitable_composite_key_cas_update(
    asset: AssetContract,
    table: TableContract,
    record_id: str,
    expected: dict[str, Any],
    patch: dict[str, Any],
    rule: dict[str, Any],
    *,
    caller_session: str,
    lark: LarkCli,
    actor: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Apply an explicitly contracted single-row composite-key CAS update.

    The public queue's per-asset lock serializes this sequence with other queued
    writes.  The key lock also serializes create-if-absent work for the proposed
    key, so the preflight collision check and this one-row mutation are one
    critical section inside the local public write mechanism.
    """
    composite = rule["composite_key_cas"]
    unique_key = list(composite["unique_key"])
    mutable_key_field = composite["mutable_key_fields"][0]
    if mutable_key_field not in patch:
        raise ValueError(
            "composite-key CAS patch must include the mutable composite-key field: "
            f"{mutable_key_field}"
        )
    proposed_key = {key: expected[key] for key in unique_key}
    proposed_key[mutable_key_field] = patch[mutable_key_field]
    blank_key = [
        key for key, value in proposed_key.items()
        if value is None or (isinstance(value, str) and not value.strip())
    ]
    if blank_key:
        raise ValueError(
            "proposed composite unique key must be non-empty: "
            + ", ".join(blank_key)
        )

    field_types = _field_types(asset, table)
    snapshot_fields = list(composite["snapshot_fields"])
    desired_fields = {field: expected[field] for field in snapshot_fields}
    desired_fields.update(patch)

    with _create_if_absent_key_lock(asset, table, proposed_key):
        live_field_ids = _live_field_ids(lark, asset, table, actor=actor)
        missing_live_fields = sorted(set(snapshot_fields) - set(live_field_ids))
        if missing_live_fields:
            raise ValueError(
                "live field ids missing for composite-key CAS snapshot: "
                + ", ".join(missing_live_fields)
            )

        before = _record_get(lark, asset, table, record_id, actor=actor)
        if before is None:
            raise ValueError(f"record_not_found: {record_id}")
        before_fields = before.get("fields", {})
        matches, field, expected_value, actual_value = _expected_fields_match(
            before_fields, expected, field_types
        )
        if not matches:
            raise ValueError(
                "state_drift/CAS conflict: snapshot_mismatch: "
                f"field={field} expected={expected_value} actual={actual_value} "
                f"record_id={record_id}"
            )

        proposed_matches = _search_all_records_by_key(
            lark, asset, table, proposed_key, actor=actor
        )
        collision_ids = sorted(
            str(record.get("record_id") or "")
            for record in proposed_matches
            if str(record.get("record_id") or "") != record_id
        )
        if collision_ids:
            raise ValueError(
                "composite unique-key collision: "
                f"proposed={proposed_key} existing_record_ids={collision_ids}"
            )

        write_attempted = any(
            not _field_value_matches(
                before_fields.get(field_name), value, field_types.get(field_name, "")
            )
            for field_name, value in patch.items()
        )
        if write_attempted:
            response = lark.run_json([
                "base", "+record-batch-update", "--as", actor,
                "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
                "--json", json.dumps({
                    "record_id_list": [record_id],
                    "patch": _wire_write_fields(
                        patch, field_types, field_ids=live_field_ids,
                    ),
                }, ensure_ascii=False, sort_keys=True),
            ])
            _require_verified_update_response(response, "record-batch-update")

        after = _record_get(lark, asset, table, record_id, actor=actor)
        after_fields = (after or {}).get("fields", {})
        final_matches, final_field, final_expected_value, final_actual_value = (
            _expected_fields_match(after_fields, desired_fields, field_types)
        )
        if not final_matches:
            return {
                "asset_id": asset.asset_id,
                "caller_session": caller_session,
                "mode": "record_update_if_current_composite_key",
                "created": 0,
                "updated": 1 if write_attempted else 0,
                "skipped": 0 if write_attempted else 1,
                "failed": 1,
                "record_ids": [record_id],
                "read_back_verified": False,
                "row_failures": [{
                    "phase": "read_back",
                    "record_id": record_id,
                    "field": final_field,
                    "expected": final_expected_value,
                    "actual": final_actual_value,
                    "error": f"field mismatch {final_field}",
                }],
            }

        final_matches_by_key = _search_all_records_by_key(
            lark, asset, table, proposed_key, actor=actor
        )
        final_ids = sorted(
            str(record.get("record_id") or "") for record in final_matches_by_key
        )
        if final_ids != [record_id]:
            raise ValueError(
                "composite unique-key collision after read-back: "
                f"proposed={proposed_key} record_ids={final_ids}"
            )

    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "record_update_if_current_composite_key",
        "created": 0,
        "updated": 1 if write_attempted else 0,
        "skipped": 0 if write_attempted else 1,
        "failed": 0,
        "record_ids": [record_id],
        "read_back_verified": True,
        "rows": [{
            "action": "update" if write_attempted else "skip",
            "record_id": record_id,
            "proposed_unique_key": proposed_key,
            "patch_fields": sorted(patch),
            "snapshot_fields": snapshot_fields,
            "source_message_id": payload.get("source_message_id", ""),
        }],
    }


def bitable_record_update_if_current(
    asset: AssetContract,
    payload: dict[str, Any],
    *,
    caller_session: str,
    lark: LarkCli | None = None,
    actor: str = "user",
    client_key: str | None = None,
) -> dict[str, Any]:
    """Queue-only conditional record patch.

    This is intentionally narrower than generic upsert: the caller must provide a
    record_id plus expected current fields. Drain reads the record immediately
    before patching and refuses to write if those fields drifted.
    """
    table, record_id, expected, patch, verify, rule = (
        validate_record_update_if_current_payload(
            asset,
            payload,
            caller_session=caller_session,
            client_key=client_key,
        )
    )
    patch_fields = set(patch)
    allowed_statuses = set(rule.get("allowed_statuses") or [])
    if "状态" in patch and allowed_statuses and patch["状态"] not in allowed_statuses:
        raise ValueError(f"target status not allowed: {patch['状态']}")
    if "状态" in expected and allowed_statuses and expected["状态"] not in allowed_statuses:
        raise ValueError(f"current status not allowed: {expected['状态']}")

    cli = lark or LarkCli()
    if rule.get("composite_key_cas") is not None:
        return _bitable_composite_key_cas_update(
            asset,
            table,
            record_id,
            expected,
            patch,
            rule,
            caller_session=caller_session,
            lark=cli,
            actor=actor,
            payload=payload,
        )
    field_types = _field_types(asset, table)
    bound_field_ids: dict[str, str] = {}
    if rule.get("record_bindings") is not None:
        bound_field_ids = _live_field_ids(cli, asset, table, actor=actor)
        _validate_record_binding_live_field_ids(asset, rule, bound_field_ids)
    before = _record_get(cli, asset, table, record_id, actor=actor)
    if before is None:
        raise ValueError(f"record_not_found: {record_id}")
    before_fields = before.get("fields", {})
    matches, field, expected_value, actual_value = _expected_fields_match(
        before_fields, expected, field_types)
    # Idempotence is a postcondition check, not a second CAS precondition:
    # expected_fields is the old snapshot, while patch/verify_fields describe
    # the state this job wants to leave behind.  A replay must close when the
    # desired state is already present even if a non-writable snapshot field
    # changed after the original write landed.
    desired_fields = {**patch, **verify}
    desired_matches, _, _, _ = _expected_fields_match(
        before_fields, desired_fields, field_types)
    if desired_matches:
        action = "idempotent_verified"
    elif not matches:
        if field == "状态":
            raise ValueError(
                "state_drift/CAS conflict: conflict_current_status:"
                f" expected={expected_value} actual={actual_value} record_id={record_id}"
            )
        raise ValueError(
            f"state_drift/CAS conflict: snapshot_mismatch: field={field} expected={expected_value}"
            f" actual={actual_value} record_id={record_id}"
        )
    else:
        action = "update"
    write_attempted = False
    if action == "update":
        write_attempted = True
        try:
            response = cli.run_json([
                # 系统写入必须走批量端点：飞书工作流 trigger_control_list 只排除
                # openAPIBatchUpdate 分类，单条 record-upsert 会被当人工编辑放行，
                # 误触发对端 webhook（2026-08-07 wh_supermatrix_session_runtime_settings_changed）。
                # CAS 的读前比对/写后核验都在 drain 应用层做，换端点不削弱合同。
                "base", "+record-batch-update", "--as", actor,
                "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
                "--json", json.dumps({
                    "record_id_list": [record_id],
                    "patch": _wire_write_fields(
                        patch,
                        field_types,
                        field_ids=bound_field_ids or None,
                    ),
                }, ensure_ascii=False, sort_keys=True),
            ])
            _require_verified_update_response(response, "record-batch-update")
        except Exception:
            # The write endpoint can mutate the remote row before transport or
            # response verification fails.  Read once at this boundary: if the
            # desired postcondition is true, settle this attempt as idempotent
            # success and never send the stale expected snapshot back to CAS.
            uncertain_after = _record_get(cli, asset, table, record_id, actor=actor)
            uncertain_fields = (uncertain_after or {}).get("fields", {})
            landed, _, _, _ = _expected_fields_match(
                uncertain_fields, desired_fields, field_types)
            if not landed:
                raise
            action = "idempotent_verified"

    after = _record_get(cli, asset, table, record_id, actor=actor)
    after_fields = (after or {}).get("fields", {})
    final_matches, final_field, final_expected_value, final_actual_value = _expected_fields_match(
        after_fields, desired_fields, field_types)
    if not final_matches:
        return {
            "asset_id": asset.asset_id,
            "caller_session": caller_session,
            "mode": "record_update_if_current",
            "created": 0,
            "updated": 1 if write_attempted else 0,
            "skipped": 0 if write_attempted else 1,
            "failed": 1,
            "record_ids": [record_id],
            "read_back_verified": False,
            "row_failures": [{
                "phase": "read_back",
                "record_id": record_id,
                "error": (
                    f"field mismatch {final_field}: expected={final_expected_value}"
                    f" actual={final_actual_value}"
                ),
            }],
        }

    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "record_update_if_current",
        "created": 0,
        "updated": 1 if write_attempted else 0,
        "skipped": 0 if write_attempted else 1,
        "failed": 0,
        "record_ids": [record_id],
        "read_back_verified": True,
        "rows": [{
            "action": action,
            "record_id": record_id,
            "patch_fields": sorted(patch_fields),
            "source_message_id": payload.get("source_message_id", ""),
        }],
    }


def bitable_record_delete_if_current(
    asset: AssetContract,
    payload: dict[str, Any],
    *,
    caller_session: str,
    lark: LarkCli | None = None,
    actor: str = "user",
    client_key: str | None = None,
) -> dict[str, Any]:
    """Delete exactly one contract-bound record if its immutable snapshot holds.

    The public queue's per-asset serialization is retained, but the remote API
    has no conditional-delete primitive.  Therefore this operation is narrower
    than set replace: it re-reads the exact record first, sends one deletion for
    one bound ``record_id``, then accepts success only when a second read proves
    absence.  A lost response is never replayed; it is settled only by that
    absence read-back.
    """
    table, record_id, expected, rule = validate_record_delete_if_current_payload(
        asset,
        payload,
        caller_session=caller_session,
        client_key=client_key,
    )
    cli = lark or LarkCli()
    field_types = _field_types(asset, table)

    before = _record_get(cli, asset, table, record_id, actor=actor)
    if before is None:
        return {
            "asset_id": asset.asset_id,
            "caller_session": caller_session,
            "mode": "record_delete_if_current",
            "created": 0,
            "updated": 0,
            "deleted": 0,
            "skipped": 1,
            "failed": 0,
            "record_ids": [record_id],
            "dedupe_key": client_key,
            "read_back_verified": True,
            "rows": [{
                "action": "already_absent",
                "record_id": record_id,
                "confirmation_ref": payload["confirmation_ref"],
            }],
        }

    live_field_ids = _live_field_ids(cli, asset, table, actor=actor)
    _validate_delete_binding_live_field_ids(asset, rule, live_field_ids)
    matches, field, expected_value, actual_value = _expected_fields_match(
        before.get("fields", {}), expected, field_types,
    )
    if not matches:
        raise ValueError(
            "state_drift/CAS conflict: snapshot_mismatch: "
            f"field={field} expected={expected_value} actual={actual_value} "
            f"record_id={record_id}"
        )

    command = [
        "base", "+record-delete", "--as", actor, "--yes",
        "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
        "--record-id", record_id,
    ]
    try:
        _run_json_single_attempt(cli, command)
    except Exception as delete_exc:  # noqa: BLE001 - absence read-back settles an unknown wire result
        try:
            uncertain_after = _record_get(cli, asset, table, record_id, actor=actor)
        except Exception as readback_exc:  # noqa: BLE001 - no replay when neither result can be proved
            raise AmbiguousDeleteReadBackError(
                "ambiguous delete read_back_not_verified; do not retry: "
                f"record_id={record_id}; delete_error={delete_exc}; "
                f"readback_error={readback_exc}"
            ) from readback_exc
        if uncertain_after is None:
            return {
                "asset_id": asset.asset_id,
                "caller_session": caller_session,
                "mode": "record_delete_if_current",
                "created": 0,
                "updated": 0,
                "deleted": 1,
                "skipped": 0,
                "failed": 0,
                "record_ids": [record_id],
                "dedupe_key": client_key,
                "read_back_verified": True,
                "rows": [{
                    "action": "delete_uncertain_but_readback_verified",
                    "record_id": record_id,
                    "confirmation_ref": payload["confirmation_ref"],
                }],
            }
        raise AmbiguousDeleteReadBackError(
            "ambiguous delete read_back_not_verified; do not retry: "
            f"record_id={record_id}; delete response failed but target is still present"
        ) from delete_exc

    try:
        after = _record_get(cli, asset, table, record_id, actor=actor)
    except Exception as readback_exc:  # noqa: BLE001 - a sent delete cannot be replayed without proof
        raise AmbiguousDeleteReadBackError(
            "ambiguous delete read_back_not_verified; do not retry: "
            f"record_id={record_id}; readback_error={readback_exc}"
        ) from readback_exc
    if after is not None:
        return {
            "asset_id": asset.asset_id,
            "caller_session": caller_session,
            "mode": "record_delete_if_current",
            "created": 0,
            "updated": 0,
            "deleted": 0,
            "skipped": 0,
            "failed": 1,
            "record_ids": [record_id],
            "dedupe_key": client_key,
            "read_back_verified": False,
            "row_failures": [{
                "phase": "read_back",
                "record_id": record_id,
                "error": "record still present after exact delete",
            }],
        }
    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "record_delete_if_current",
        "created": 0,
        "updated": 0,
        "deleted": 1,
        "skipped": 0,
        "failed": 0,
        "record_ids": [record_id],
        "dedupe_key": client_key,
        "read_back_verified": True,
        "rows": [{
            "action": "delete",
            "record_id": record_id,
            "confirmation_ref": payload["confirmation_ref"],
        }],
    }


def bitable_live_sync(
    asset: AssetContract,
    rows: list[dict[str, Any]],
    *,
    caller_session: str,
    lark: LarkCli | None = None,
    actor: str = "user",
    collapse_duplicates: bool = False,
    queue_op: str | None = None,
    migration_grant_fields: set[str] | None = None,
) -> dict[str, Any]:
    """collapse_duplicates=False（默认，plain upsert）：同一业务键在飞书命中多行即中止，
    因 upsert 无删除授权，静默挑一行写、忽略其余会掩盖脏数据。
    collapse_duplicates=True（仅 replace 调用）：保留 matches[0] 作权威行更新，其余副本的
    record_id 以 duplicate_extra_ids 报回，交由 replace 在 max_delete/delete_guard 下删除。
    queue_op：透传给 bitable_upsert_plan 的公共队列 op（见其 docstring）；仅 drain 的
    bitable_rows_upsert / bitable_rows_replace 分支传入，其余复用本函数（update_existing）
    的路径不传、维持 owner-only。"""
    validate_asset_contract(asset)
    if not asset.tables:
        raise ValueError("asset has no table contract")
    cli = lark or LarkCli()
    table = asset.tables[0]
    field_types = _field_types(asset)
    # 大批量快路径：整表预取一次建键索引，替代逐行 filter 搜索（语义与 _search_records_by_key
    # 等价：两边都用 _record_key 对全部唯一键做精确 AND 匹配）。
    bulk = len(rows) >= _BULK_SYNC_THRESHOLD
    remote_by_key: dict[tuple[str | frozenset[str], ...], list[dict[str, Any]]] = {}
    if bulk:
        remote_by_key = _group_records_by_key(
            _list_all_records(cli, asset, table, actor=actor), table.unique_key, field_types)
    existing_records: list[dict[str, Any]] = []
    duplicate_extra_ids: list[str] = []
    for row in rows:
        for key in table.unique_key:
            if not row.get(key):
                raise ValueError(f"missing unique key {key}")
        if bulk:
            matches = remote_by_key.get(_record_key(row, table.unique_key, field_types), [])
        else:
            matches = _search_records_by_key(cli, asset, table, row, actor=actor)
        if len(matches) > 1:
            if not collapse_duplicates:
                duplicate_ids = [str(m.get("record_id", "")) for m in matches]
                raise ValueError(
                    f"duplicate remote records for unique key {_record_key(row, table.unique_key, field_types)}:"
                    f" {', '.join(duplicate_ids)}")
            existing_records.append(matches[0])
            duplicate_extra_ids.extend(
                str(m.get("record_id", "")) for m in matches[1:] if m.get("record_id"))
        else:
            existing_records.extend(matches)
    plan = bitable_upsert_plan(
        asset,
        rows,
        caller_session=caller_session,
        existing_records=existing_records,
        queue_op=queue_op,
        migration_grant_fields=migration_grant_fields,
    )
    affected: list[tuple[dict[str, Any], str]] = []
    failed = 0
    # 观测（huodaiduijie 请求，只记录不改写入语义）：per-row/batch 失败的行键+字段摘要+飞书错误，
    # 落进 receipt 让「failed=N read_back_verified=False」能定位到具体是哪几行、什么错。上限 50 防 receipt 膨胀。
    row_failures: list[dict[str, Any]] = []
    batch_errors: list[dict[str, Any]] = []
    batch_error_total = 0
    unverified_update_record_ids: set[str] = set()
    create_submission_uncertain = False
    uncertain_creates: list[tuple[dict[str, Any], str]] = []
    if bulk:
        # 新建走 batch-create（200/批）；record_id 由终局读回按键补齐
        create_items = [item for item in plan["rows"] if item["action"] == "create"]
        if create_items:
            create_errors, create_error_total = _bulk_create_records(
                cli, asset, table, create_items, actor=actor, field_types=field_types
            )
            batch_errors.extend(create_errors)
            batch_error_total += create_error_total
            affected.extend((item, "") for item in create_items)
        update_items = [item for item in plan["rows"] if item["action"] == "update"]
        if update_items:
            try:
                field_ids = _live_field_ids(cli, asset, table, actor=actor)
            except Exception as exc:  # noqa: BLE001 - creates already submitted cannot be replayed
                if create_items:
                    raise AmbiguousCreateReadBackError(
                        "ambiguous create read_back_not_verified; do not retry: "
                        "post-create field read failed"
                    ) from exc
                raise
            update_errors, update_error_total, unverified_update_record_ids = _bulk_update_same_patch_records(
                cli,
                asset,
                table,
                update_items,
                actor=actor,
                field_ids=field_ids,
                field_types=field_types,
            )
            batch_errors.extend(update_errors[:max(0, 50 - len(batch_errors))])
            batch_error_total += update_error_total
            failed += len(unverified_update_record_ids)
            affected.extend((item, item["record_id"]) for item in update_items)
    live_update_field_ids: dict[str, str] = {}
    if not bulk and any(item["action"] == "update" for item in plan["rows"]):
        live_update_field_ids = _live_field_ids(cli, asset, table, actor=actor)
    for item in plan["rows"]:
        action = item["action"]
        if action == "skip" or (bulk and action in {"create", "update"}):
            continue
        command = [
            "base",
            "+record-upsert",
            "--as",
            actor,
            "--base-token",
            asset.base_token,
            "--table-id",
            _table_id(asset, table),
            "--json",
            json.dumps(
                _wire_write_fields(
                    item["write_fields"],
                    field_types,
                    field_ids=live_update_field_ids if action == "update" else None,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
        ]
        if action == "update":
            command.extend(["--record-id", item["record_id"]])
        try:
            response = cli.run_json(command)
        except Exception as exc:  # noqa: BLE001 - create may already have committed; read it back exactly
            if action == "create":
                uncertain_creates.append((item, f"create response uncertain: {exc}"))
                continue
            failed += 1
            if len(row_failures) < 50:
                row_failures.append({
                    "phase": action, "unique_key": item.get("unique_key"),
                    "field_summary": _row_field_summary(item), "error": str(exc)[:800],
                })
            continue
        record_id = _upsert_record_id(response)
        if action == "create" and not record_id:
            uncertain_creates.append((item, "create response omitted record_id"))
            continue
        affected.append((item, record_id))
    # 读回：优先 record-id 直读（不依赖搜索索引时效）；响应缺 id 时退回按键搜索
    affected_record_ids: list[str] = []
    if bulk:
        # 大批量读回：终局整表再取一次，按键裁决——恰好 1 行=成功；缺失=失败（含 batch
        # 异常批未落地）；>1 行=重复（plain upsert 必失败、requeue 后预取会以
        # duplicate remote records 显式报出）。replace 的收敛模式例外：它会验证指定
        # survivor，随后在同一操作的 delete phase 删除其它副本。
        try:
            final_by_key = _group_records_by_key(
                _list_all_records(
                    cli,
                    asset,
                    table,
                    actor=actor,
                    projected_fields=table.unique_key,
                ),
                table.unique_key,
                field_types,
            )
            # A batch-create response can be lost after Feishu accepted it. A
            # bounded second full read is the only permitted follow-up before
            # terminalizing uncertainty; never replay the batch-create itself.
            for _attempt in range(1, _AMBIGUOUS_CREATE_READBACK_ATTEMPTS):
                if not create_items or all(
                    len(final_by_key.get(
                        _record_key(item["unique_key"], table.unique_key, field_types), []
                    )) == 1
                    for item in create_items
                ):
                    break
                final_by_key = _group_records_by_key(
                    _list_all_records(
                        cli,
                        asset,
                        table,
                        actor=actor,
                        projected_fields=table.unique_key,
                    ),
                    table.unique_key,
                    field_types,
                )
        except Exception as exc:  # noqa: BLE001 - an accepted create may not be replayed
            if create_items:
                raise AmbiguousCreateReadBackError(
                    "ambiguous create read_back_not_verified; do not retry: "
                    "final bulk read-back failed"
                ) from exc
            raise
        candidate_ids = []
        for item, _record_id_unused in affected:
            candidates = final_by_key.get(
                _record_key(item["unique_key"], table.unique_key, field_types), [])
            if len(candidates) == 1:
                candidate_id = str(candidates[0].get("record_id") or "")
            elif collapse_duplicates and len(candidates) > 1:
                # replace deliberately keeps this originally selected survivor
                # until its delete phase; verify that row rather than treating
                # the expected interim duplicates as an upsert failure.
                candidate_id = str(item.get("record_id") or "")
            else:
                candidate_id = ""
            if candidate_id:
                candidate_ids.append(candidate_id)
        candidate_ids = list(dict.fromkeys(candidate_ids))
        read_fields = list(dict.fromkeys(
            table.unique_key
            + [field for item, _ in affected for field in item["write_fields"]]
        ))
        try:
            final_records_by_id = _records_get_by_ids(
                cli,
                asset,
                table,
                candidate_ids,
                actor=actor,
                field_names=read_fields,
            )
        except Exception as exc:  # noqa: BLE001 - batch creates may already be committed
            if create_items:
                raise AmbiguousCreateReadBackError(
                    "ambiguous create read_back_not_verified; do not retry: "
                    "final bulk record read-back failed"
                ) from exc
            raise
        for item, _record_id_unused in affected:
            candidates = final_by_key.get(
                _record_key(item["unique_key"], table.unique_key, field_types), [])
            if len(candidates) == 1 and candidates[0].get("record_id"):
                candidate_id = str(candidates[0]["record_id"])
                record = final_records_by_id.get(candidate_id)
                if record is not None and _write_fields_match(record, item, field_types):
                    affected_record_ids.append(candidate_id)
                else:
                    if item["action"] == "create":
                        create_submission_uncertain = True
                    if str(item.get("record_id") or "") not in unverified_update_record_ids:
                        failed += 1
                    if len(row_failures) < 50:
                        row_failures.append({
                            "phase": item.get("action"), "unique_key": item.get("unique_key"),
                            "field_summary": _row_field_summary(item),
                            "error": "final read-back field mismatch (see batch_errors for Feishu reason)",
                        })
            elif collapse_duplicates and len(candidates) > 1:
                candidate_id = str(item.get("record_id") or "")
                record = final_records_by_id.get(candidate_id)
                if record is not None and _write_fields_match(record, item, field_types):
                    affected_record_ids.append(candidate_id)
                else:
                    if item["action"] == "create":
                        create_submission_uncertain = True
                    if str(item.get("record_id") or "") not in unverified_update_record_ids:
                        failed += 1
                    if len(row_failures) < 50:
                        row_failures.append({
                            "phase": item.get("action"), "unique_key": item.get("unique_key"),
                            "field_summary": _row_field_summary(item),
                            "error": "final read-back field mismatch (see batch_errors for Feishu reason)",
                        })
            elif not candidates:
                if item["action"] == "create":
                    create_submission_uncertain = True
                if str(item.get("record_id") or "") not in unverified_update_record_ids:
                    failed += 1
                if len(row_failures) < 50:  # 观测：读回后缺行=真没落地，记键+字段（因归 batch_errors）
                    row_failures.append({
                        "phase": item.get("action"), "unique_key": item.get("unique_key"),
                        "field_summary": _row_field_summary(item),
                        "error": "not found in final read-back (see batch_errors for Feishu reason)",
                    })
            else:
                if item["action"] == "create":
                    create_submission_uncertain = True
                failed += 1
                if len(row_failures) < 50:
                    row_failures.append({
                        "phase": item.get("action"),
                        "unique_key": item.get("unique_key"),
                        "field_summary": _row_field_summary(item),
                        "error": "duplicate records in final read-back",
                        "record_ids": [
                            str(candidate.get("record_id") or "")
                            for candidate in candidates
                        ],
                    })
        read_back_verified = len(affected_record_ids) == len(affected)
        all_result_rows = [
            {"action": item["action"], "record_id": item["record_id"],
             "unique_key": item["unique_key"]}
            for item in plan["rows"]
        ]  # 大批量 receipt 瘦身：万行 job 的 fields/write_fields 全量入 receipt 会造 MB 级单行
        result_rows, rows_omitted = _bounded_receipt_list(all_result_rows)
        return {
            "asset_id": asset.asset_id,
            "caller_session": caller_session,
            "mode": "live",
            "created": plan["created"],
            "updated": plan["updated"],
            "skipped": plan["skipped"],
            "failed": failed,
            "record_ids": affected_record_ids,
            "record_ids_total": len(affected_record_ids),
            "record_ids_omitted": 0,
            "read_back_verified": read_back_verified and failed == 0,
            "rows": result_rows,
            "rows_total": len(all_result_rows),
            "rows_omitted": rows_omitted,
            "duplicate_extra_ids": duplicate_extra_ids,
            "row_failures": row_failures,
            "row_failures_total": failed,
            "row_failures_omitted": max(0, failed - len(row_failures)),
            "batch_errors": batch_errors,
            "batch_errors_total": batch_error_total,
            "batch_errors_omitted": max(0, batch_error_total - len(batch_errors)),
            "create_submission_uncertain": create_submission_uncertain,
        }
    expected_readbacks = sum(
        1 for item in plan["rows"] if item["action"] != "skip"
    )
    for item, record_id in affected:
        try:
            if record_id:
                record = _record_get(cli, asset, table, record_id, actor=actor)
            else:
                row_for_key = {key: item["unique_key"][key] for key in table.unique_key}
                matches = _search_records_by_key(cli, asset, table, row_for_key, actor=actor)
                record = matches[0] if len(matches) == 1 else None
                record_id = str(record.get("record_id", "")) if record else ""
        except Exception as exc:  # noqa: BLE001 - only creates convert uncertain read-back into terminal evidence
            if item["action"] == "create":
                uncertain_creates.append((item, f"record-id read-back uncertain: {exc}"))
                continue
            raise
        fields = (record or {}).get("fields", {})
        key_matches = record is not None and all(
            _canonical_key_value(fields.get(key, ""), field_types.get(key, ""))
            == _canonical_key_value(value, field_types.get(key, ""))
            for key, value in item["unique_key"].items()
        )
        fields_match = record is not None and _write_fields_match(record, item, field_types)
        # A stable record_id and unique key only prove that we found the right
        # row.  They do not prove an update landed: Feishu can acknowledge a
        # request while silently dropping an over-limit or otherwise unsupported
        # value.  Create and update therefore share the same field-level
        # postcondition.
        if record_id and key_matches and fields_match:
            affected_record_ids.append(record_id)
            continue
        if item["action"] == "create":
            reason = "record-id read-back did not verify the exact create"
            uncertain_creates.append((item, reason))
            continue
        failed += 1
        if len(row_failures) < 50:
            if record is None:
                error = "not found in final read-back"
            elif not key_matches:
                error = "unique key mismatch in final read-back"
            else:
                error = "final read-back field mismatch"
            row_failures.append({
                "phase": "read_back",
                "record_id": record_id,
                "unique_key": item.get("unique_key"),
                "field_summary": _row_field_summary(item),
                "error": error,
            })

    for item, submission_error in uncertain_creates:
        record, readback_error = _bounded_strict_create_readback(
            cli, asset, table, item, actor=actor,
        )
        if record is not None:
            affected_record_ids.append(str(record["record_id"]))
            continue
        failed += 1
        create_submission_uncertain = True
        if len(row_failures) < 50:
            row_failures.append({
                "phase": "create_read_back",
                "unique_key": item.get("unique_key"),
                "field_summary": _row_field_summary(item),
                "error": f"{submission_error}; {readback_error}"[:800],
            })

    read_back_verified = len(affected_record_ids) == expected_readbacks
    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "live",
        "created": plan["created"],
        "updated": plan["updated"],
        "skipped": plan["skipped"],
        "failed": failed,
        "record_ids": affected_record_ids,
        "read_back_verified": read_back_verified and failed == 0,
        "rows": plan["rows"],
        "duplicate_extra_ids": duplicate_extra_ids,
        "row_failures": row_failures,
        "batch_errors": batch_errors,
        "create_submission_uncertain": create_submission_uncertain,
    }


def bitable_rows_create_if_absent(
    asset: AssetContract,
    rows: list[dict[str, Any]],
    *,
    caller_session: str,
    lark: LarkCli | None = None,
    actor: str = "user",
) -> dict[str, Any]:
    """Create one fully specified initialization row, but never update an existing row.

    This is deliberately not a generic upsert escape hatch.  Contract validation
    makes the one allowed payload exact; a pre-existing Session record is returned
    as a verified skip, preserving Feishu-authoritative metadata (including an
    explicit ``false`` checkbox value).
    """
    table, _rule = validate_rows_create_if_absent_payload(
        asset, rows, caller_session=caller_session,
    )
    row = rows[0]
    cli = lark or LarkCli()
    # Keep the entire absent-check -> create -> read-back sequence inside the
    # same keyed process lock.  Full and scoped queue drains intentionally use
    # different drain locks, so their shared correctness boundary is here.
    with _create_if_absent_key_lock(asset, table, row):
        return _bitable_rows_create_if_absent_locked(
            asset, table, row, caller_session=caller_session, cli=cli, actor=actor,
        )


def _bitable_rows_create_if_absent_locked(
    asset: AssetContract,
    table: TableContract,
    row: dict[str, Any],
    *,
    caller_session: str,
    cli: Any,
    actor: str,
) -> dict[str, Any]:
    """Run the verified no-update operation while holding its exact-key lock."""
    field_types = _field_types(asset, table)
    matches = _search_all_records_by_key(cli, asset, table, row, actor=actor)
    if len(matches) > 1:
        raise ValueError(
            f"duplicate existing unique key: {_record_key(row, table.unique_key, field_types)}"
        )
    if matches:
        record_id = str(matches[0].get("record_id") or "")
        return {
            "asset_id": asset.asset_id,
            "caller_session": caller_session,
            "mode": "create_if_absent",
            "op": "bitable_rows_create_if_absent",
            "created": 0,
            "updated": 0,
            "skipped": 1,
            "failed": 0,
            "record_ids": [record_id] if record_id else [],
            "read_back_verified": bool(record_id),
            "create_submission_uncertain": False,
            "rows": [{
                "action": "skip_existing",
                "record_id": record_id,
                "unique_key": {key: row[key] for key in table.unique_key},
            }],
        }

    item = {
        "unique_key": {key: row[key] for key in table.unique_key},
        "write_fields": row,
    }
    submission_error = ""
    try:
        cli.run_json([
            "base", "+record-upsert", "--as", actor,
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
            "--json", json.dumps(row, ensure_ascii=False, sort_keys=True),
        ])
    except Exception as exc:  # noqa: BLE001 - accepted create must be read back, never replayed
        submission_error = f"create response uncertain: {exc}"
    record, readback_error = _bounded_strict_create_readback(
        cli, asset, table, item, actor=actor,
    )
    if record is None:
        return {
            "asset_id": asset.asset_id,
            "caller_session": caller_session,
            "mode": "create_if_absent",
            "op": "bitable_rows_create_if_absent",
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "failed": 1,
            "record_ids": [],
            "read_back_verified": False,
            "create_submission_uncertain": True,
            "row_failures": [{
                "phase": "read_back",
                "unique_key": {key: row[key] for key in table.unique_key},
                "error": f"{submission_error}; {readback_error}".strip("; "),
            }],
        }
    record_id = str(record.get("record_id") or "")
    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "create_if_absent",
        "op": "bitable_rows_create_if_absent",
        "created": 1,
        "updated": 0,
        "skipped": 0,
        "failed": 0,
        "record_ids": [record_id] if record_id else [],
        "read_back_verified": True,
        "create_submission_uncertain": False,
        "rows": [{
            "action": "create",
            "record_id": record_id,
            "unique_key": {key: row[key] for key in table.unique_key},
        }],
        "row_failures": [],
    }


_PAGE_LIMIT = 200
_DELETE_BATCH = 200  # 飞书 batch_delete 单请求记录数上限（实测 >200 报 validation: maximum limit of 200）


def _list_all_records(cli: Any, asset: AssetContract, table: TableContract, *,
                      actor: str, filter_json: str | None = None,
                      projected_fields: list[str] | None = None) -> list[dict[str, Any]]:
    """全量分页枚举（offset/limit）；record-list 单页 200 上限，必须翻完才能找全孤儿行。"""
    field_types = _field_types(asset)
    records: list[dict[str, Any]] = []
    offset = 0
    while True:
        command = [
            "base", "+record-list", "--as", actor,
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
            "--offset", str(offset), "--limit", str(_PAGE_LIMIT),
        ]
        if filter_json:
            command.extend(["--filter-json", filter_json])
        for field_name in projected_fields or []:
            command.extend(["--field-id", field_name])
        page = _lark_records_from_list(cli.run_json(command), field_types)
        records.extend(page)
        if len(page) < _PAGE_LIMIT:
            break
        offset += _PAGE_LIMIT
    return records


def _guard_filter_json(field: str, values: list[str]) -> str:
    conditions = [[field, "==", value] for value in values]
    return json.dumps({"logic": "or", "conditions": conditions}, ensure_ascii=False)


def bitable_rows_replace(
    asset: AssetContract,
    rows: list[dict[str, Any]],
    *,
    caller_session: str,
    delete_guard: dict[str, Any] | None,
    max_delete: int,
    lark: LarkCli | None = None,
    actor: str = "user",
    migration_grant_fields: set[str] | None = None,
) -> dict[str, Any]:
    """替换语义：upsert 入参行 + 删除孤儿行（in-scope 内、不在入参的）。

    delete_guard={field, values}：只有 `field` 值 ∈ `values` 的行才进删除候选，范围外行受保护。
    max_delete：孤儿数超过它则整单中止（不删任何行），防空 payload / 错 payload 清空表。
    """
    validate_asset_contract(asset)
    if not asset.tables:
        raise ValueError("asset has no table contract")
    check_controlled_rows_replace(
        asset, caller_session=caller_session, rows=rows,
        delete_guard=delete_guard, max_delete=max_delete)
    table = asset.tables[0]
    field_types = _field_types(asset)
    allowed = {field.name_zh for field in table.fields}
    if delete_guard is not None:
        guard_field = delete_guard["field"]
        guard_values = [str(v) for v in delete_guard["values"]]
        if guard_field not in allowed:
            raise ValueError(f"delete_guard field not in contract: {guard_field}")
    else:
        guard_field, guard_values = None, []
    cli = lark or LarkCli()

    # A replace is destructive after its upsert phase.  Before the first record
    # mutation, prove that every declared select value in this snapshot exists
    # in the live field options.  Otherwise Feishu can reject only some 200-row
    # batches and leave a partly refreshed table (job 98156, 2026-08-25).
    preflight_plan = bitable_upsert_plan(
        asset,
        rows,
        caller_session=caller_session,
        existing_records=[],
        existing_records_complete=False,
        queue_op="bitable_rows_replace",
        migration_grant_fields=migration_grant_fields,
    )
    _preflight_declared_select_options(
        asset,
        table,
        preflight_plan["rows"],
        cli=cli,
        actor=actor,
    )

    # 1) 先把入参行 upsert 进去（含 owner/字段/唯一键校验与读回）；
    #    collapse_duplicates=True：同键多份历史副本时保留一行更新，其余副本 record_id 报回待删。
    upsert = bitable_live_sync(asset, rows, caller_session=caller_session, lark=cli,
                               actor=actor, collapse_duplicates=True,
                               queue_op="bitable_rows_replace",
                               migration_grant_fields=migration_grant_fields)
    if not upsert.get("read_back_verified"):
        # A failed/ambiguous upsert may have committed only part of the payload.
        # Do not enumerate or delete orphans until the full target set is proven
        # present; replace must fail closed instead of deleting around a partial
        # write (job 98156, 2026-08-25).
        return {
            **upsert,
            "deleted": 0,
            "delete_failed": 0,
            "delete_batch_errors": [],
            "replace_aborted_before_delete": True,
            "read_back_verified": False,
        }

    # 2) 枚举 in-scope 现有行（guard 时服务端先过滤，客户端再精确复核）
    filter_json = _guard_filter_json(guard_field, guard_values) if guard_field else None
    existing = _list_all_records(cli, asset, table, actor=actor, filter_json=filter_json)
    existing_fields_by_id = {
        str(r["record_id"]): r.get("fields", {}) for r in existing if r.get("record_id")
    }
    payload_keys = {_record_key(row, table.unique_key, field_types) for row in rows}
    orphans = []
    for record in existing:
        fields = record.get("fields", {})
        if guard_field and str(fields.get(guard_field, "")) not in guard_values:
            continue  # 范围外，受保护
        if _record_key(fields, table.unique_key, field_types) in payload_keys:
            continue  # 仍在期望集合内（含被保留的权威行）
        if record.get("record_id"):
            orphans.append(str(record["record_id"]))

    # 多余副本（与 payload 键相同的历史重复行）：权威行已被 upsert 更新，多余副本进删除候选；
    # 同受 guard 约束——guard 时服务端已过滤出 in-scope，不在其中的副本视为受保护不删。
    extras = [
        rid for rid in upsert.get("duplicate_extra_ids", [])
        if (not guard_field
            or str(existing_fields_by_id.get(rid, {}).get(guard_field, "")) in guard_values)
    ]
    delete_targets = list(dict.fromkeys(orphans + extras))  # 去重保序

    # 3) 安全闸：删除总数（孤儿 + 多余副本）超上限，整单中止，不删任何行
    if len(delete_targets) > max_delete:
        raise ValueError(
            f"replace would delete {len(delete_targets)} rows > max_delete {max_delete};"
            f" aborting (asset={asset.asset_id})")

    # 4) 批量删除孤儿 + 多余副本（按 _DELETE_BATCH 分批，飞书 batch_delete 单请求上限 200；
    #    分批后逐批计数：某批失败只记该批 delete_failed，已删批次照常计入 deleted）
    deleted = 0
    delete_failed = 0
    delete_batch_errors: list[dict[str, Any]] = []  # 观测：删除失败批的 record_ids + 飞书错误
    for start in range(0, len(delete_targets), _DELETE_BATCH):
        batch = delete_targets[start:start + _DELETE_BATCH]
        command = [
            "base", "+record-delete", "--as", actor, "--yes",
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
        ]
        for record_id in batch:
            command.extend(["--record-id", record_id])
        try:
            cli.run_json(command)
            deleted += len(batch)
        except Exception as exc:  # noqa: BLE001 记删除失败批的键+飞书错误，别静默吞掉
            delete_failed += len(batch)
            if len(delete_batch_errors) < 50:
                delete_batch_errors.append({
                    "phase": "delete", "batch_start": start, "batch_rows": len(batch),
                    "record_ids": batch, "error": str(exc)[:800],
                })

    # 5) 读回：in-scope 每个 payload 键恰好剩 1 行（集合相等 + 无残留副本）
    final = _list_all_records(cli, asset, table, actor=actor, filter_json=filter_json)
    final_key_counts = Counter(
        _record_key(r.get("fields", {}), table.unique_key, field_types)
        for r in final
        if not guard_field or str(r.get("fields", {}).get(guard_field, "")) in guard_values
    )
    read_back_verified = (
        upsert["read_back_verified"] and delete_failed == 0
        and set(final_key_counts) == payload_keys
        and all(final_key_counts[k] == 1 for k in payload_keys)
    )
    # 透传内层 upsert 的逐行/批失败明细并叠加删除失败批——否则 drain 的 diag 取到 None，
    # failed=N 的失败 receipt 只剩计数、丢「是哪几行、什么错」（2026-07-23 job 78758：
    # failed=49 但 receipt 无 row_failures/batch_errors，因本 return 未透传）。上限 50 防膨胀。
    row_failures = upsert.get("row_failures", [])
    batch_errors_all = list(upsert.get("batch_errors") or []) + delete_batch_errors
    batch_errors = batch_errors_all[:50]
    batch_errors_total = (upsert.get("batch_errors_total") or 0) + len(delete_batch_errors)
    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "replace",
        "created": upsert["created"],
        "updated": upsert["updated"],
        "skipped": upsert["skipped"],
        "deleted": deleted,
        "failed": upsert["failed"] + delete_failed,
        "record_ids": upsert["record_ids"],
        "read_back_verified": read_back_verified,
        "row_failures": row_failures,
        "row_failures_total": upsert.get("row_failures_total", len(row_failures)),
        "row_failures_omitted": upsert.get("row_failures_omitted", 0),
        "batch_errors": batch_errors,
        "batch_errors_total": batch_errors_total,
        "batch_errors_omitted": max(0, batch_errors_total - len(batch_errors)),
    }


def bitable_attachment_upload(
    asset: AssetContract,
    unique_key_values: dict[str, Any],
    field: str,
    files: list[str],
    *,
    caller_session: str,
    lark: LarkCli | None = None,
    actor: str = "user",
) -> dict[str, Any]:
    """按唯一键定位已存在记录，上传文件到附件列并读回验证。记录不存在不创建。"""
    validate_asset_contract(asset)
    if not asset.tables:
        raise ValueError("asset has no table contract")
    check_controlled_attachment_upload(
        asset, field=field, unique_key_values=unique_key_values,
        caller_session=caller_session)
    table = _attachment_table(asset, field, unique_key_values)
    field_def = next((f for f in table.fields if f.name_zh == field), None)
    if field_def is None or field_def.type != "attachment":
        raise ValueError(f"attachment field not in contract: {field}")
    fallback_field = f"{field}_本地路径"
    fallback_def = next((f for f in table.fields if f.name_zh == fallback_field), None)
    fallback_column_available = fallback_def is not None and fallback_def.type == "text"
    for path in files:
        if not Path(path).is_absolute():
            raise ValueError(f"attachment file must be an absolute path: {path}")
        if not Path(path).exists():
            raise ValueError(f"attachment file does not exist: {path}")
    for key in table.unique_key:
        if not unique_key_values.get(key):
            raise ValueError(f"missing unique key {key}")
    cli = lark or LarkCli()
    matches = _search_records_by_key(cli, asset, table, unique_key_values, actor=actor)
    if len(matches) == 0:
        raise ValueError(f"target record not found for {unique_key_values}")
    if len(matches) > 1:
        raise ValueError(f"ambiguous target records for {unique_key_values}")
    attachment_rule = _controlled_attachment_grant(
        asset, caller_session=caller_session, field=field,
    ) if caller_session != asset.owner_session else None
    if attachment_rule is not None:
        _enforce_controlled_row_scope(
            attachment_rule, matches[0].get("fields", matches[0]),
        )
    record_id = str(matches[0]["record_id"])
    # lark-cli --file 拒绝绝对路径（路径安全约束），逐文件 cd 到所在目录传 basename。
    # 验证以「上传响应里 data.attachments 的累计附件数」为准（即时权威），不做独立 record-get
    # 读回：附件写入对后续 record-get 有最终一致性时延，独立读回会假阴性→重试→向单元格重复
    # 追加污染（实测追加过量后读回反而返回空）。
    last_response: dict[str, Any] = {}
    files_to_upload: list[str] = []
    local_path_fallback: list[str] = []
    oversized_skipped_no_fallback_column: list[dict[str, Any]] = []
    for path in files:
        p = Path(path)
        size = p.stat().st_size
        if size > ATTACHMENT_MAX_UPLOAD_BYTES:
            if fallback_column_available:
                local_path_fallback.append(str(p))
            else:
                oversized_skipped_no_fallback_column.append({
                    "file": str(p),
                    "size": size,
                    "want_column": fallback_field,
                })
            continue
        files_to_upload.append(path)

    # Attachment mutation is also ID-bound. The contract name is only the
    # stable in-memory/read-back label; passing it through --field-id lets a
    # remote CLI accept the request while targeting no writable field.
    live_field_ids = _live_field_ids(cli, asset, table, actor=actor) if (
        files_to_upload or local_path_fallback
    ) else {}
    field_id = live_field_ids.get(field)
    if files_to_upload and not field_id:
        raise ValueError(f"live field id missing for attachment field: {field}")
    fallback_field_id = live_field_ids.get(fallback_field)
    if local_path_fallback and not fallback_field_id:
        raise ValueError(f"live field id missing for fallback field: {fallback_field}")

    for path in files_to_upload:
        p = Path(path)
        last_response = cli.run_json([
            "base", "+record-upload-attachment", "--as", actor,
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
            "--record-id", record_id, "--field-id", field_id, "--file", p.name,
        ], cwd=str(p.parent), timeout=600)  # 附件(≤2GB)走 multipart 可能几分钟，给宽松墙钟上限
        # 飞书可能 ok=true 但 ignored_fields 静默忽略字段（如 MOBILE_ONLY）；抛真因让告警可执行。
        for ignored in (last_response.get("data") or {}).get("ignored_fields", []):
            if ignored.get("name") in {field, field_id}:
                raise ValueError(
                    f"attachment field {field} rejected by Feishu: {ignored.get('reason')}")
    if local_path_fallback:
        # 超限附件不进 attachment cell；同一批多个本地绝对路径固定用换行分隔写入回退文本列。
        existing_value = str(matches[0].get("fields", {}).get(fallback_field) or "").strip()
        fallback_value = "\n".join([v for v in [existing_value, *local_path_fallback] if v])
        cli.run_json([
            "base", "+record-upsert", "--as", actor,
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
            "--record-id", record_id,
            "--json", json.dumps(
                _wire_write_fields(
                    {fallback_field: fallback_value},
                    {fallback_field: fallback_def.type},
                    field_ids={fallback_field: fallback_field_id},
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
        ])
    cell = (last_response.get("data") or {}).get("attachments", {}).get(record_id, {})
    uploaded = sum(len(tokens) for tokens in cell.values() if isinstance(tokens, list))
    required_uploads = len(files_to_upload)
    upload_verified = uploaded >= required_uploads  # 末次响应累计附件数应 ≥ 本次需实际上传文件数
    verified = bool(files_to_upload) and upload_verified and not oversized_skipped_no_fallback_column
    return {
        "asset_id": asset.asset_id,
        "caller_session": caller_session,
        "mode": "attachment",
        "record_id": record_id,
        "field": field,
        "files": len(files),
        "uploaded": uploaded,
        "failed": 0 if verified else 1,
        "read_back_verified": verified,
        "local_path_fallback": local_path_fallback,
        "oversized_skipped_no_fallback_column": oversized_skipped_no_fallback_column,
        "attachment_size_threshold_bytes": ATTACHMENT_MAX_UPLOAD_BYTES,
    }
