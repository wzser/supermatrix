#!/usr/bin/env python3
"""Build and scan the public Super Matrix release tree.

The tool is intentionally standard-library only. It copies a closed allowlist
from live repositories into a new empty directory, redacts configured private
keywords, and fails closed on secret, PII, binary, path, and size findings.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


PLACEHOLDER_MARKERS = (
    "YOUR_",
    "YOUR-",
    "REDACTED",
    "EXAMPLE",
    "PLACEHOLDER",
    "DUMMY",
    "FAKE",
    "TEST_",
    "LOCAL_",
    "<HOME>",
    "<SM_",
)

REQUIRED_KEYWORD_CATEGORIES = {
    "person",
    "person_handle",
    "company",
    "brand",
    "product",
    "contact",
    "private_host",
}

DENIED_COMPONENTS = {
    ".git",
    ".gstack",
    ".superpowers",
    ".worktrees",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "data",
    "logs",
    "log",
    "runs",
    "run",
    "outputs",
    "output",
    "reports",
    "report",
    "captures",
    "screenshots",
    "media",
    "archive",
    "archives",
    "incoming",
    "intake",
    "raw",
    "tmp",
    "temp",
    ".tmp",
    "evidence",
    "receipts",
    "backups",
    ".attachments",
}

DENIED_SUFFIXES = {
    ".db",
    ".sqlite",
    ".sqlite3",
    ".db-wal",
    ".db-shm",
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".rar",
    ".7z",
    ".dmg",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".svgz",
    ".xlsx",
    ".xls",
    ".xlsm",
    ".pptx",
    ".ppt",
    ".docx",
    ".doc",
    ".wav",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".so",
    ".dylib",
    ".dll",
    ".exe",
    ".jar",
    ".pyc",
    ".class",
    ".jsonl",
    ".csv",
}

DANGEROUS_FILENAMES = (
    re.compile(r"^\.env(?:\..*)?$", re.IGNORECASE),
    re.compile(r"^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa).*$", re.IGNORECASE),
    re.compile(r"^.*\.(?:pem|key|p12|pfx|ppk|keystore|jks|kdbx)$", re.IGNORECASE),
    re.compile(r"^(?:\.npmrc|\.netrc|\.pgpass)$", re.IGNORECASE),
    re.compile(r"^service-account.*\.json$", re.IGNORECASE),
    re.compile(
        r"^(?:credential|credentials|secret|secrets|cookie|cookies)(?:[._-][^.]+)?(?:\.(?:json|ya?ml|toml|txt|ini|conf|config|env|local|prod))?$",
        re.IGNORECASE,
    ),
)

SECRET_PATTERNS = (
    (
        "private_key",
        re.compile(
            r"-----BEGIN(?: RSA| EC| OPENSSH| PGP)? PRIVATE KEY-----[\s\S]{20,}?"
            r"-----END(?: RSA| EC| OPENSSH| PGP)? PRIVATE KEY-----"
        ),
    ),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b")),
    ("slack_token", re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}\b")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9-]{20,}\b")),
    ("openai_key", re.compile(r"\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b")),
    ("huggingface_token", re.compile(r"\bhf_[A-Za-z0-9]{20,}\b")),
    ("google_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("bearer_jwt", re.compile(r"(?i)authorization:\s*bearer\s+ey[A-Za-z0-9_-]{20,}")),
    (
        "credential_assignment",
        re.compile(
            r"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['\"]([^'\"]{16,})['\"]"
        ),
    ),
)

SYNTHETIC_SECRET_BODIES = (
    "A1b2C3d4E5f6G7h8I9j0" + "K1l2M3n4O5p6Q7r8S9t0",
    "abCDef1234567890" + "abcdef1234567890",
)

SYNTHETIC_SECRET_REPLACEMENTS = (
    ("abcd1234" + "efgh5678ijkl", "EXAMPLEA1234EFGH5678"),
    ("AKIA" + "ABCDEFGHIJKLMNOP", "AKIAIOSFODNN7EXAMPLE"),
    (
        "github_pat_11ABCDEFG0" + "abcdefghijklmnopqrstuvwxyz1234567890ABCDE",
        "github_pat_EXAMPLE_abcdefghijklmnopqrstuvwxyz1234567890ABCDE",
    ),
    (
        "ghp_" + "012345678901234567890123456789012345",
        "ghp_EXAMPLE01234567890123456789012345678",
    ),
)

GENERIC_PATTERNS = (
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("mainland_phone", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("asin", re.compile(r"\bB0[A-Z0-9]{8}\b")),
    ("lark_chat_id", re.compile(r"\boc_[A-Za-z0-9]{16,}\b")),
    ("lark_open_id", re.compile(r"\bou_[A-Za-z0-9]{16,}\b")),
    ("lark_app_id", re.compile(r"\bcli_[A-Za-z0-9]{12,}\b")),
    ("lark_message_id", re.compile(r"\bom_[A-Za-z0-9]{16,}\b")),
    ("bitable_base_token", re.compile(r"\bbascn[A-Za-z0-9]{10,}\b")),
    ("bitable_table_id", re.compile(r"\btbl[A-Za-z0-9]{10,}\b")),
    ("wiki_node_token", re.compile(r"\bwikcn[A-Za-z0-9]{10,}\b")),
    ("private_user_path", re.compile(r"/Users/(?!(?:x|foo|whatever|your-user|LOCAL_USER)\b)[A-Za-z0-9._-]+")),
    ("windows_user_path", re.compile(r"(?i)\b[A-Z]:\\Users\\(?!(?:x|foo|LOCAL_USER)\b)[A-Za-z0-9._-]+")),
    ("wechat_handle", re.compile(r"(?i)(?:微信|wechat)\s*[:：=]\s*[`'\"]?[A-Za-z0-9_-]{4,}")),
    ("merge_conflict", re.compile(r"^(?:<<<<<<<|=======|>>>>>>>)")),
)

AUTO_REDACTIONS = (
    ("lark_chat_id", re.compile(r"\boc_[A-Za-z0-9]{16,}\b"), "oc_REDACTEDCHATID"),
    ("lark_open_id", re.compile(r"\bou_[A-Za-z0-9]{16,}\b"), "ou_REDACTEDOPENID"),
    ("lark_app_id", re.compile(r"\bcli_[A-Za-z0-9]{12,}\b"), "cli_REDACTEDAPPID"),
    ("lark_message_id", re.compile(r"\bom_[A-Za-z0-9]{16,}\b"), "om_REDACTEDMESSAGEID"),
    ("bitable_base_token", re.compile(r"\bbascn[A-Za-z0-9]{10,}\b"), "bascnREDACTEDBASETOKEN"),
    ("bitable_table_id", re.compile(r"\btbl[A-Za-z0-9]{10,}\b"), "tblREDACTEDTABLEID"),
    ("wiki_node_token", re.compile(r"\bwikcn[A-Za-z0-9]{10,}\b"), "wikcnREDACTEDNODETOKEN"),
    ("mainland_phone", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "PHONE_REDACTED"),
    ("asin", re.compile(r"\bB0[A-Z0-9]{8}\b"), "ASIN_REDACTED"),
    ("wechat_handle", re.compile(r"(?i)(?:微信|wechat)\s*[:：=]\s*[`'\"]?[A-Za-z0-9_-]{4,}"), "WECHAT_REDACTED"),
    (
        "private_user_path",
        re.compile(r"/Users/(?!(?:x|foo|whatever|your-user|LOCAL_USER)\b)[A-Za-z0-9._-]+"),
        "/Users/LOCAL_USER",
    ),
    (
        "windows_user_path",
        re.compile(r"(?i)\b[A-Z]:\\Users\\(?!(?:x|foo|LOCAL_USER)\b)[A-Za-z0-9._-]+"),
        r"C:\\Users\\LOCAL_USER",
    ),
)

ALLOWED_EMAIL_DOMAINS = {
    "example.com",
    "example.org",
    "example.test",
    "users.noreply.github.com",
    "anthropic.com",
    "openai.com",
    "supermatrix.local",
}

TEST_CREDENTIAL_WORDS = {
    "access",
    "account",
    "audit",
    "carriage",
    "current",
    "direct",
    "enter",
    "expired",
    "fallback",
    "feed",
    "line",
    "live",
    "must",
    "never",
    "not",
    "receipt",
    "refresh",
    "rejected",
    "return",
    "render",
    "sent",
    "should",
    "sk",
    "stale",
    "test",
    "the",
    "token",
    "used",
}


class ReleaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class Keyword:
    category: str
    language: str
    term: str
    replacement: str

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(self.term.encode("utf-8")).hexdigest()[:16]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ReleaseError(f"JSON root must be an object: {path}")
    return value


def load_keywords(path: Path) -> list[Keyword]:
    payload = load_json(path)
    if payload.get("version") != 1 or not isinstance(payload.get("keywords"), list):
        raise ReleaseError("keyword file must use version=1 and a keywords array")
    keywords: list[Keyword] = []
    seen: set[str] = set()
    for index, row in enumerate(payload["keywords"]):
        if not isinstance(row, dict):
            raise ReleaseError(f"keyword row {index} must be an object")
        category = str(row.get("category", "")).strip()
        language = str(row.get("language", "")).strip().lower()
        term = str(row.get("term", "")).strip()
        replacement = str(row.get("replacement", "")).strip()
        if not category or language not in {"zh", "en", "other"} or not replacement:
            raise ReleaseError(f"keyword row {index} has invalid category/language/replacement")
        if len(term) < 2 or (term.isascii() and len(term) < 4):
            raise ReleaseError(f"keyword row {index} term is too short for safe deterministic replacement")
        key = term.casefold()
        if key in seen:
            raise ReleaseError(f"duplicate private keyword fingerprint={sha256_bytes(term.encode())[:16]}")
        seen.add(key)
        keywords.append(Keyword(category, language, term, replacement))
    if not keywords:
        raise ReleaseError("keyword file must contain at least one keyword")
    categories = {item.category for item in keywords}
    missing = sorted(REQUIRED_KEYWORD_CATEGORIES - categories)
    if missing:
        raise ReleaseError(f"keyword file is missing required categories: {','.join(missing)}")
    keywords.sort(key=lambda item: len(item.term), reverse=True)
    return keywords


def is_placeholder(value: str) -> bool:
    upper = value.upper()
    return any(marker.upper() in upper for marker in PLACEHOLDER_MARKERS)


def matches_any(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def path_policy_hit(relative: str, allowed_artifact_patterns: Iterable[str]) -> str | None:
    pure = PurePosixPath(relative)
    if relative == ".env.example":
        return None
    if any(part.casefold() in DENIED_COMPONENTS for part in pure.parts[:-1]):
        return "denied_runtime_component"
    basename = pure.name
    if basename == ".DS_Store" or basename.startswith("._"):
        return "macos_metadata"
    if any(pattern.match(basename) for pattern in DANGEROUS_FILENAMES):
        return "credential_filename"
    lower = basename.casefold()
    suffix_hit = next((suffix for suffix in DENIED_SUFFIXES if lower.endswith(suffix)), None)
    if suffix_hit and not matches_any(relative, allowed_artifact_patterns):
        return f"denied_suffix:{suffix_hit}"
    return None


def git_candidates(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise ReleaseError(f"git candidate inventory failed for {root}: {result.stderr.decode(errors='replace').strip()}")
    return sorted(item.decode("utf-8") for item in result.stdout.split(b"\0") if item)


def resolve_root(
    root_spec: str,
    supermatrix_root: Path,
    workspaces_root: Path,
    public_base_root: Path | None,
) -> Path:
    if root_spec == "supermatrix":
        root = supermatrix_root
    elif root_spec.startswith("workspace:"):
        name = root_spec.split(":", 1)[1]
        if not name or "/" in name or name in {".", ".."}:
            raise ReleaseError(f"invalid workspace root spec: {root_spec}")
        root = workspaces_root / name
    elif root_spec == "public-base":
        if public_base_root is None:
            raise ReleaseError("public-base mapping requires --public-base-root")
        root = public_base_root
    else:
        raise ReleaseError(f"unknown root spec: {root_spec}")
    root = root.resolve()
    if not root.is_dir() or not (root / ".git").exists():
        raise ReleaseError(f"source root is not a Git repository: {root}")
    return root


def selected_files(
    mapping: dict[str, Any],
    supermatrix_root: Path,
    workspaces_root: Path,
    public_base_root: Path | None,
) -> list[tuple[Path, str, str]]:
    git_root = resolve_root(str(mapping["root"]), supermatrix_root, workspaces_root, public_base_root)
    subpath = PurePosixPath(str(mapping.get("subpath", ".")))
    if subpath.is_absolute() or ".." in subpath.parts:
        raise ReleaseError(f"invalid source subpath in mapping {mapping.get('name')}")
    prefix = "" if str(subpath) == "." else f"{subpath.as_posix().rstrip('/')}/"
    include = mapping.get("include", [])
    exclude = mapping.get("exclude", [])
    if not isinstance(include, list) or not include:
        raise ReleaseError(f"mapping {mapping.get('name')} must have include patterns")
    selected: list[tuple[Path, str, str]] = []
    for git_relative in git_candidates(git_root):
        if prefix and not git_relative.startswith(prefix):
            continue
        relative = git_relative[len(prefix) :] if prefix else git_relative
        if not relative or not matches_any(relative, include) or matches_any(relative, exclude):
            continue
        source = git_root / git_relative
        if not source.exists() and not source.is_symlink():
            continue
        destination = (PurePosixPath(str(mapping["destination"])) / relative).as_posix()
        selected.append((source, relative, destination))
    return selected


def obvious_test_credential(value: str) -> bool:
    quoted = re.search(r"['\"]([^'\"]+)['\"]", value)
    candidate = quoted.group(1) if quoted else value
    candidate = re.sub(r"\\[nrt]", "-", candidate.casefold())
    words = re.findall(r"[a-z]+", candidate)
    return bool(words) and set(words) <= TEST_CREDENTIAL_WORDS


def detect_secrets(text: str) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    for detector, pattern in SECRET_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(0)
            if is_placeholder(value):
                continue
            if obvious_test_credential(value):
                continue
            hits.append((detector, value))
    return hits


def apply_replacements(
    text: str,
    keywords: list[Keyword],
    literal_replacements: list[tuple[str, str, str]],
) -> tuple[str, Counter[str]]:
    counts: Counter[str] = Counter()
    for category, source, replacement in literal_replacements:
        if not source:
            continue
        pattern = re.compile(re.escape(source), re.IGNORECASE if source.isascii() else 0)
        text, count = pattern.subn(replacement, text)
        if count:
            counts[category] += count
    for keyword in keywords:
        pattern = re.compile(re.escape(keyword.term), re.IGNORECASE if keyword.term.isascii() else 0)
        text, count = pattern.subn(keyword.replacement, text)
        if count:
            counts[f"keyword:{keyword.category}:{keyword.language}"] += count
    for category, pattern, replacement in AUTO_REDACTIONS:
        text, count = pattern.subn(replacement, text)
        if count:
            counts[f"pattern:{category}"] += count
    text, email_count = redact_private_emails(text)
    if email_count:
        counts["pattern:email"] += email_count
    return text, counts


def allowed_email(value: str) -> bool:
    if is_placeholder(value):
        return True
    domain = value.rsplit("@", 1)[-1].casefold()
    return domain in ALLOWED_EMAIL_DOMAINS


def redact_private_emails(text: str) -> tuple[str, int]:
    email_pattern = GENERIC_PATTERNS[0][1]
    count = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal count
        value = match.group(0)
        if allowed_email(value):
            return value
        count += 1
        return "user@example.com"

    return email_pattern.sub(replace, text), count


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def scan_text(relative: str, text: str, keywords: list[Keyword]) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []

    def add(detector: str, value: str, offset: int) -> None:
        hits.append(
            {
                "path": relative,
                "line": line_number(text, offset),
                "detector": detector,
                "fingerprint": sha256_bytes(value.encode("utf-8"))[:16],
            }
        )

    for detector, value in detect_secrets(text):
        offset = text.find(value)
        add(detector, value, max(offset, 0))
    for keyword in keywords:
        pattern = re.compile(re.escape(keyword.term), re.IGNORECASE if keyword.term.isascii() else 0)
        for match in pattern.finditer(text):
            add(f"private_keyword:{keyword.category}:{keyword.language}", match.group(0), match.start())
    for detector, pattern in GENERIC_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(0)
            if detector == "email" and allowed_email(value):
                continue
            if detector not in {"private_user_path", "windows_user_path", "merge_conflict"} and is_placeholder(value):
                continue
            add(detector, value, match.start())
    return hits


def scan_relative_path(relative: str, keywords: list[Keyword]) -> list[dict[str, Any]]:
    hits = scan_text(relative, relative, keywords)
    for hit in hits:
        hit["line"] = 0
        hit["detector"] = f"path:{hit['detector']}"
    return hits


def decode_utf8(path: Path, data: bytes) -> str:
    if b"\0" in data:
        raise ReleaseError(f"binary NUL byte found: {path}")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReleaseError(f"non-UTF-8 file rejected: {path}: {exc}") from exc


def normalize_source_bytes(path: Path, data: bytes) -> tuple[bytes, Counter[str]]:
    counts: Counter[str] = Counter()
    nul_count = data.count(b"\0")
    if not nul_count:
        return data, counts
    if path.suffix.casefold() not in {".js", ".cjs", ".mjs", ".ts", ".tsx"}:
        raise ReleaseError(f"binary NUL byte found: {path}")
    counts["source:nul_escape"] = nul_count
    return data.replace(b"\0", b"\\0"), counts


def normalize_synthetic_secret_fixtures(text: str) -> tuple[str, Counter[str]]:
    counts: Counter[str] = Counter()
    for source, replacement in SYNTHETIC_SECRET_REPLACEMENTS:
        text, count = re.subn(re.escape(source), replacement, text)
        if count:
            counts["source:synthetic_secret_fixture"] += count
    for body in SYNTHETIC_SECRET_BODIES:
        text, count = re.subn(rf"(?<!TEST_){re.escape(body)}", f"TEST_{body}", text)
        if count:
            counts["source:synthetic_secret_fixture"] += count
    return text, counts


def keyword_summary(keywords: list[Keyword], keyword_file: Path) -> dict[str, Any]:
    return {
        "file_sha256": sha256_file(keyword_file),
        "count": len(keywords),
        "by_category": dict(sorted(Counter(item.category for item in keywords).items())),
        "by_language": dict(sorted(Counter(item.language for item in keywords).items())),
        "term_fingerprints": sorted(item.fingerprint for item in keywords),
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def prepare_empty_output(path: Path) -> None:
    if path.exists():
        if not path.is_dir():
            raise ReleaseError(f"output exists and is not a directory: {path}")
        if any(path.iterdir()):
            raise ReleaseError(f"output directory must be empty: {path}")
    else:
        path.mkdir(parents=True)


def build_snapshot(args: argparse.Namespace) -> dict[str, Any]:
    config_path = args.config.resolve()
    keyword_file = args.keyword_file.resolve()
    config = load_json(config_path)
    if config.get("schema_version") != 1 or not isinstance(config.get("mappings"), list):
        raise ReleaseError("export config must use schema_version=1 and a mappings array")
    max_bytes = int(config.get("max_file_bytes", 0))
    if max_bytes <= 0:
        raise ReleaseError("max_file_bytes must be positive")
    allowed_artifacts = [str(item) for item in config.get("allowed_artifact_patterns", [])]
    keywords = load_keywords(keyword_file)
    output = args.output.resolve()
    prepare_empty_output(output)
    public_base_root = getattr(args, "public_base_root", None)
    if public_base_root is not None:
        public_base_root = public_base_root.resolve()

    home = Path.home().resolve()
    literal_replacements = [
        ("path:workspaces", str(args.workspaces_root.resolve()), "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces"),
        ("path:supermatrix", str(args.supermatrix_root.resolve()), "/Users/LOCAL_USER/SuperMatrix"),
        ("path:home", str(home), "/Users/LOCAL_USER"),
        ("user", home.name, "LOCAL_USER"),
        (
            "public:localwatch_scheduler_v2",
            'SCHEDULER_PORT="${SCHEDULER_V2_PORT:-3502}"',
            'SCHEDULER_PORT="${SCHEDULER_V2_PORT:-3502}"',
        ),
    ]

    files: list[dict[str, Any]] = []
    seen_destinations: dict[str, str] = {}
    replacement_totals: Counter[str] = Counter()
    mapping_counts: Counter[str] = Counter()

    for mapping in config["mappings"]:
        if not isinstance(mapping, dict) or not mapping.get("name") or not mapping.get("destination"):
            raise ReleaseError("every mapping requires name and destination")
        mapping_name = str(mapping["name"])
        for source, source_relative, destination_relative in selected_files(
            mapping, args.supermatrix_root, args.workspaces_root, public_base_root
        ):
            previous = seen_destinations.get(destination_relative)
            if previous:
                raise ReleaseError(
                    f"duplicate destination {destination_relative}: {previous} and {mapping_name}:{source_relative}"
                )
            seen_destinations[destination_relative] = f"{mapping_name}:{source_relative}"
            policy_hit = path_policy_hit(destination_relative, allowed_artifacts)
            if policy_hit:
                raise ReleaseError(f"path policy blocked {destination_relative}: {policy_hit}")
            path_findings = scan_relative_path(destination_relative, keywords)
            if path_findings:
                detectors = ",".join(sorted({item["detector"] for item in path_findings}))
                raise ReleaseError(f"private destination path blocked {destination_relative}: {detectors}")
            if source.is_symlink():
                raise ReleaseError(f"symlink rejected: {source}")
            if not source.is_file():
                continue
            size = source.stat().st_size
            if size > max_bytes:
                raise ReleaseError(f"file exceeds max_file_bytes ({size}>{max_bytes}): {source}")
            raw = source.read_bytes()
            normalized, normalization_counts = normalize_source_bytes(source, raw)
            text = decode_utf8(source, normalized)
            text, fixture_counts = normalize_synthetic_secret_fixtures(text)
            normalization_counts.update(fixture_counts)
            secret_hits = detect_secrets(text)
            if secret_hits:
                detectors = ",".join(sorted({detector for detector, _ in secret_hits}))
                raise ReleaseError(f"high-confidence secret blocked in {mapping_name}:{source_relative}: {detectors}")
            redacted, replacement_counts = apply_replacements(text, keywords, literal_replacements)
            replacement_counts.update(normalization_counts)
            destination = output / destination_relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            encoded = redacted.encode("utf-8")
            destination.write_bytes(encoded)
            source_mode = stat.S_IMODE(source.stat().st_mode)
            destination.chmod(0o755 if source_mode & 0o111 else 0o644)
            replacement_totals.update(replacement_counts)
            mapping_counts[mapping_name] += 1
            files.append(
                {
                    "mapping": mapping_name,
                    "source": source_relative,
                    "destination": destination_relative,
                    "bytes": len(encoded),
                    "source_sha256": sha256_bytes(raw),
                    "output_sha256": sha256_bytes(encoded),
                    "replacements": dict(sorted(replacement_counts.items())),
                }
            )

    scan = scan_tree(output, keywords, max_bytes, allowed_artifacts)
    payload = {
        "schema_version": 1,
        "ok": scan["ok"],
        "config_sha256": sha256_file(config_path),
        "keywords": keyword_summary(keywords, keyword_file),
        "file_count": len(files),
        "byte_count": sum(row["bytes"] for row in files),
        "mapping_counts": dict(sorted(mapping_counts.items())),
        "replacement_totals": dict(sorted(replacement_totals.items())),
        "files": files,
        "scan": scan,
    }
    write_json(args.evidence.resolve(), payload)
    if not scan["ok"]:
        raise ReleaseError(f"post-build scan found {scan['finding_count']} finding(s)")
    return payload


def scan_tree(
    root: Path,
    keywords: list[Keyword],
    max_bytes: int,
    allowed_artifacts: Iterable[str],
) -> dict[str, Any]:
    root = root.resolve()
    if not root.is_dir():
        raise ReleaseError(f"scan root is not a directory: {root}")
    hits: list[dict[str, Any]] = []
    file_count = 0
    byte_count = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == ".git" or relative.startswith(".git/"):
            continue
        if path.is_symlink():
            hits.append({"path": relative, "line": 0, "detector": "symlink", "fingerprint": "symlink"})
            continue
        if path.is_dir():
            continue
        file_count += 1
        size = path.stat().st_size
        byte_count += size
        policy_hit = path_policy_hit(relative, allowed_artifacts)
        if policy_hit:
            hits.append({"path": relative, "line": 0, "detector": policy_hit, "fingerprint": "path"})
            continue
        hits.extend(scan_relative_path(relative, keywords))
        if size > max_bytes:
            hits.append({"path": relative, "line": 0, "detector": "oversized_file", "fingerprint": str(size)})
            continue
        data = path.read_bytes()
        try:
            text = decode_utf8(path, data)
        except ReleaseError:
            hits.append({"path": relative, "line": 0, "detector": "binary_or_non_utf8", "fingerprint": sha256_bytes(data)[:16]})
            continue
        hits.extend(scan_text(relative, text, keywords))
    hits.sort(key=lambda row: (row["path"], row["line"], row["detector"]))
    return {
        "ok": not hits,
        "file_count": file_count,
        "byte_count": byte_count,
        "finding_count": len(hits),
        "finding_counts": dict(sorted(Counter(row["detector"] for row in hits).items())),
        "findings": hits,
    }


def scan_existing(args: argparse.Namespace) -> dict[str, Any]:
    config = load_json(args.config.resolve()) if args.config else {}
    max_bytes = int(args.max_file_bytes or config.get("max_file_bytes", 5 * 1024 * 1024))
    allowed_artifacts = [str(item) for item in config.get("allowed_artifact_patterns", [])]
    keywords = load_keywords(args.keyword_file.resolve())
    scan = scan_tree(args.root.resolve(), keywords, max_bytes, allowed_artifacts)
    payload = {
        "schema_version": 1,
        "ok": scan["ok"],
        "keywords": keyword_summary(keywords, args.keyword_file.resolve()),
        "scan": scan,
    }
    write_json(args.evidence.resolve(), payload)
    return payload


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subparsers = root.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build", help="copy and sanitize the configured public source allowlist")
    build.add_argument("--config", type=Path, required=True)
    build.add_argument("--supermatrix-root", type=Path, required=True)
    build.add_argument("--workspaces-root", type=Path, required=True)
    build.add_argument("--public-base-root", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--keyword-file", type=Path, required=True)
    build.add_argument("--evidence", type=Path, required=True)

    scan = subparsers.add_parser("scan", help="scan a complete release tree")
    scan.add_argument("--root", type=Path, required=True)
    scan.add_argument("--keyword-file", type=Path, required=True)
    scan.add_argument("--evidence", type=Path, required=True)
    scan.add_argument("--config", type=Path)
    scan.add_argument("--max-file-bytes", type=int)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        payload = build_snapshot(args) if args.command == "build" else scan_existing(args)
    except ReleaseError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    summary = {
        "ok": payload["ok"],
        "file_count": payload.get("file_count", payload.get("scan", {}).get("file_count", 0)),
        "finding_count": payload.get("scan", {}).get("finding_count", 0),
    }
    print(json.dumps(summary, sort_keys=True))
    return 0 if payload["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
