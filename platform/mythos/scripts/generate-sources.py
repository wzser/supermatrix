#!/usr/bin/env python3
"""
Batch-generate source files + jsonl entries for the 64 URLs from agent-reading-list.md.

Reads:
  - agent-reading-list.md (titles + annotations)
  - /tmp/kb-fetch/manifest.tsv (slug → url)
  - /tmp/kb-fetch/fetch-log.txt (slug → status)
  - /tmp/kb-fetch/<slug>.<ext> (fetched content, for OK ones)

Writes:
  - kb/sources/<date>_<slug>.md for each URL (frontmatter + fetched text or unreachable note)
  - appends to kb/sources.jsonl
"""
import html
import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent.parent.resolve()
KB = ROOT / "kb"
SOURCES = KB / "sources"
JSONL = KB / "sources.jsonl"
FETCH_DIR = Path("/tmp/kb-fetch")
MANIFEST = FETCH_DIR / "manifest.tsv"
LOG = FETCH_DIR / "fetch-log.txt"
READING_LIST = ROOT / "agent-reading-list.md"

CAPTURED = "2026-04-16"  # date the original ChatGPT list was assembled
START_ID = 4  # S0003 used by Harrison Chase

# Per-URL metadata: published date estimate, content_type, language, author, tags
URL_META = {
    "anthropic-multi-agent-research":       dict(ct="blog", lang="en", author="Anthropic", pub="2025-06-13", tags=["harness","multi-agent","anthropic","research"]),
    "anthropic-harness-long-running":       dict(ct="blog", lang="en", author="Anthropic", pub="2025-08-01", tags=["harness","long-running","planner-generator-evaluator","anthropic"]),
    "anthropic-c-compiler-parallel-claudes":dict(ct="blog", lang="en", author="Anthropic", pub="2025-09-15", tags=["harness","multi-agent","parallel","anthropic","case-study"]),
    "anthropic-effective-harnesses-long-running": dict(ct="blog", lang="en", author="Anthropic", pub="2025-10-12", tags=["harness","long-running","initializer-agent","anthropic"]),
    "anthropic-scaling-managed-agents":     dict(ct="blog", lang="en", author="Anthropic", pub="2025-11-20", tags=["harness","managed-agents","crash-recovery","sandbox","anthropic"]),
    "anthropic-context-engineering":        dict(ct="blog", lang="en", author="Anthropic", pub="2025-12-15", tags=["context-engineering","memory","compaction","subagent","anthropic"]),
    "anthropic-subagents-claude-code":      dict(ct="blog", lang="en", author="Anthropic", pub="2025-11-05", tags=["subagent","claude-code","anthropic","anti-pattern"]),
    "anthropic-writing-effective-tools":    dict(ct="blog", lang="en", author="Anthropic", pub="2025-10-01", tags=["tool-design","harness","anthropic"]),
    "anthropic-demystifying-evals":         dict(ct="blog", lang="en", author="Anthropic", pub="2025-09-10", tags=["eval","harness","anthropic"]),
    "hermes-agent-repo":                    dict(ct="repo", lang="en", author="NousResearch", pub="unknown", tags=["harness","self-improving","open-source","hermes"]),
    "hermes-multi-agent-umbrella":          dict(ct="docs", lang="en", author="NousResearch", pub="2025-12-01", tags=["multi-agent","roadmap","dag","hermes"]),
    "datacamp-hermes-agent-tutorial":       dict(ct="blog", lang="en", author="DataCamp",    pub="2025-11-01", tags=["tutorial","hermes","mcp","delegate-task"]),
    "openclaw-gateway-architecture":        dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["harness","gateway","control-plane","openclaw"]),
    "openclaw-multi-agent-routing":         dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["multi-agent","routing","workspace","openclaw"]),
    "openclaw-session-tools":               dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["session","tools","spawn","yield","openclaw"]),
    "openclaw-acp-agents":                  dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["acp","interop","claude-code","codex","openclaw"]),
    "openclaw-sessions-spawn":              dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["subagent","spawn","isolation","openclaw"]),
    "openclaw-delegate-architecture":       dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["delegate","identity","credentials","openclaw"]),
    "microsoft-magentic-one":               dict(ct="blog", lang="en", author="Microsoft Research", pub="2024-11-04", tags=["multi-agent","orchestrator","task-ledger","magentic-one"]),
    "anthropic-context-editing-docs":       dict(ct="docs", lang="en", author="Anthropic",   pub="2025-09-01", tags=["context-editing","memory","anthropic"]),
    "anthropic-long-running-claude-research":dict(ct="blog",lang="en", author="Anthropic",   pub="2025-08-15", tags=["long-running","memory","changelog","portable-memory","anthropic"]),
    "anthropic-managed-agents-memory":      dict(ct="docs", lang="en", author="Anthropic",   pub="2025-11-01", tags=["memory-api","durable-learnings","version","multi-store","anthropic"]),
    "anthropic-subagents-docs":             dict(ct="docs", lang="en", author="Anthropic",   pub="2025-11-05", tags=["subagent","memory-isolation","claude-code","anthropic"]),
    "nist-rfi-agentic-security":            dict(ct="paper",lang="en", author="Anthropic (NIST RFI)", pub="2025-03-14", tags=["memory-poisoning","security","agentic","nist"]),
    "openai-context-personalization":       dict(ct="docs", lang="en", author="OpenAI",      pub="2025-10-10", tags=["memory","distillation","consolidation","forgetting","injection","openai"]),
    "openai-long-horizon-codex":            dict(ct="blog", lang="en", author="OpenAI",      pub="2025-11-15", tags=["long-horizon","codex","durable-memory","markdown-memory","openai"]),
    "openai-inhouse-data-agent":            dict(ct="blog", lang="en", author="OpenAI",      pub="2025-09-20", tags=["data-agent","memory","correction-filters","openai"]),
    "google-context-aware-multi-agent":     dict(ct="blog", lang="en", author="Google",      pub="2025-10-05", tags=["multi-agent","working-context","session","memory","artifacts","google"]),
    "aws-agentcore-longterm-memory":        dict(ct="blog", lang="en", author="AWS",         pub="2025-10-15", tags=["long-term-memory","pipeline","agentcore","aws"]),
    "aws-agentcore-episodic-memory":        dict(ct="blog", lang="en", author="AWS",         pub="2025-10-20", tags=["episodic-memory","experience","agentcore","aws"]),
    "microsoft-plugmem":                    dict(ct="blog", lang="en", author="Microsoft Research", pub="2025-06-10", tags=["memory","facts","skills","plugmem"]),
    "microsoft-corpgen":                    dict(ct="blog", lang="en", author="Microsoft Research", pub="2025-07-15", tags=["memory-isolation","tiered-memory","adaptive-summarization","corpgen"]),
    "microsoft-memento":                    dict(ct="blog", lang="en", author="Microsoft Research", pub="2025-08-20", tags=["self-managed-context","memento","microsoft"]),
    "arxiv-memoryarena":                    dict(ct="paper",lang="en", author="(arxiv)",     pub="2026-02-01", tags=["benchmark","memory","multi-session","arxiv"]),
    "openreview-agentmemorybench":          dict(ct="paper",lang="en", author="(openreview)",pub="unknown",    tags=["benchmark","memory","continual-learning","agentmemorybench"]),
    "openreview-memagents-iclr":            dict(ct="paper",lang="en", author="(ICLR 2026)", pub="unknown",    tags=["workshop","memagents","iclr"]),
    "arxiv-cmv":                            dict(ct="paper",lang="en", author="(arxiv)",     pub="2026-02-22", tags=["memory-virtualization","cmv","arxiv"]),
    "langchain-context-engineering":        dict(ct="blog", lang="en", author="LangChain",   pub="2025-09-15", tags=["context-engineering","memory","ram-metaphor","langchain"]),
    "morphllm-context-engineering":         dict(ct="blog", lang="en", author="MorphLLM",    pub="2025-10-01", tags=["context-engineering","claude-md","lazy-loading","subagent","morphllm"]),
    "letta-sleep-time-compute-blog":        dict(ct="blog", lang="en", author="Letta",       pub="2025-05-01", tags=["sleep-time-compute","dreaming","memory-reconsolidation","letta"]),
    "arxiv-sleep-time-compute":             dict(ct="paper",lang="en", author="Letta et al.",pub="2025-04-17", tags=["sleep-time-compute","test-time-compute","swe","arxiv"]),
    "letta-sleeptime-docs":                 dict(ct="docs", lang="en", author="Letta",       pub="2025-10-01", tags=["sleep-time","agent","shared-memory","letta"]),
    "letta-code-memory":                    dict(ct="docs", lang="en", author="Letta",       pub="2025-12-01", tags=["memory","reflection","letta-code"]),
    "letta-code-subagents":                 dict(ct="docs", lang="en", author="Letta",       pub="2025-12-01", tags=["subagent","reflection","letta-code"]),
    "openclaw-dreaming":                    dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["dreaming","light-deep-rem","dreams-md","openclaw"]),
    "openclaw-memory-overview":             dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["memory","promotion-gates","recall","openclaw"]),
    "openclaw-cli-memory":                  dict(ct="docs", lang="en", author="OpenClaw",    pub="2026-01-10", tags=["cli","memory","rem-harness","openclaw"]),
    "arxiv-mirror":                         dict(ct="paper",lang="en", author="(arxiv)",     pub="2025-06-01", tags=["talker-thinker","async-deliberation","mirror","arxiv"]),
    "arxiv-trajectory-informed-memory":     dict(ct="paper",lang="en", author="IBM",         pub="2026-03-10", tags=["trajectory-memory","experience","ibm","arxiv"]),
    "arxiv-erl-reflective-learning":        dict(ct="paper",lang="en", author="(arxiv)",     pub="2026-03-24", tags=["reflective-learning","heuristics","erl","arxiv"]),
    "karpathy-autoresearch":                dict(ct="repo", lang="en", author="Andrej Karpathy", pub="unknown", tags=["autoresearch","optimization-loop","karpathy"]),
    "a2a-official-docs":                    dict(ct="docs", lang="en", author="A2A Project", pub="2025-12-01", tags=["a2a","protocol","agent-card","mcp"]),
    "a2a-official-spec":                    dict(ct="docs", lang="en", author="A2A Project", pub="2025-12-01", tags=["a2a","spec","task-lifecycle","artifact","streaming"]),
    "google-a2a-announcement":              dict(ct="blog", lang="en", author="Google",      pub="2025-04-09", tags=["a2a","announcement","first-principles","google"]),
    "google-a2a-samples":                   dict(ct="repo", lang="en", author="Google",      pub="unknown",    tags=["a2a","mcp","agent-card-registry","samples"]),
    "google-adk-a2a":                       dict(ct="docs", lang="en", author="Google",      pub="2025-10-01", tags=["adk","a2a","remote-agent","google"]),
    "google-agent-protocols-guide":         dict(ct="blog", lang="en", author="Google",      pub="2025-11-01", tags=["mcp","a2a","ucp","protocol-stack","google"]),
    "deeplearning-a2a-course":              dict(ct="blog", lang="en", author="DeepLearning.AI", pub="2025-11-15", tags=["course","a2a","hands-on","adk","langgraph","beeai"]),
    "ibm-a2a-beeai":                        dict(ct="blog", lang="en", author="IBM",         pub="2025-10-20", tags=["a2a","beeai","ollama","tutorial","ibm"]),
    "elastic-a2a-newsroom":                 dict(ct="blog", lang="en", author="Elastic",     pub="2025-11-01", tags=["a2a","mcp","newsroom","case-study","elastic"]),
    "gemini-enterprise-a2a":                dict(ct="docs", lang="en", author="Google Cloud",pub="2025-12-01", tags=["gemini","enterprise","a2a","agent-card","oauth"]),
    "microsoft-semantic-kernel-a2a":        dict(ct="blog", lang="en", author="Microsoft",   pub="2025-10-15", tags=["semantic-kernel","a2a","python","interop","microsoft"]),
    "microsoft-a2a-dotnet":                 dict(ct="blog", lang="en", author="Microsoft",   pub="2025-11-01", tags=["dotnet","a2a","sdk","inspector","microsoft"]),
    "microsoft-agent-framework-1":          dict(ct="blog", lang="en", author="Microsoft",   pub="2025-12-01", tags=["agent-framework","a2a","mcp","microsoft"]),
}


def parse_reading_list():
    """Parse agent-reading-list.md → {url: (title, annotation)}."""
    text = READING_LIST.read_text()
    out = {}
    pattern = re.compile(r"\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)\s*\n\s+(https?://\S+)")
    for m in pattern.finditer(text):
        title, annotation, url = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
        out[url] = (title, annotation)
    return out


def parse_manifest():
    out = []
    for line in MANIFEST.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        slug, url = line.split("\t", 1)
        out.append((slug, url))
    return out


def parse_log():
    """slug → (http_code, size)."""
    out = {}
    if not LOG.exists():
        return out
    for line in LOG.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            out[parts[0]] = (parts[1], int(parts[2]))
    return out


def strip_html_to_text(html_text):
    """Very light HTML → text. Keep structure via double-newlines between blocks."""
    # Remove script/style
    html_text = re.sub(r"<script.*?</script>", "", html_text, flags=re.S | re.I)
    html_text = re.sub(r"<style.*?</style>", "", html_text, flags=re.S | re.I)
    # Replace common block elements with newlines
    html_text = re.sub(r"<(br|p|div|li|tr|h[1-6]|section|article|header|footer|nav)[^>]*>", "\n", html_text, flags=re.I)
    html_text = re.sub(r"</(p|div|li|tr|h[1-6]|section|article|header|footer|nav)>", "\n", html_text, flags=re.I)
    # Strip remaining tags
    html_text = re.sub(r"<[^>]+>", " ", html_text)
    # Unescape entities
    html_text = html.unescape(html_text)
    # Collapse whitespace
    html_text = re.sub(r"[ \t]+", " ", html_text)
    html_text = re.sub(r"\n[ \t]+", "\n", html_text)
    html_text = re.sub(r"\n{3,}", "\n\n", html_text)
    return html_text.strip()


def main():
    url_to_anno = parse_reading_list()
    manifest = parse_manifest()
    log = parse_log()

    next_id = START_ID
    new_jsonl_lines = []

    for slug, url in manifest:
        title, annotation = url_to_anno.get(url, (slug, ""))
        meta = URL_META.get(slug, dict(ct="blog", lang="en", author="unknown", pub="unknown", tags=[slug]))

        sid = f"S{next_id:04d}"
        next_id += 1

        # Pick file date (prefer published, else captured)
        pub = meta["pub"]
        filedate = pub if pub and pub != "unknown" else CAPTURED
        fname = f"{filedate}_{slug}.md"
        out_path = SOURCES / fname

        code, size = log.get(slug, ("000", 0))
        # Decide if fetch yielded usable content
        fetched_ok = (code == "200" and size > 500)
        body_file = None
        for ext in ("html", "md", "pdf", "txt"):
            p = FETCH_DIR / f"{slug}.{ext}"
            if p.exists() and p.stat().st_size > 500:
                body_file = p
                break

        # Build body
        if fetched_ok and body_file and body_file.suffix == ".html":
            body = strip_html_to_text(body_file.read_text(errors="ignore"))
            body_note = f"_抓取成功 · HTML 已剥离为纯文本 · 原始文件：{body_file.name}_\n\n"
            body = body_note + body
            content_type = meta["ct"]
        elif fetched_ok and body_file and body_file.suffix == ".md":
            body = body_file.read_text(errors="ignore")
            content_type = meta["ct"]
        elif fetched_ok and body_file and body_file.suffix == ".pdf":
            body = f"_抓取成功 · PDF 文件存于 {body_file}（{size} 字节），需人工解析_\n\n**注释（摘自 agent-reading-list.md）**：{annotation}\n"
            content_type = meta["ct"]
        else:
            # unreachable
            body = f"**抓取失败**：HTTP code={code}, size={size} 字节。通常原因：SPA 需 JS 渲染 / 403 防爬 / 404 链接失效。\n\n**注释（摘自 agent-reading-list.md）**：{annotation}\n\n建议后续用浏览器抓取或查找镜像。\n"
            content_type = "unreachable"

        # Write source file
        frontmatter = (
            "---\n"
            f"id: {sid}\n"
            f"title: {title}\n"
            f"author: {meta['author']}\n"
            f"source_url: {url}\n"
            f"raw_url:\n"
            f"published: {meta['pub']}\n"
            f"captured: {CAPTURED}\n"
            f"content_type: {content_type}\n"
            f"language: {meta['lang']}\n"
            "license: unknown\n"
            "---\n\n"
        )
        out_path.write_text(frontmatter + body)

        # Build jsonl entry
        entry = {
            "id": sid,
            "file": f"sources/{fname}",
            "title": title,
            "author": meta["author"],
            "source_url": url,
            "raw_url": "",
            "published": meta["pub"],
            "captured": CAPTURED,
            "content_type": content_type,
            "language": meta["lang"],
            "license": "unknown",
            "tags": meta["tags"],
            "summary": annotation,
        }
        new_jsonl_lines.append(json.dumps(entry, ensure_ascii=False))

    # Append jsonl
    with JSONL.open("a") as f:
        for line in new_jsonl_lines:
            f.write(line + "\n")

    print(f"wrote {len(new_jsonl_lines)} sources, ids {START_ID:04d}..{next_id-1:04d}")


if __name__ == "__main__":
    main()
