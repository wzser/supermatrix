from __future__ import annotations

import json
import glob
from pathlib import Path
from typing import Any

from .models import AssetContract, FieldContract, TableContract
from .validation import ContractError, validate_asset_contract


_FRESHNESS_COUNT_MODES = {"raw_lines", "unique_key", "derived_rows", "fixed_rows"}
_FRESHNESS_AUDIT_EXEMPTION_KEYS = {"kind", "reason", "evidence"}
_FRESHNESS_AUDIT_EXEMPTION_KIND = "remote_authoritative"
_LIVE_APPEND_LAG_POLICY_KEYS = {
    "max_lag_rows",
    "non_growing_rounds_required",
}
_PRODUCT_TRACKER_DAILY_METRICS_PREFIX = "product-tracker.runtime.daily-metrics."
_PRODUCT_TRACKER_DAILY_MANUAL_FIELDS = ("需解决的问题", "采取的动作")


def _validate_freshness_contract(data: dict[str, Any]) -> None:
    exemption = data.get("freshness_audit_exemption")
    if exemption is not None:
        if not isinstance(exemption, dict):
            raise ContractError("freshness_audit_exemption must be an object")
        unknown = set(exemption) - _FRESHNESS_AUDIT_EXEMPTION_KEYS
        if unknown:
            raise ContractError(
                "freshness_audit_exemption has unknown keys: "
                + ", ".join(sorted(unknown))
            )
        if (
            data.get("object_type") != "table"
            or data.get("sync_direction") != "local_to_remote"
        ):
            raise ContractError(
                "freshness_audit_exemption requires object_type=table "
                "and sync_direction=local_to_remote"
            )
        if exemption.get("kind") != _FRESHNESS_AUDIT_EXEMPTION_KIND:
            raise ContractError(
                "freshness_audit_exemption.kind must be remote_authoritative"
            )
        for key in ("reason", "evidence"):
            if not isinstance(exemption.get(key), str) or not exemption[key].strip():
                raise ContractError(
                    f"freshness_audit_exemption.{key} must be a non-empty string"
                )

    mode = data.get("freshness_count_mode")
    expected_rows = data.get("freshness_expected_rows")
    fields = data.get("freshness_count_fields")
    paths = data.get("freshness_count_paths")
    exclude_paths = data.get("freshness_count_exclude_paths")
    if mode is None:
        if fields is not None:
            raise ContractError(
                "freshness_count_fields requires freshness_count_mode=derived_rows"
            )
        if expected_rows is not None:
            raise ContractError(
                "freshness_expected_rows requires freshness_count_mode=fixed_rows"
            )
        if paths is not None:
            raise ContractError(
                "freshness_count_paths requires freshness_count_mode=unique_key"
            )
        if exclude_paths is not None:
            raise ContractError(
                "freshness_count_exclude_paths requires freshness_count_paths"
            )
        return
    if mode not in _FRESHNESS_COUNT_MODES:
        raise ContractError(
            "freshness_count_mode must be one of derived_rows, fixed_rows, raw_lines, unique_key: "
            f"{mode}"
        )
    if mode == "derived_rows":
        if not isinstance(fields, list) or not fields or not all(
            isinstance(field, str) and field.strip() for field in fields
        ):
            raise ContractError(
                "freshness_count_fields must be a non-empty string list for derived_rows"
            )
    elif mode == "unique_key":
        tables = data.get("tables") or []
        target_table_id = data.get("table_id")
        table = next(
            (item for item in tables if item.get("table_id") == target_table_id),
            tables[0] if tables else {},
        )
        if not table.get("unique_key"):
            raise ContractError(
                "freshness_count_mode=unique_key requires a table unique_key"
            )
    elif mode == "fixed_rows":
        if data.get("authority_model") not in {"derived_mirror", "derived_projection"}:
            raise ContractError(
                "freshness_count_mode=fixed_rows requires a derived authority_model"
            )
        if (
            not isinstance(expected_rows, int)
            or isinstance(expected_rows, bool)
            or expected_rows < 0
        ):
            raise ContractError(
                "freshness_expected_rows must be a non-negative integer for fixed_rows"
            )
        if not isinstance(data.get("local_paths"), list) or not data["local_paths"]:
            raise ContractError(
                "freshness_count_mode=fixed_rows requires a declared local_paths source"
            )
    elif fields is not None:
        raise ContractError(
            "freshness_count_fields is only valid with freshness_count_mode=derived_rows"
        )
    if mode != "fixed_rows" and expected_rows is not None:
        raise ContractError(
            "freshness_expected_rows is only valid with freshness_count_mode=fixed_rows"
        )
    if paths is not None:
        if mode != "unique_key":
            raise ContractError(
                "freshness_count_paths requires freshness_count_mode=unique_key"
            )
        if not isinstance(paths, list) or not paths or not all(
            isinstance(path, str) and path.strip() for path in paths
        ):
            raise ContractError(
                "freshness_count_paths must be a non-empty string list"
            )
    if exclude_paths is not None:
        if paths is None:
            raise ContractError(
                "freshness_count_exclude_paths requires freshness_count_paths"
            )
        if not isinstance(exclude_paths, list) or not all(
            isinstance(path, str) and path.strip() for path in exclude_paths
        ):
            raise ContractError(
                "freshness_count_exclude_paths must be a string list"
            )
        if any(glob.has_magic(path) for path in exclude_paths):
            raise ContractError(
                "freshness_count_exclude_paths must contain explicit file paths"
            )


def _validate_live_append_lag_policy(data: dict[str, Any]) -> None:
    """校验 live-append 专属的行数滞后豁免，避免意外放宽普通镜像表。"""
    policy = data.get("live_append_lag_policy")
    if policy is None:
        return
    if not isinstance(policy, dict):
        raise ContractError("live_append_lag_policy must be an object")
    unknown = set(policy) - _LIVE_APPEND_LAG_POLICY_KEYS
    if unknown:
        raise ContractError(
            "live_append_lag_policy has unknown keys: " + ", ".join(sorted(unknown))
        )
    if data.get("object_type") != "table" or data.get("sync_direction") != "local_to_remote":
        raise ContractError(
            "live_append_lag_policy requires object_type=table and sync_direction=local_to_remote"
        )
    for key in _LIVE_APPEND_LAG_POLICY_KEYS:
        value = policy.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ContractError(f"live_append_lag_policy.{key} must be a positive integer")


def _validate_product_tracker_daily_metrics_contract(data: dict[str, Any]) -> None:
    asset_id = str(data.get("asset_id", ""))
    if not asset_id.startswith(_PRODUCT_TRACKER_DAILY_METRICS_PREFIX):
        return

    fields = {
        str(field.get("name_zh", "")): field
        for table in data.get("tables", [])
        for field in table.get("fields", [])
    }
    for name in _PRODUCT_TRACKER_DAILY_MANUAL_FIELDS:
        field = fields.get(name)
        if not field:
            raise ContractError(f"product-tracker daily metrics manual field missing: {name}")
        if field.get("authority") != "feishu":
            raise ContractError(f"{name} field authority must be feishu")

    write_constraints = data.get("write_constraints", {})
    for key in (
        "remote_authoritative_fields",
        "data_time_rows_must_omit_remote_authoritative_fields",
    ):
        values = write_constraints.get(key, [])
        for name in _PRODUCT_TRACKER_DAILY_MANUAL_FIELDS:
            if name not in values:
                raise ContractError(f"{key} must include {name}")


def _field(data: dict[str, Any]) -> FieldContract:
    options: list[dict[str, Any]] = []
    for item in data.get("options", []):
        if isinstance(item, str):
            options.append({"name": item})
        elif isinstance(item, dict):
            options.append(dict(item))
    option_source = data.get("option_source")
    if option_source is not None:
        raise ContractError(
            "option_source is not supported in the public export; "
            "use the owner-managed catalog projection"
        )
    return FieldContract(
        name_zh=str(data["name_zh"]),
        type=str(data["type"]),
        description_zh=str(data["description_zh"]),
        authority=data["authority"],
        required=bool(data.get("required", False)),
        allow_non_chinese_name=bool(data.get("allow_non_chinese_name", False)),
        non_chinese_reason=str(data.get("non_chinese_reason", "")),
        local_name=str(data.get("local_name", "")),
        options=options,
        default_value=(
            list(data["default_value"])
            if isinstance(data.get("default_value"), list)
            else None
        ),
        field_id=str(data.get("field_id", "")),
        option_source=option_source,
        button_config=(
            dict(data["button_config"])
            if isinstance(data.get("button_config"), dict)
            else None
        ),
        link_table=str(data.get("link_table", "")),
        bidirectional=bool(data.get("bidirectional", False)),
    )


def _table(data: dict[str, Any]) -> TableContract:
    return TableContract(
        table_id=str(data.get("table_id", "")),
        name_zh=str(data["name_zh"]),
        description_zh=str(data["description_zh"]),
        unique_key=[str(item) for item in data.get("unique_key", [])],
        fields=[_field(item) for item in data.get("fields", [])],
        field_groups=[dict(item) for item in data.get("field_groups", [])],
    )


def _build_asset(data: dict[str, Any]) -> AssetContract:
    return AssetContract(
        asset_id=str(data["asset_id"]),
        owner_session=str(data["owner_session"]),
        object_type=str(data["object_type"]),
        title=str(data["title"]),
        business_problem=str(data["business_problem"]),
        asset_category=data["asset_category"],
        placement_reason=str(data["placement_reason"]),
        authority_model=data["authority_model"],
        sync_direction=data["sync_direction"],
        conflict_policy=str(data["conflict_policy"]),
        queue_pending_policy=str(data.get("queue_pending_policy", "fifo")),
        surface_in_session_menu=data.get("surface_in_session_menu"),
        session_menu_label=data.get("session_menu_label"),
        access_url=str(data.get("access_url", "")),
        base_token=str(data.get("base_token", "")),
        table_id=str(data.get("table_id", "")),
        canonical_token=str(data.get("canonical_token", "")),
        local_paths=[str(item) for item in data.get("local_paths", [])],
        skip_freshness_audit=bool(data.get("skip_freshness_audit", False)),
        freshness_audit_exemption=(
            {
                "kind": str(data["freshness_audit_exemption"]["kind"]),
                "reason": str(data["freshness_audit_exemption"]["reason"]),
                "evidence": str(data["freshness_audit_exemption"]["evidence"]),
            }
            if isinstance(data.get("freshness_audit_exemption"), dict)
            else None
        ),
        freshness_count_mode=str(data.get("freshness_count_mode", "")),
        freshness_expected_rows=(
            int(data["freshness_expected_rows"])
            if data.get("freshness_expected_rows") is not None
            else None
        ),
        freshness_count_fields=[str(item) for item in data.get("freshness_count_fields", [])],
        freshness_count_paths=[str(item) for item in data.get("freshness_count_paths", [])],
        freshness_count_exclude_paths=[
            str(item) for item in data.get("freshness_count_exclude_paths", [])
        ],
        live_append_lag_policy={
            str(key): int(value)
            for key, value in (data.get("live_append_lag_policy") or {}).items()
        },
        feishu_path=[str(item) for item in data.get("feishu_path", [])],
        parent_ref=str(data.get("parent_ref", "")),
        tables=[_table(item) for item in data.get("tables", [])],
        controlled_data_time_updates=data.get("controlled_data_time_updates", []),
        field_ids={
            str(name): str(field_id)
            for name, field_id in (data.get("field_ids") or {}).items()
        },
        migration_write_exception=data.get("migration_write_exception"),
        migration_write_exceptions=data.get("migration_write_exceptions", []),
        migration_restore_exception=data.get("migration_restore_exception"),
    )


def load_asset_contract(path: Path) -> AssetContract:
    data = json.loads(path.read_text(encoding="utf-8"))
    _validate_freshness_contract(data)
    _validate_live_append_lag_policy(data)
    _validate_product_tracker_daily_metrics_contract(data)
    asset = _build_asset(data)
    validate_asset_contract(asset)
    return asset


def load_asset_contract_raw(path: Path) -> AssetContract:
    """加载合同草稿但不做完整校验（create-live 用：base_token/table_id 由创建产生）。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    _validate_freshness_contract(data)
    _validate_live_append_lag_policy(data)
    return _build_asset(data)
