from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


class LarkCliError(RuntimeError):
    def __init__(self, message: str, *, code: Any = None):
        super().__init__(message)
        self.code = code


def parse_lark_json(stdout: str) -> dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise LarkCliError(f"invalid json from lark-cli: {exc}") from exc
    if not isinstance(payload, dict):
        raise LarkCliError(f"invalid json object from lark-cli: {type(payload).__name__}")
    if payload.get("ok") is False:
        error = payload.get("error") or {}
        if not isinstance(error, dict):
            error = {}
        raise LarkCliError(
            str(error.get("message") or payload), code=error.get("code")
        )
    return payload


# 单次 lark-cli 调用墙钟上限：正常调用（record-list 单页 / 单行 upsert / record-get）秒级完成。
# 30s 的唯一目的是防「lark-cli 子进程卡死（网络/飞书不响应）→ subprocess.run 无
# timeout 永久阻塞 → drain 永久持锁」——2026-07-04 实测 scheduler.mirror enqueue 挂 2h+ 持 flock
# 需人工 kill 的根因。超时抛 LarkCliError（非永久错误），PacedLarkCli 退避重试可吸收瞬时卡顿；
# 持续卡死则重试耗尽后失败、锁在数分钟内必释放（不再无限）。
DEFAULT_TIMEOUT_SECONDS = 30.0


def _resolve_lark_cli_binary(binary: str) -> str:
    if binary != "lark-cli":
        return binary
    override = os.environ.get("LARK_CLI_BIN")
    if override:
        return override
    for candidate in (
        Path.home() / ".local" / "bin" / "lark-cli",
        Path.home() / "SuperMatrix" / "node_modules" / ".bin" / "lark-cli",
        Path("/opt/homebrew/bin/lark-cli"),
        Path("/usr/local/bin/lark-cli"),
    ):
        if candidate.exists():
            return str(candidate)
    found = shutil.which(binary)
    if found:
        return found
    legacy = Path.home() / ".npm-global" / "bin" / "lark-cli"
    if legacy.exists():
        return str(legacy)
    return binary


@dataclass
class LarkCli:
    binary: str = "lark-cli"
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    def run_json(
        self, args: list[str], *, cwd: str | None = None, timeout: float | None = None
    ) -> dict[str, Any]:
        effective_timeout = timeout if timeout is not None else self.timeout_seconds
        binary = _resolve_lark_cli_binary(self.binary)
        try:
            result = self.runner(
                [binary, *args, "--format", "json"],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                cwd=cwd,
                timeout=effective_timeout,
            )
        except FileNotFoundError as exc:
            raise LarkCliError(
                "lark-cli executable not found; set LARK_CLI_BIN or include lark-cli in PATH"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            # subprocess.run 超时会先 kill 子进程再抛，故此处子进程已终止、锁得以释放。
            raise LarkCliError(
                f"lark-cli timed out after {effective_timeout}s: {' '.join(args[:3])}"
            ) from exc
        if result.returncode != 0:
            raise LarkCliError(result.stderr.strip() or result.stdout.strip())
        return parse_lark_json(result.stdout)
