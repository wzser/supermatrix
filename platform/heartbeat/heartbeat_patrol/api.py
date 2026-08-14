from __future__ import annotations

import hashlib
import json
import subprocess
import urllib.error
import urllib.request
from datetime import datetime
from threading import local
from typing import Any
from urllib.parse import quote

from .prefilter import PROVIDER_LIMIT_RE


class ApiError(RuntimeError):
    pass


def _response_string(response: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = response.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


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
        controller_provider: str = "spawn",
        minimax_api_key: str = "",
        minimax_base_url: str = "https://api.minimaxi.com/v1",
        minimax_model: str = "MiniMax-M2.7",
        minimax_timeout: int = 60,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.lark_cli = lark_cli
        self.heartbeat_session = heartbeat_session
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

    @property
    def last_resume_response(self) -> dict[str, Any] | None:
        value = getattr(self._call_context, "last_resume_response", None)
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

    def compose_user_resume_message(self, *, item: Any, target_session: dict[str, Any], model: str) -> str:
        self._call_context.last_resume_response = None
        verification_token = build_verification_token(
            "hb-resume",
            self.heartbeat_session,
            model,
            getattr(item, "logical_key", ""),
            getattr(item, "prompt", ""),
        )
        data = self._post_json(
            "/api/spawn2.0",
            build_spawn2_payload(
                from_session=self.heartbeat_session,
                target=self.heartbeat_session,
                prompt=build_user_resume_compose_prompt(
                    item=item,
                    target_session=target_session,
                    verification_token=verification_token,
                ),
                request_kind="resume",
                request_parts=(
                    self.heartbeat_session,
                    model,
                    getattr(item, "logical_key", ""),
                    getattr(item, "prompt", ""),
                ),
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
        self._call_context.last_resume_response = data
        if data.get("status") == "switched_async":
            detail = self._resume_composer_async_error(data)
            if PROVIDER_LIMIT_RE.search(detail):
                raise ApiError(f"user resume composer provider limit: {detail}")
            raise ApiError(f"user resume composer switched_async without finalMessage: {detail}")
        final_message = data.get("finalMessage")
        if not isinstance(final_message, str) or not final_message.strip():
            raise ApiError("user resume composer returned empty finalMessage")
        return parse_verified_user_resume_message(final_message, verification_token)

    def _resume_composer_async_error(self, response: dict[str, Any]) -> str:
        comm_id = _response_string(response, "spawnCommId", "commId", "comm_id")
        if comm_id:
            try:
                item = self.get_spawn_async_item_by_comm(comm_id)
            except ApiError:
                item = None
            if isinstance(item, dict):
                detail = _response_string(item, "errorMessage", "error_message", "verdictReason", "message")
                if detail:
                    return detail
        return _response_string(response, "error", "errorMessage", "message") or "async composer result is unavailable"

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


def parse_verified_user_resume_message(content: str, token: str) -> str:
    require_verification_token(content, token, "user resume composer")
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ApiError("user resume composer returned invalid verification JSON") from exc
    if not isinstance(payload, dict):
        raise ApiError("user resume composer returned non-object verification JSON")
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        raise ApiError("user resume composer returned empty message")
    if payload.get("verification_token") != token:
        raise ApiError("user resume composer returned mismatched verification token")
    if token in message:
        raise ApiError("user resume composer included verification token in user message")
    return message.strip()


def build_user_resume_compose_prompt(
    *,
    item: Any,
    target_session: dict[str, Any],
    verification_token: str | None = None,
) -> str:
    if verification_token is None:
        output_contract = [
            "Return only the exact user message body. Do not include markdown or commentary.",
        ]
    else:
        output_contract = [
            "Return JSON only. Do not include markdown or commentary.",
            'Schema: {"message":"<exact user message body>","verification_token":"<token>"}',
            f'verification_token must equal "{verification_token}".',
        ]
    return "\n".join(
        output_contract
        + [
            "You are composing a natural user reply for an existing SuperMatrix session chat.",
            "The message value will be sent as the human user to the target session.",
            "The message should nudge the target session to continue its own unfinished work.",
            "Use the target session's language and context. Be concise, conversational, and specific.",
            "Do not speak as the target session.",
            "Do not claim that work has been completed, delivered, revised, sent, or posted.",
            "Do not assert or explain why a failure, timeout, or error happened (for example 'this was caused by a backend restart' or 'this is not a business logic failure'); if the cause is unknown to the user, just ask to continue without naming a cause.",
            "Do not state business conclusions or technical judgments on the user's behalf.",
            "Do not ask a new question. Do not introduce new requirements, parameters, approvals, or business choices.",
            "Do not mention heartbeat, automation, child sessions, spawn, scheduler, or internal systems.",
            f"Target session: {target_session.get('name')}",
            f"Logical key: {getattr(item, 'logical_key', '')}",
            f"Reason: {getattr(item, 'reason', '')}",
            f"Guidance: {getattr(item, 'prompt', '')}",
        ]
    )
