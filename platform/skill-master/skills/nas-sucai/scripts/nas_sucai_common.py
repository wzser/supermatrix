#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import posixpath
import ssl
import subprocess
import uuid
from dataclasses import dataclass
from ftplib import FTP_TLS
from pathlib import Path
from typing import Any


DEFAULT_CODEX_HOME = Path.home() / ".codex"
DEFAULT_CONFIG_FILENAME = "nas-sucai.json"
LEGACY_CONFIG_FILENAME = "nas-ftps.json"
DEFAULT_KEYCHAIN_SERVICE = "codex-nas-sucai"
DEFAULT_REMOTE_ROOT = "/"
DEFAULT_VALIDATION_DIRECTORY = "/2026产品图片/codex-smoke"


@dataclass(frozen=True)
class NasSucaiConfig:
    lan_host: str
    lan_port: int
    username: str
    remote_root: str
    passive_mode: bool
    timeout_seconds: float
    certificate_sha256: str
    keychain_service: str
    validation_directory: str
    control_encoding: str
    password_file: str | None
    password_env_var: str


class NasSucaiError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def load_config(
    path: Path | None = None,
    codex_home: Path | None = None,
) -> NasSucaiConfig:
    home = codex_home or DEFAULT_CODEX_HOME
    target = path or (home / DEFAULT_CONFIG_FILENAME)
    if not target.exists():
        legacy = home / LEGACY_CONFIG_FILENAME
        if legacy.exists():
            target = legacy
    raw = json.loads(target.read_text(encoding="utf-8"))
    return NasSucaiConfig(
        lan_host=raw["lan_host"],
        lan_port=int(raw.get("lan_port", 21)),
        username=raw["username"],
        remote_root=raw.get("remote_root", DEFAULT_REMOTE_ROOT),
        passive_mode=bool(raw.get("passive_mode", True)),
        timeout_seconds=float(raw.get("timeout_seconds", 8.0)),
        certificate_sha256=raw["certificate_sha256"],
        keychain_service=raw.get("keychain_service", DEFAULT_KEYCHAIN_SERVICE),
        validation_directory=raw.get("validation_directory", DEFAULT_VALIDATION_DIRECTORY),
        control_encoding=raw.get("control_encoding", "gb18030"),
        password_file=raw.get("password_file") or None,
        password_env_var=raw.get("password_env_var", "NAS_SUCAI_PASSWORD"),
    )


def normalize_fingerprint(value: str) -> str:
    return "".join(char for char in value.lower() if char.isalnum())


def get_password(username: str, service_name: str) -> str:
    result = subprocess.run(
        [
            "security",
            "find-generic-password",
            "-a",
            username,
            "-s",
            service_name,
            "-w",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def resolve_password(config: NasSucaiConfig) -> str:
    password_from_env = os.environ.get(config.password_env_var, "").strip()
    if password_from_env:
        return password_from_env

    if config.password_file:
        secret_path = Path(config.password_file).expanduser()
        if secret_path.exists():
            secret = secret_path.read_text(encoding="utf-8").strip()
            if secret:
                return secret

    try:
        return get_password(config.username, config.keychain_service)
    except subprocess.CalledProcessError as exc:
        raise NasSucaiError(
            "password_unavailable",
            (
                "NAS password is not available from the configured sources, including Keychain. "
                "If this is running inside a sandbox, either rerun with escalated permissions "
                "or configure `password_file` / `password_env_var` in ~/.codex/nas-sucai.json."
            ),
        ) from exc


def _build_ssl_context() -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def verify_tls_fingerprint(sock: ssl.SSLSocket, expected_fingerprint: str) -> str:
    actual = hashlib.sha256(sock.getpeercert(binary_form=True)).hexdigest()
    if normalize_fingerprint(actual) != normalize_fingerprint(expected_fingerprint):
        raise NasSucaiError(
            "certificate_fingerprint_mismatch",
            "server certificate fingerprint did not match the pinned value",
        )
    return actual


def connect_ftps(
    endpoint: dict[str, Any],
    config: NasSucaiConfig,
    password: str,
) -> tuple[FTP_TLS, dict[str, Any]]:
    ftp = FTP_TLS(
        context=_build_ssl_context(),
        timeout=config.timeout_seconds,
        encoding=config.control_encoding,
    )
    try:
        ftp.connect(str(endpoint["host"]), int(endpoint["port"]))
        ftp.auth()
        if not hasattr(ftp.sock, "getpeercert"):
            raise NasSucaiError("tls_handshake_failed", "control channel was not upgraded to TLS")
        fingerprint = verify_tls_fingerprint(ftp.sock, config.certificate_sha256)
        ftp.login(config.username, password)
        ftp.prot_p()
        ftp.set_pasv(config.passive_mode)
        ftp.cwd(config.remote_root)
        return ftp, {
            "label": endpoint["label"],
            "host": endpoint["host"],
            "port": endpoint["port"],
            "fingerprint": fingerprint,
        }
    except NasSucaiError:
        close_ftps_client(ftp)
        raise
    except PermissionError as exc:
        close_ftps_client(ftp)
        raise NasSucaiError(
            "permission_required",
            "Local FTPS access is blocked in the current sandbox. Rerun this command with escalated permissions.",
        ) from exc
    except Exception as exc:
        close_ftps_client(ftp)
        raise NasSucaiError(
            "endpoint_unreachable",
            f"{endpoint['label']} endpoint failed: {exc}",
        ) from exc


def connect_nas(config: NasSucaiConfig, password: str) -> tuple[FTP_TLS, dict[str, Any]]:
    endpoint = {"label": "lan", "host": config.lan_host, "port": config.lan_port}
    return connect_ftps(endpoint, config, password)


def close_ftps_client(ftp: FTP_TLS) -> None:
    try:
        ftp.quit()
    except Exception:
        try:
            ftp.close()
        except Exception:
            pass


def join_remote_path(parent: str, name: str) -> str:
    if parent == "/":
        return f"/{name}"
    return posixpath.join(parent, name)


def list_directory(ftp: FTP_TLS, path: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for name, facts in ftp.mlsd(path):
        entries.append(
            {
                "name": name,
                "path": join_remote_path(path, name),
                "type": facts.get("type", "unknown"),
                "size": int(facts["size"]) if "size" in facts else None,
            }
        )
    return entries


def search_directory(ftp: FTP_TLS, path: str, query: str) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    pending = [path]
    needle = query.lower()
    while pending:
        current = pending.pop()
        try:
            entries = list_directory(ftp, current)
        except Exception:
            if current == path:
                raise
            continue
        for entry in entries:
            if needle in str(entry["name"]).lower():
                matches.append(entry)
            if entry["type"] == "dir":
                pending.append(str(entry["path"]))
    matches.sort(key=lambda item: str(item["path"]))
    return matches


def download_file(
    ftp: FTP_TLS,
    remote_path: str,
    local_path: Path,
    overwrite: bool = False,
) -> Path:
    if local_path.exists() and not overwrite:
        raise RuntimeError("local destination already exists")
    local_path.parent.mkdir(parents=True, exist_ok=True)
    with local_path.open("wb") as handle:
        ftp.retrbinary(f"RETR {remote_path}", handle.write)
    return local_path


def upload_file_atomic(ftp: FTP_TLS, local_path: Path, remote_path: str) -> str:
    temp_remote_path = f"{remote_path}.codex-upload-{uuid.uuid4().hex}.tmp"
    with local_path.open("rb") as handle:
        ftp.storbinary(f"STOR {temp_remote_path}", handle)
    ftp.rename(temp_remote_path, remote_path)
    return remote_path


def make_directory(ftp: FTP_TLS, remote_path: str) -> str:
    return ftp.mkd(remote_path)


def rename_remote_path(
    ftp: FTP_TLS,
    source_path: str,
    destination_path: str,
) -> tuple[str, str]:
    ftp.rename(source_path, destination_path)
    return source_path, destination_path


def success_payload(
    action: str,
    endpoint: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": "ok",
        "action": action,
        "endpoint": endpoint,
        "result": result,
    }


def error_payload(exc: Exception, action: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any]
    if isinstance(exc, NasSucaiError):
        payload = {"status": "error", "code": exc.code, "message": exc.message}
    else:
        payload = {"status": "error", "code": "unexpected_error", "message": str(exc)}
    if action is not None:
        payload["action"] = action
    return payload
