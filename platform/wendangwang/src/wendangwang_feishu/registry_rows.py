from __future__ import annotations

import json
from typing import Any

from .models import AssetContract

# 列映射以 inventory/sm-docs-registry-live-sync-rows-2026-06-05.json（真实同步过的行）为 golden：
# - 对象类型：table → 表格，其余 → 文档
# - 字段合同 JSON：紧凑分隔符、按构造顺序（feishu_path → parent_ref → tables），文档资产 tables=[]
# - 远端 Token：canonical_token 优先，空则 base_token
# - 本地路径多段用 "\n" 连接；飞书路径用 " / " 连接（golden 之后新增列，仅表格侧消费）

_OBJECT_TYPE_ZH = {"table": "表格"}


def _field_contract_json(asset: AssetContract) -> str:
    payload: dict[str, Any] = {
        "feishu_path": asset.feishu_path,
        "parent_ref": asset.parent_ref,
        "tables": [
            {
                "table_id": t.table_id,
                "name_zh": t.name_zh,
                "description_zh": t.description_zh,
                "unique_key": t.unique_key,
                "fields": [
                    {
                        "name_zh": f.name_zh,
                        "type": f.type,
                        "description_zh": f.description_zh,
                        "authority": f.authority,
                        "required": f.required,
                    }
                    for f in t.fields
                ],
            }
            for t in asset.tables
        ],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def dogfood_mirror_rows(assets: list[AssetContract]) -> list[dict[str, Any]]:
    rows = []
    for asset in sorted(assets, key=lambda a: a.asset_id):
        rows.append({
            "资产 ID": asset.asset_id,
            "负责人 Session": asset.owner_session,
            "对象类型": _OBJECT_TYPE_ZH.get(asset.object_type, "文档"),
            "访问链接": asset.access_url,
            "对象标题": asset.title,
            "解决问题": asset.business_problem,
            "资产类型": asset.asset_category,
            "放置理由": asset.placement_reason,
            "权威模式": asset.authority_model,
            "同步方向": asset.sync_direction,
            "冲突策略": asset.conflict_policy,
            "飞书路径": " / ".join(asset.feishu_path),
            "父级 Ref": asset.parent_ref,
            "本地路径": "\n".join(asset.local_paths),
            "远端 Token": asset.canonical_token or asset.base_token,
            "表 ID": asset.table_id,
            "字段合同 JSON": _field_contract_json(asset),
            "最近同步状态": "已同步",
        })
    return rows
