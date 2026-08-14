#!/usr/bin/env python3
"""Pick and push five valuable AI/agent-engineering KB sources per week.

Deterministic and small: rank already-captured mythos KB sources, skip source
ids that were already pushed, send one notification card through SuperMatrix
/api/notify, then record the source ids only after a successful delivery.

Adapted from business-knowledge/scripts/push-wechat-daily-picks.py to mythos's
own source schema and AI/agent-engineering concept domains (harness / memory /
agent-dreaming / a2a / deep-research / multi-agent-orchestration /
prompt-engineering). Not the freshest source wins — the highest-value one does.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STATE = ROOT / "data" / "daily-picks" / "pushed.jsonl"
DEFAULT_RECEIPT = ROOT / "data" / "scheduler_receipts" / "kb-daily-picks.receipt"

# Value weighting keyed to mythos's concept domains + high-signal engineering
# topics. Higher weight == more load-bearing for an agent/harness engineer.
HIGH_VALUE_TAGS: dict[str, int] = {
    # harness
    "harness": 20,
    "agent-harness": 18,
    "durable-execution": 16,
    "state-machine": 14,
    "crash-recovery": 14,
    "context-engineering": 18,
    "context-rot": 12,
    "long-horizon": 16,
    # memory / agent-dreaming
    "memory": 20,
    "sleep-time-compute": 18,
    "agent-dreaming": 20,
    # multi-agent orchestration
    "multi-agent": 16,
    "orchestrator": 16,
    "subagent": 14,
    "managed-agents": 14,
    "parallel-execution": 12,
    "agent-framework": 12,
    # a2a
    "a2a": 18,
    "protocol": 12,
    "agent-card": 10,
    # deep research
    "deep-research": 18,
    # prompt engineering
    "prompt-engineering": 18,
    "production-prompt": 16,
    "system-prompt-leaks": 14,
    # tool / mcp layer
    "mcp": 14,
    "tool-calling": 12,
    "tool-use": 12,
    # agentic coding / evidence
    "agentic-coding": 14,
    "claude-code": 10,
    "codex": 10,
    "case-study": 12,
    "benchmark": 10,
    "sdk": 8,
}

# Bulk-intake and low-fidelity markers rank below hand-curated deep sources.
PENALTY_TAGS: dict[str, int] = {
    "url-only": -60,
    "needs-body-backfill": -60,
    "needs-mythos-review": -18,
    "newsletter-ingest": -6,
    "ai-valley-intake": -6,
    "announcement": -6,
    "funding": -14,
}

ACTION_KEYWORDS: dict[str, int] = {
    "架构": 6,
    "工程": 5,
    "机制": 5,
    "控制权": 8,
    "编排": 7,
    "记忆": 6,
    "上下文": 6,
    "复现": 6,
    "评测": 6,
    "反转": 7,
    "隔离": 6,
    "状态机": 7,
    "协议": 6,
    "harness": 6,
    "orchestration": 6,
    "protocol": 5,
    "benchmark": 5,
    "memory": 5,
}

LOW_SIGNAL_TITLE_KEYWORDS = ("融资", "发布会", "招聘", "raises", "funding", "hiring", "acquires")

# content_type that carries no readable body — never a candidate.
EXCLUDED_CONTENT_TYPES = {"unreachable"}

# content_type that tends to carry dense engineering substance.
SUBSTANCE_CONTENT_TYPES: dict[str, int] = {
    "paper": 8,
    "repo": 6,
    "repo-readme": 6,
    "docs": 5,
    "tutorial": 4,
    "blog": 3,
    "transcript": 3,
    "podcast": 2,
    "release-notes": 2,
    "model-card": 2,
}

# Ordered tag→concept-domain map. First matching cluster wins, so ordering
# encodes priority when a source is multi-tagged. Used for card-level domain
# spread (mythos's KB is domain-clustered, so author-dedup alone yields
# mono-domain cards — this is the mythos analogue of business-knowledge's
# per-account spread).
DOMAIN_CLUSTERS: tuple[tuple[str, frozenset[str]], ...] = (
    ("a2a-protocol", frozenset({"a2a", "agent-card"})),
    ("deep-research", frozenset({"deep-research"})),
    ("agent-dreaming", frozenset({"agent-dreaming", "sleep-time-compute"})),
    ("memory", frozenset({"memory"})),
    ("multi-agent-orchestration", frozenset({"multi-agent", "orchestrator", "subagent", "managed-agents", "parallel-execution"})),
    ("prompt-engineering", frozenset({"prompt-engineering", "production-prompt", "system-prompt-leaks", "context-engineering"})),
    ("tool-mcp", frozenset({"mcp", "tool-calling", "tool-use"})),
    ("harness", frozenset({"harness", "agent-harness", "durable-execution", "state-machine", "crash-recovery", "long-horizon"})),
)


def primary_domain(entry: SourceEntry) -> str:
    tags = set(entry.tags)
    for name, cluster in DOMAIN_CLUSTERS:
        if cluster & tags:
            return name
    return f"other:{entry.id}"


# Vendors whose primary sources are worth a small boost.
AUTHOR_BOOSTS: dict[str, int] = {
    "Anthropic": 6,
    "OpenAI": 5,
    "Google": 4,
    "LangChain": 4,
    "Letta": 6,
    "Microsoft Research": 5,
    "NousResearch": 4,
}


@dataclass(frozen=True)
class SourceEntry:
    id: str
    file: str
    title: str
    author: str
    source_url: str
    published: str
    captured: str
    content_type: str
    tags: tuple[str, ...]
    summary: str


@dataclass(frozen=True)
class Pick:
    source: SourceEntry
    score: int
    reason: str
    action: str


def load_sources(path: Path) -> list[SourceEntry]:
    entries: list[SourceEntry] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
        entries.append(
            SourceEntry(
                id=str(raw.get("id", "")),
                file=str(raw.get("file", "")),
                title=str(raw.get("title", "")),
                author=str(raw.get("author", "")),
                source_url=str(raw.get("source_url", "")),
                published=str(raw.get("published", "")),
                captured=str(raw.get("captured", "")),
                content_type=str(raw.get("content_type", "")),
                tags=tuple(str(t) for t in raw.get("tags", []) if t),
                summary=str(raw.get("summary", "")),
            )
        )
    return entries


def load_pushed_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    pushed: set[str] = set()
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
        source_id = raw.get("source_id")
        if isinstance(source_id, str) and source_id:
            pushed.add(source_id)
    return pushed


def parse_date_score(value: str) -> int:
    if not value or value == "unknown":
        return 0
    try:
        d = datetime.strptime(value[:10], "%Y-%m-%d").date()
    except ValueError:
        return 0
    today = datetime.now().date()
    age_days = max((today - d).days, 0)
    if age_days <= 3:
        return 6
    if age_days <= 14:
        return 4
    if age_days <= 60:
        return 2
    return 0


def is_kb_candidate(entry: SourceEntry) -> bool:
    if not entry.source_url:
        return False
    if entry.content_type in EXCLUDED_CONTENT_TYPES:
        return False
    tags = set(entry.tags)
    if {"url-only", "needs-body-backfill"} & tags:
        return False
    return True


def score_entry(entry: SourceEntry) -> int:
    tags = set(entry.tags)
    score = 20
    for tag, weight in HIGH_VALUE_TAGS.items():
        if tag in tags:
            score += weight
    for tag, penalty in PENALTY_TAGS.items():
        if tag in tags:
            score += penalty
    score += SUBSTANCE_CONTENT_TYPES.get(entry.content_type, 0)
    title_and_summary = f"{entry.title}\n{entry.summary}"
    for keyword, weight in ACTION_KEYWORDS.items():
        if keyword in title_and_summary:
            score += weight
    if any(k in entry.title for k in LOW_SIGNAL_TITLE_KEYWORDS):
        score -= 12
    for author, boost in AUTHOR_BOOSTS.items():
        if author in entry.author:
            score += boost
            break
    score += parse_date_score(entry.captured or entry.published)
    return score


# Per-domain card narrative. Keyed to primary_domain() so the reason/action a
# reader sees always matches the domain that made the pick distinct.
DOMAIN_REASON: dict[str, str] = {
    "harness": "讲的是把 context/git/cost/crash 的控制权从 LLM 收回到 harness 程序侧，判断你的 agent 谁在管这些。",
    "memory": "关乎 agent 记忆架构与离线巩固，能对照你自己 memory 层是写死 prompt 还是有独立存取。",
    "agent-dreaming": "讲的是 agent 离线巩固 / sleep-time compute，判断你的记忆层有没有独立于在线推理的整理环节。",
    "a2a-protocol": "是 agent 间互操作协议的一手材料，判断跨 agent 交接该走标准协议还是私有接口。",
    "deep-research": "拆的是研究型 agent 的取源—验证—合成回路，可直接对标你的 fan-out 检索与引用纪律。",
    "multi-agent-orchestration": "讲多 agent 编排与子 agent 隔离，能用于判断哪些活该 fan-out、哪些该串行。",
    "prompt-engineering": "是生产级 prompt / 上下文工程的可复用样本，能提炼进你自己的 system prompt 与上下文装配。",
    "tool-mcp": "讲工具/MCP 接入层，判断你的 agent 工具边界与调用契约是否收敛。",
}

DOMAIN_ACTION: dict[str, str] = {
    "harness": "挑你自己一个 agent，逐项列出 context/git/cost/crash 现在谁在管，把仍靠 LLM 自觉的那几项标成待收回。",
    "memory": "对照文中记忆架构，写下你的 KB/agent 记忆的读、写、巩固三条路径各落在哪，缺哪条。",
    "agent-dreaming": "对照文中离线巩固机制，判断你的 KB 有没有等价的定期整理/去重环节，缺则记一条待补。",
    "a2a-protocol": "拿一个现有跨 agent 交接场景，对照协议字段核一遍：能力发现、任务生命周期、产物返回各缺什么。",
    "deep-research": "把文中的取源—验证—合成回路和你 spawn 福尔摩斯的流程逐段对齐，标出你缺的对抗性验证环节。",
    "multi-agent-orchestration": "选一个近期多步任务，判断哪些子任务真无依赖可并行、哪些被误并行，重画一次编排图。",
    "prompt-engineering": "从文中抽 1 条可复用的 prompt/上下文装配技巧，落成你 concept 里的一句可引用规则再收工。",
    "tool-mcp": "列出你 agent 当前暴露的工具集，对照文中边界判断哪些该收窄、哪些调用契约该显式化。",
}


def build_reason(entry: SourceEntry) -> str:
    reason = DOMAIN_REASON.get(primary_domain(entry))
    if reason:
        return reason
    return (entry.summary[:90] + ("..." if len(entry.summary) > 90 else "")) or entry.title


def build_action(entry: SourceEntry) -> str:
    return DOMAIN_ACTION.get(
        primary_domain(entry),
        "读完只保留能写进某个 concept 或 SOP 的一条结论；不能落库的观点不进入合成层。",
    )


def choose_picks(entries: list[SourceEntry], pushed_ids: set[str], limit: int) -> list[Pick]:
    candidates = [e for e in entries if is_kb_candidate(e) and e.id not in pushed_ids]
    ranked = sorted(
        ((score_entry(e), e) for e in candidates),
        key=lambda item: (item[0], item[1].captured, item[1].published, item[1].id),
        reverse=True,
    )

    picks: list[Pick] = []
    used_authors: set[str] = set()
    used_domains: set[str] = set()
    chosen_ids: set[str] = set()

    def take(entry: SourceEntry, score: int) -> None:
        picks.append(Pick(source=entry, score=score, reason=build_reason(entry), action=build_action(entry)))
        used_authors.add(entry.author.strip() or "unknown")
        used_domains.add(primary_domain(entry))
        chosen_ids.add(entry.id)

    # Pass 1: highest-scored, unique author AND unique concept-domain.
    for score, entry in ranked:
        if len(picks) >= limit:
            break
        author_key = entry.author.strip() or "unknown"
        if author_key in used_authors or primary_domain(entry) in used_domains:
            continue
        take(entry, score)

    # Pass 2 (fallback): if too few distinct domains to fill the card, relax the
    # domain constraint but keep author-dedup — the hard rule from the spec.
    if len(picks) < limit:
        for score, entry in ranked:
            if len(picks) >= limit:
                break
            author_key = entry.author.strip() or "unknown"
            if entry.id in chosen_ids or author_key in used_authors:
                continue
            take(entry, score)

    return picks


def build_notify_body(picks: list[Pick], target_name: str) -> str:
    if not picks:
        return (
            f"今天没有找到可推送给 {target_name} 的未推送 KB source。\n"
            "候选池规则：已归档 source + 可达正文 + 未推送过。"
        )
    lines: list[str] = []
    for idx, pick in enumerate(picks, start=1):
        s = pick.source
        lines.extend(
            [
                f"**{idx}. [{s.id}] {s.title}**",
                f"作者：{s.author or 'unknown'}；发布：{s.published or 'unknown'}；评分：{pick.score}",
                f"为什么值得看：{pick.reason}",
                f"建议动作：{pick.action}",
                f"原文：{s.source_url}",
                "",
            ]
        )
    return "\n".join(lines).strip()


def notify(payload: dict[str, Any], api_port: str) -> dict[str, Any]:
    url = f"http://127.0.0.1:{api_port}/api/notify"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"notify failed HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"notify failed: {exc.reason}") from exc


def append_state(path: Path, picks: list[Pick], target_name: str, target_chat_id: str, message_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pushed_at = datetime.now(timezone.utc).isoformat()
    with path.open("a", encoding="utf-8") as fh:
        for pick in picks:
            fh.write(
                json.dumps(
                    {
                        "pushed_at": pushed_at,
                        "source_id": pick.source.id,
                        "score": pick.score,
                        "target_name": target_name,
                        "target_chat_id": target_chat_id,
                        "message_id": message_id,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )


def write_receipt(path: Path, result: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Push daily valuable mythos KB source picks.")
    parser.add_argument("--sources-jsonl", type=Path, default=ROOT / "kb" / "sources.jsonl")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--receipt", type=Path, default=DEFAULT_RECEIPT)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--target-name", default="xjbc")
    parser.add_argument("--target-chat-id", default=os.environ.get("SM_MYTHOS_DAILY_PICKS_CHAT_ID", ""))
    parser.add_argument("--api-port", default=os.environ.get("SM_API_PORT", "3501"))
    parser.add_argument("--source", default=os.environ.get("SM_SESSION_NAME", "mythos"))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.limit < 1:
        raise SystemExit("--limit must be >= 1")

    entries = load_sources(args.sources_jsonl)
    pushed_ids = load_pushed_ids(args.state)
    picks = choose_picks(entries, pushed_ids, args.limit)
    body = build_notify_body(picks, args.target_name)
    result: dict[str, Any] = {
        "ok": True,
        "status": "dry_run" if args.dry_run else "pending",
        "target_name": args.target_name,
        "picked": [p.source.id for p in picks],
        "scores": {p.source.id: p.score for p in picks},
        "body": body,
    }

    if args.dry_run:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if not args.target_chat_id.startswith("oc_"):
        raise SystemExit("--target-chat-id is required and must start with oc_")

    title = "每周 AI/agent 工程精选 Top 5" if picks else "每周 AI/agent 工程精选：本周无未推送候选"
    payload = {
        "source": args.source,
        "title": title,
        "body": body,
        "level": "info",
        "targetChatId": args.target_chat_id,
        "metadata": {
            "target_name": args.target_name,
            "picked_source_ids": [p.source.id for p in picks],
            "candidate_rule": "archived KB source + reachable body + not previously pushed",
            "state_file": str(args.state.relative_to(ROOT) if args.state.is_relative_to(ROOT) else args.state),
        },
    }
    notify_result = notify(payload, args.api_port)
    message_id = str(notify_result.get("messageId", ""))
    if not message_id:
        raise RuntimeError(f"notify returned no messageId: {notify_result}")

    append_state(args.state, picks, args.target_name, args.target_chat_id, message_id)
    result.update(
        {
            "status": "sent",
            "message_id": message_id,
            "notify": notify_result,
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    write_receipt(args.receipt, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
