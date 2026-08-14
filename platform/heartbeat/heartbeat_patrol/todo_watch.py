"""Bounded busy->idle watcher that drains a session's todo pool promptly.

启动来源有两个：enqueue-heartbeat-todo 的入队触发、巡检 drain miss 时的 re-arm。
watcher 不持有全局 patrol flock，只做轻量轮询；观察到目标 session 空闲并稳定
idle_debounce_seconds 后，通过子进程 `scripts/heartbeat-patrol --session <target>`
执行真正的注入（沿用既有 claim/锁语义），循环直到排空、暂停、不可用或到期。

注意：target 已经 idle 时不再等 batch settle window（默认 600s）。settle 仅作为
target 在线状态难以观测时的兜底，在 idle 直接观测路径上由 target_idle=True 显式 bypass。
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

WORKSPACE = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class WatchSettings:
    poll_seconds: float = 5.0
    idle_debounce_seconds: float = 8.0
    max_minutes: float = 45.0

    @property
    def max_seconds(self) -> float:
        return self.max_minutes * 60.0

    @property
    def claim_stale_after_seconds(self) -> int:
        # 崩溃残留的 claim 在 watch 上限之后允许被接管，留 5 分钟余量。
        return int(self.max_seconds) + 300


def watch_settings_from_config(cfg: Any) -> WatchSettings:
    return WatchSettings(
        poll_seconds=cfg.todo_watch_poll_seconds,
        idle_debounce_seconds=cfg.todo_watch_idle_debounce_seconds,
        max_minutes=cfg.todo_watch_max_minutes,
    )


def run_todo_watch(
    *,
    state: Any,
    reader: Any,
    target_session: str,
    fire_patrol: Callable[[], Any],
    settings: WatchSettings,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    if not state.try_claim_todo_watch(
        target_session=target_session,
        stale_after_seconds=settings.claim_stale_after_seconds,
    ):
        state.log_event(
            event_type="todo_watch_already_active",
            target_session=target_session,
            status="skipped",
            summary="another todo watch holds the claim",
            trigger_source="todo_pool",
            trigger_cause="todo_watch",
            trigger_location=target_session,
        )
        return {"status": "already_active", "fired": 0}

    started = clock()
    fired = 0
    result = "error"
    error = ""
    state.log_event(
        event_type="todo_watch_started",
        target_session=target_session,
        status="started",
        summary=(
            f"poll={settings.poll_seconds}s; idle_debounce={settings.idle_debounce_seconds}s; "
            f"max_minutes={settings.max_minutes}"
        ),
        trigger_source="todo_pool",
        trigger_cause="todo_watch",
        trigger_location=target_session,
    )
    try:
        while True:
            if clock() - started >= settings.max_seconds:
                result = "expired"
                break
            if state.active_pause_for_session(target_session) is not None:
                result = "paused"
                break
            session = reader.get_session_by_name(target_session)
            if session is None or session.get("heartbeat_enabled") != 1:
                result = "target_ineligible"
                break
            if not state.pending_todos_for_session(target_session, limit=1):
                result = "drained"
                break
            if not _target_idle(reader, session):
                # busy 时按 poll_seconds 节奏唤醒，捕获 busy→idle 切换；不再被 settle ETA 拖成长睡。
                sleep(settings.poll_seconds)
                continue
            # target 已观测为 idle，debounce 确认稳定后开火；settle window 不再阻塞这条路径。
            sleep(settings.idle_debounce_seconds)
            session = reader.get_session_by_name(target_session)
            if session is None or not _target_idle(reader, session):
                continue
            # expected_count 类批次（显式同步意图）在 patrol claim 时仍会被 expected_count + max_wait
                # gate 兜底；普通 spawn_closure / single 待办在这里直接放行。
            if not state.has_claimable_todo(target_session, target_idle=True):
                sleep(settings.poll_seconds)
                continue
            state.log_event(
                event_type="todo_watch_fired",
                target_session=target_session,
                status="started",
                summary=f"idle stable for {settings.idle_debounce_seconds}s; firing targeted patrol",
                trigger_source="todo_pool",
                trigger_cause="todo_watch",
                trigger_location=target_session,
            )
            fire_patrol()
            fired += 1
            sleep(settings.poll_seconds)
    except Exception as exc:  # 看护进程不抛出，落事件供排查
        result = "error"
        error = str(exc)
    finally:
        state.release_todo_watch(target_session)
        state.log_event(
            event_type="todo_watch_finished",
            target_session=target_session,
            status=result,
            summary=f"fired={fired}; elapsed_seconds={int(clock() - started)}",
            error=error,
            trigger_source="todo_pool",
            trigger_cause="todo_watch",
            trigger_location=target_session,
        )
    outcome: dict[str, Any] = {"status": result, "fired": fired}
    if error:
        outcome["error"] = error
    return outcome


def ensure_todo_watch(
    *,
    state: Any,
    target_session: str,
    cause: str,
    settings: WatchSettings,
    workspace: Path = WORKSPACE,
) -> dict[str, Any]:
    """Launch a detached watcher unless a fresh claim says one is already running."""
    if state.todo_watch_claim_active(target_session, stale_after_seconds=settings.claim_stale_after_seconds):
        return {"status": "already_active"}
    log_dir = Path(
        os.environ.get("HEARTBEAT_ENQUEUE_TRIGGER_LOG_DIR", str(workspace / "data" / "enqueue-triggers"))
    )
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{target_session}.log"
    command = [sys.executable, str(workspace / "scripts" / "heartbeat-todo-watch"), "--session", target_session]
    try:
        with log_path.open("ab") as output:
            process = subprocess.Popen(
                command,
                cwd=str(workspace),
                env=os.environ.copy(),
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
    except Exception as exc:
        state.log_event(
            event_type="todo_watch_launch_failed",
            target_session=target_session,
            status="failed",
            summary=f"cause={cause}",
            error=str(exc),
            trigger_source="todo_pool",
            trigger_cause=cause,
            trigger_location=target_session,
        )
        return {"status": "failed", "error": str(exc)}
    state.log_event(
        event_type="todo_watch_launched",
        target_session=target_session,
        status="started",
        summary=f"pid={process.pid}; cause={cause}; log_path={log_path}",
        trigger_source="todo_pool",
        trigger_cause=cause,
        trigger_location=target_session,
    )
    return {"status": "started", "pid": process.pid, "log_path": str(log_path)}


def _target_idle(reader: Any, session: dict[str, Any]) -> bool:
    if str(session.get("status", "")).lower() != "idle":
        return False
    latest = reader.latest_run_status(session.get("id"))
    return str(latest or "").lower() != "running"
