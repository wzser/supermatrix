from __future__ import annotations

import json
import os
import subprocess
import urllib.request
from typing import Any, Callable

NOTIFY_URL = os.environ.get("SM_NOTIFY_URL", "").strip()
HEARTBEAT_ENQUEUE = os.environ.get("SM_HEARTBEAT_ENQUEUE", "").strip()
SOURCE_SESSION = os.environ.get("SM_SESSION_NAME", "").strip() or "user-agent"


def _post_json(url: str, payload: dict[str, Any]) -> bool:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return 200 <= response.status < 300


def _run_argv(argv: list[str]) -> int:
    return subprocess.run(argv, check=False, capture_output=True, text=True).returncode


def escalate(
    title: str,
    body: str,
    *,
    todo_key: str,
    user_visible: bool = False,
    level: str = "error",
    poster: Callable[[str, dict[str, Any]], bool] = _post_json,
    runner: Callable[[list[str]], int] = _run_argv,
) -> bool:
    """失败升级默认只回 heartbeat；用户裁决项显式 user_visible 才浮出 Console。"""
    ok = True
    if user_visible:
        if not NOTIFY_URL:
            return False
        try:
            ok = poster(NOTIFY_URL, {
                "source": SOURCE_SESSION,
                "title": title,
                "body": body,
                "level": level,
            }) and ok
        except Exception:
            ok = False
    if not HEARTBEAT_ENQUEUE:
        return False
    try:
        code = runner([
            HEARTBEAT_ENQUEUE,
            "--session", SOURCE_SESSION,
            "--key", todo_key,
            "--message", f"{title}：{body}。请按 sop/SOP-bitable-data-write-active-20260717-w4q8n2.md 异常表处置并回 receipt。",
            "--source", "feishu-sync",
            "--source-session", SOURCE_SESSION,
            "--source-ref", todo_key,
            "--todo-type", "spawn_closure",
        ])
        ok = (code == 0) and ok
    except Exception:
        ok = False
    return ok
