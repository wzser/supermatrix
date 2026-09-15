from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from datetime import datetime
from threading import local
from typing import Any
from urllib.parse import quote

from .todo_dedupe import text_contains_problem_type

class ApiError(RuntimeError):
    pass


SYNC_PREDICATE_WINDOW_SEC = 600
CHILD_PREDICATE_WINDOW_SEC = 10800
FRAMEWORK_USER_MESSAGE_PREFIX = "Δ"


def strip_minimax_thinking(content: str) -> str:
    stripped = content.strip()
    if not stripped.startswith("<think>"):
        return stripped
    end = stripped.find("</think>")
    if end == -1:
        return stripped
    return stripped[end + len("</think>") :].strip()


class HeartbeatApi:
    def __init__(
        self,
        *,
        api_base: str,
        lark_cli: str,
        heartbeat_session: str,
        todomaster_session: str = "",
        controller_provider: str = "spawn",
        minimax_api_key: str = "",
        minimax_base_url: str = "https://api.minimaxi.com/v1",
        minimax_model: str = "MiniMax-M2.7",
        minimax_timeout: int = 60,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.lark_cli = lark_cli
        self.heartbeat_session = heartbeat_session
        self.todomaster_session = todomaster_session.strip()
        self.controller_provider = controller_provider
        self.minimax_api_key = minimax_api_key
        self.minimax_base_url = minimax_base_url.rstrip("/")
        self.minimax_model = minimax_model
        self.minimax_timeout = minimax_timeout
        self._call_context = local()

    @property
    def last_controller_response(self) -> dict[str, Any] | None:
        value = getattr(self._call_context, "last_controller_response", None)
        return value if isinstance(value, dict) else None

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.api_base}{path}",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                status = response.status
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise ApiError(f"POST {path} failed with HTTP {exc.code}: {raw}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"POST {path} failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise ApiError(f"POST {path} timed out after 180s") from exc

        if status < 200 or status >= 300:
            raise ApiError(f"POST {path} failed with HTTP {status}: {raw}")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ApiError(f"POST {path} returned invalid JSON: {raw}") from exc
        if not isinstance(data, dict):
            raise ApiError(f"POST {path} returned non-object JSON")
        if data.get("ok") is not True and data.get("status") != "switched_async":
            message = data.get("error") or data.get("errorMessage") or data
            raise ApiError(f"POST {path} returned ok=false: {message}")
        return data

    def run_controller_decision(self, prompt: str, model: str) -> str:
        self._call_context.last_controller_response = None
        if self.controller_provider == "minimax" and model == self.minimax_model:
            return self._post_minimax_chat(prompt, model)
        verification_token = build_verification_token("hb-controller", self.heartbeat_session, model, prompt)
        data = self._post_json(
            "/api/spawn2.0",
            build_spawn2_payload(
                from_session=self.heartbeat_session,
                target=self.heartbeat_session,
                prompt=append_json_verification_instruction(prompt, verification_token),
                request_kind="controller",
                request_parts=(self.heartbeat_session, model, prompt),
                model=model,
                closure_target="inline",
                verification_predicate=build_inbox_message_predicate(
                    session_name=self.heartbeat_session,
                    field="final_message",
                    token=verification_token,
                    expected_window_sec=SYNC_PREDICATE_WINDOW_SEC,
                ),
            ),
        )
        self._call_context.last_controller_response = data
        final_message = data.get("finalMessage")
        if not isinstance(final_message, str) or not final_message.strip():
            raise ApiError("controller spawn returned empty finalMessage")
        require_verification_token(final_message, verification_token, "controller spawn")
        return final_message

    def _post_minimax_chat(self, prompt: str, model: str) -> str:
        if not self.minimax_api_key:
            raise ApiError("MiniMax API key is not configured")
        body = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
                "max_tokens": 4096,
                "reasoning_split": True,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self.minimax_base_url}/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {self.minimax_api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.minimax_timeout) as response:
                status = response.status
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise ApiError(f"MiniMax chat failed with HTTP {exc.code}: {raw}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"MiniMax chat failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise ApiError(f"MiniMax chat timed out after {self.minimax_timeout}s") from exc

        if status < 200 or status >= 300:
            raise ApiError(f"MiniMax chat failed with HTTP {status}: {raw}")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ApiError(f"MiniMax chat returned invalid JSON: {raw}") from exc
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ApiError(f"MiniMax chat response missing choices[0].message.content: {raw}") from exc
        if not isinstance(content, str) or not content.strip():
            raise ApiError("MiniMax chat returned empty content")
        return strip_minimax_thinking(content)

    def spawn_child(self, target: str, prompt: str, model: str) -> dict[str, Any]:
        verification_token = build_verification_token("hb-child", target, model, prompt)
        return self._post_json(
            "/api/spawn2.0",
            build_spawn2_payload(
                from_session=self.heartbeat_session,
                target=target,
                prompt=append_final_message_verification_instruction(prompt, verification_token),
                request_kind="child",
                request_parts=(target, model, prompt),
                model=model,
                closure_target="inline",
                verification_predicate=build_inbox_message_predicate(
                    session_name=target,
                    field="final_message",
                    token=verification_token,
                    expected_window_sec=CHILD_PREDICATE_WINDOW_SEC,
                ),
            ),
        )

    def find_registered_todo_problem_types(self, *, problem_types: set[str]) -> set[str]:
        """Read the complete Todo board before a new patrol Todo is registered.

        No lifecycle/status filter is applied: any matching row, including completed
        and other terminal rows, suppresses a new row.  The board remains owned by
        todomaster; heartbeat only performs this read-only lark-cli lookup.
        """
        candidates = {str(value).strip() for value in problem_types if str(value).strip()}
        if not candidates:
            return set()
        base_token = os.environ.get("HEARTBEAT_TODO_DEDUPE_BASE_TOKEN", "").strip()
        table_id = os.environ.get("HEARTBEAT_TODO_DEDUPE_TABLE_ID", "").strip()
        content_field_id = os.environ.get("HEARTBEAT_TODO_DEDUPE_CONTENT_FIELD_ID", "").strip()
        source_field_id = os.environ.get("HEARTBEAT_TODO_DEDUPE_SOURCE_FIELD_ID", "").strip()
        if not base_token or not table_id or not content_field_id or not source_field_id:
            raise ApiError("heartbeat Todo full-table dedupe configuration is incomplete")

        offset = 0
        matched: set[str] = set()
        page_size = 200
        timeout = float(os.environ.get("HEARTBEAT_TODO_DEDUPE_TIMEOUT_SEC", "60"))
        while True:
            command = [
                self.lark_cli,
                "base",
                "+record-list",
                "--as",
                os.environ.get("HEARTBEAT_TODO_DEDUPE_AS", "bot"),
                "--base-token",
                base_token,
                "--table-id",
                table_id,
                "--field-id",
                content_field_id,
                "--field-id",
                source_field_id,
                "--offset",
                str(offset),
                "--limit",
                str(page_size),
                "--format",
                "json",
            ]
            try:
                proc = subprocess.run(
                    command,
                    text=True,
                    capture_output=True,
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired as exc:
                raise ApiError(f"Todo full-table dedupe lookup timed out after {exc.timeout}s") from exc
            except OSError as exc:
                raise ApiError(f"Todo full-table dedupe lookup failed: {exc}") from exc
            if proc.returncode != 0:
                raise ApiError(
                    f"Todo full-table dedupe lookup failed: {proc.stderr.strip() or proc.stdout.strip()}"
                )
            try:
                payload = json.loads(proc.stdout)
            except json.JSONDecodeError as exc:
                raise ApiError("Todo full-table dedupe lookup returned invalid JSON") from exc
            if not isinstance(payload, dict) or payload.get("ok") is not True:
                raise ApiError("Todo full-table dedupe lookup returned ok=false")
            data = payload.get("data")
            if not isinstance(data, dict):
                raise ApiError("Todo full-table dedupe lookup missing data")
            fields = data.get("fields")
            rows = data.get("data")
            if not isinstance(fields, list) or not all(isinstance(field, str) for field in fields):
                raise ApiError("Todo full-table dedupe lookup returned invalid fields")
            if not isinstance(rows, list):
                raise ApiError("Todo full-table dedupe lookup returned invalid rows")
            field_id_list = data.get("field_id_list")
            if not isinstance(field_id_list, list) or not all(
                isinstance(field_id, str) for field_id in field_id_list
            ):
                raise ApiError("Todo full-table dedupe lookup returned invalid field ids")
            field_indexes = {field_id: index for index, field_id in enumerate(field_id_list)}
            content_index = field_indexes.get(content_field_id)
            source_index = field_indexes.get(source_field_id)
            if content_index is None or source_index is None:
                raise ApiError("Todo full-table dedupe lookup omitted required fields")
            for row in rows:
                if not isinstance(row, list):
                    raise ApiError("Todo full-table dedupe lookup returned malformed row")
                content = row[content_index] if content_index < len(row) else ""
                source = row[source_index] if source_index < len(row) else ""
                haystack = "\n".join(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False) for value in (content, source))
                matched.update(candidate for candidate in candidates if text_contains_problem_type(haystack, candidate))
            has_more = data.get("has_more") is True
            if not has_more or not rows:
                return matched
            offset += len(rows)

    def register_agent_todo(self, *, issue_key: str, body: str) -> dict[str, Any]:
        """Register an unresolved patrol issue with todomaster.

        The todo_pool closure is intentional: todomaster owns the shared board write and
        the framework continues delivery if the synchronous spawn window expires.
        """
        issue_key = issue_key.strip()
        body = body.strip()
        if not issue_key or not body:
            raise ValueError("issue_key and body must be non-empty")
        if not self.todomaster_session:
            raise ApiError("todomaster escalation is not configured")
        safe_issue_key = re.sub(r"[^A-Za-z0-9_.:-]+", "-", issue_key)[:120]
        payload = {
            "target": self.todomaster_session,
            "from": self.heartbeat_session,
            "prompt": body,
            "client_request_id": f"{datetime.now().date().isoformat()}:heartbeat:patrol-todo:{safe_issue_key}",
            "closure": {"kind": "message", "target": {"type": "todo_pool"}},
        }
        return self._post_json("/api/spawn2.0", payload)

    def send_alert(self, chat_id: str, text: str) -> None:
        try:
            completed = subprocess.run(
                [
                    self.lark_cli,
                    "im",
                    "+messages-send",
                    "--as",
                    "bot",
                    "--chat-id",
                    chat_id,
                    "--text",
                    text,
                ],
                check=False,
                text=True,
                capture_output=True,
                timeout=180,
            )
        except subprocess.TimeoutExpired as exc:
            raise ApiError("lark-cli alert send timed out after 180s") from exc
        except OSError as exc:
            raise ApiError(f"lark-cli alert send failed: {exc}") from exc
        if completed.returncode != 0:
            output = (completed.stderr or completed.stdout or "").strip()
            raise ApiError(f"lark-cli alert send failed with exit {completed.returncode}: {output}")

    def send_user_message(self, chat_id: str, text: str) -> None:
        outgoing_text = _mark_framework_user_message(text)
        try:
            completed = subprocess.run(
                [
                    self.lark_cli,
                    "im",
                    "+messages-send",
                    "--as",
                    "user",
                    "--chat-id",
                    chat_id,
                    "--text",
                    outgoing_text,
                ],
                check=False,
                text=True,
                capture_output=True,
                timeout=180,
            )
        except subprocess.TimeoutExpired as exc:
            raise ApiError("lark-cli user message send timed out after 180s") from exc
        except OSError as exc:
            raise ApiError(f"lark-cli user message send failed: {exc}") from exc
        if completed.returncode != 0:
            output = (completed.stderr or completed.stdout or "").strip()
            raise ApiError(f"lark-cli user message send failed with exit {completed.returncode}: {output}")

    def get_spawn_async_item_by_comm(self, comm_id: str) -> dict[str, Any] | None:
        """Read the platform consumption ledger for one spawn comm id.

        A missing async row is normal for non-pollable closures, so it returns
        ``None``. Transport and protocol failures raise ``ApiError`` for the
        patrol caller to fail open and preserve its existing todo delivery.
        """
        comm_id = comm_id.strip()
        if not comm_id:
            return None
        path = f"/api/spawn_async_items/by-comm/{quote(comm_id, safe='')}"
        request = urllib.request.Request(
            f"{self.api_base}{path}",
            headers={"Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status = response.status
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            if exc.code == 404:
                return None
            raise ApiError(f"GET {path} failed with HTTP {exc.code}: {raw}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"GET {path} failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise ApiError(f"GET {path} timed out after 5s") from exc

        if status == 404:
            return None
        if status < 200 or status >= 300:
            raise ApiError(f"GET {path} failed with HTTP {status}: {raw}")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ApiError(f"GET {path} returned invalid JSON: {raw}") from exc
        if not isinstance(data, dict):
            raise ApiError(f"GET {path} returned non-object JSON")
        if data.get("ok") is not True:
            message = data.get("error") or data.get("errorMessage") or data
            raise ApiError(f"GET {path} returned ok=false: {message}")
        return data

    def notify_console(self, *, title: str, body: str, level: str = "info") -> dict[str, str]:
        """Post a Console notification and return its durable transport receipt."""
        payload = {"source": self.heartbeat_session, "title": title, "body": body, "level": level}
        request = urllib.request.Request(
            f"{self.api_base}/api/notify",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status = response.status
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise ApiError(f"POST /api/notify failed with HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"POST /api/notify failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise ApiError("POST /api/notify timed out after 30s") from exc
        if status < 200 or status >= 300:
            raise ApiError(f"POST /api/notify failed with HTTP {status}: {raw}")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ApiError(f"POST /api/notify returned invalid JSON: {raw}") from exc
        if not isinstance(data, dict):
            raise ApiError("POST /api/notify returned non-object JSON")
        message_id = data.get("messageId")
        if not isinstance(message_id, str) or not message_id:
            raise ApiError(f"POST /api/notify succeeded without messageId: {raw}")
        detail = data.get("code") or data.get("error") or ""
        return {
            "status": "degraded" if data.get("degraded") is True else "delivered",
            "message_id": message_id,
            "detail": str(detail),
        }


def build_verification_token(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def _mark_framework_user_message(text: str) -> str:
    if text.startswith(FRAMEWORK_USER_MESSAGE_PREFIX):
        return text
    return f"{FRAMEWORK_USER_MESSAGE_PREFIX}{text}"


def build_spawn2_payload(
    *,
    from_session: str,
    target: str,
    prompt: str,
    request_kind: str,
    request_parts: tuple[str, ...],
    model: str,
    closure_target: str,
    verification_predicate: dict[str, Any],
) -> dict[str, Any]:
    return {
        "target": target,
        "from": from_session,
        "prompt": prompt,
        "client_request_id": build_client_request_id(
            caller="heartbeat",
            request_kind=request_kind,
            parts=request_parts,
        ),
        "execution": {"backend": "codex", "model": model},
        "closure": {"kind": "message", "target": {"type": closure_target}},
        "verification_predicate": verification_predicate,
    }


def build_client_request_id(*, caller: str, request_kind: str, parts: tuple[str, ...]) -> str:
    today = datetime.now().date().isoformat()
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:16]
    return f"{today}:{caller}:{request_kind}:{digest}"


def build_inbox_message_predicate(
    *,
    session_name: str,
    field: str,
    token: str,
    expected_window_sec: int,
) -> dict[str, Any]:
    return {
        "type": "inbox-message",
        "session_name": session_name,
        "field": field,
        "contains_all": [token],
        "expected_window_sec": expected_window_sec,
    }


def append_json_verification_instruction(prompt: str, token: str) -> str:
    return "\n".join(
        [
            prompt,
            "",
            f'Verification: include a top-level JSON field "verification_token" with exactly "{token}".',
        ]
    )


def append_final_message_verification_instruction(prompt: str, token: str) -> str:
    return "\n".join(
        [
            prompt,
            "",
            f"Verification token: {token}",
            "Include this verification token once in your final response.",
        ]
    )


def require_verification_token(content: str, token: str, context: str) -> None:
    if token not in content:
        raise ApiError(f"{context} finalMessage missing verification token {token}")
