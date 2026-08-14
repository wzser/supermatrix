#!/usr/bin/env python3
"""Weekly skill upgrade entrypoints.

Pattern copied from watchdog's weekly CLI upgrade:

  do      = create rollback snapshot, run bounded upgrade steps, write pending
            state + receipt, then exit quickly.
  report  = run availability verification, write a markdown report, and clear
            pending state.

External GitHub skill sources are declared in config/skill-upgrade-sources.json.
Self-authored/local skills are intentionally excluded. Packages with local
customization use either git patch replay or baseline three-way merges instead
of blind overwrites.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
SOURCE_REGISTRY = ROOT / "config" / "skill-upgrade-sources.json"
ROLLBACK = ROOT / "scripts" / "skill-upgrade-rollback.py"
SYNC_SKILLS = ROOT / "scripts" / "sync-skills.sh"
DATA_DIR = ROOT / "data" / "skill-upgrades"
REPORT_DIR = DATA_DIR / "reports"
LOG_FILE = DATA_DIR / "weekly-skill-upgrade.log"
PENDING_FILE = DATA_DIR / "pending-weekly-skill-upgrade.json"
RECEIPT_FILE = DATA_DIR / "scheduler_receipts" / "weekly-skill-upgrade.receipt"

SUPERPOWERS_ROOT = Path.home() / ".codex" / "superpowers"
GSTACK_ROOT = Path.home() / ".claude" / "skills" / "gstack"
DEFAULT_RUNTIME_ROOT = Path("/Users/LOCAL_USER/SuperMatrixRuntime")

MERGE_EXCLUDE_NAMES = {
    ".git",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".DS_Store",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def utc_day() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def run_json(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> dict[str, Any]:
    res = run(cmd, cwd=cwd, timeout=timeout)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout or f"exit {res.returncode}").strip())
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"non-json output from {' '.join(cmd)}: {res.stdout[:500]}") from exc


def expand_path(value: str | Path) -> Path:
    path = Path(str(value).replace("$HOME", str(Path.home()))).expanduser()
    if path.is_absolute():
        return path
    return ROOT / path


def load_source_registry() -> dict[str, Any]:
    try:
        registry = json.loads(SOURCE_REGISTRY.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"missing source registry: {SOURCE_REGISTRY}") from exc
    if registry.get("schema_version") != 1:
        raise RuntimeError(f"unsupported source registry schema: {registry.get('schema_version')}")
    return registry


def git(path: Path, *args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run(["git", "-C", str(path), *args], timeout=timeout)


def git_text(path: Path, *args: str, timeout: int = 120) -> str:
    res = git(path, *args, timeout=timeout)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout or f"git {' '.join(args)} failed").strip())
    return res.stdout.strip()


def git_status(path: Path) -> str:
    res = git(path, "status", "--short")
    return res.stdout.strip() if res.returncode == 0 else ""


def rev_parse(path: Path, ref: str) -> str:
    return git_text(path, "rev-parse", ref)


def fetch_compare(path: Path, remote_ref: str = "origin/main") -> dict[str, Any]:
    before = rev_parse(path, "HEAD")
    fetch = git(path, "fetch", "origin", timeout=180)
    if fetch.returncode != 0:
        return {
            "ok": False,
            "before": before,
            "after": before,
            "error": (fetch.stderr or fetch.stdout).strip()[:500],
        }
    remote = rev_parse(path, remote_ref)
    counts = git_text(path, "rev-list", "--left-right", "--count", f"HEAD...{remote_ref}")
    ahead_s, behind_s = (counts.split() + ["0", "0"])[:2]
    return {
        "ok": True,
        "before": before,
        "after": before,
        "remote": remote,
        "ahead": int(ahead_s),
        "behind": int(behind_s),
        "changed": before != remote,
    }


def github_repo_parts(repo_url: str) -> tuple[str, str]:
    parsed = urllib.parse.urlparse(repo_url)
    if parsed.netloc != "github.com":
        raise RuntimeError(f"unsupported github repo URL: {repo_url}")
    parts = parsed.path.strip("/").removesuffix(".git").split("/")
    if len(parts) != 2:
        raise RuntimeError(f"unsupported github repo URL: {repo_url}")
    return parts[0], parts[1]


def github_ref_name(remote_ref: str) -> str:
    if remote_ref.startswith("origin/"):
        return remote_ref.split("/", 1)[1]
    return remote_ref


def read_url_json(url: str, timeout: int = 60) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def download_url_bytes(url: str, timeout: int = 90, retries: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                return response.read()
        except Exception as exc:  # noqa: BLE001 - preserve download errors for report.
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(1)
    raise RuntimeError(str(last_error))


def download_github_tree_snapshot(package: dict[str, Any]) -> dict[str, Any]:
    worktree = expand_path(package["upstream_worktree"])
    owner, repo = github_repo_parts(package["repo"])
    ref = github_ref_name(package.get("remote_ref", "origin/main"))
    sparse_paths = [str(p).strip("/") for p in package.get("sparse_paths", []) if str(p).strip("/")]
    if not sparse_paths:
        return {
            "ok": False,
            "worktree": str(worktree),
            "error": "github-tree-api download_strategy requires sparse_paths",
        }

    try:
        ref_data = read_url_json(f"https://api.github.com/repos/{owner}/{repo}/git/ref/heads/{ref}")
        commit = ref_data.get("object", {}).get("sha", ref)
        tree = read_url_json(f"https://api.github.com/repos/{owner}/{repo}/git/trees/{commit}?recursive=1")
    except Exception as exc:  # noqa: BLE001 - return structured failure.
        return {
            "ok": False,
            "worktree": str(worktree),
            "error": f"github tree lookup failed: {exc}",
        }

    entries = [
        item["path"]
        for item in tree.get("tree", [])
        if item.get("type") == "blob"
        and any(item.get("path", "") == prefix or item.get("path", "").startswith(f"{prefix}/") for prefix in sparse_paths)
    ]
    if not entries:
        return {
            "ok": False,
            "worktree": str(worktree),
            "error": f"github tree contained no files for sparse_paths={sparse_paths}",
        }

    tmp = worktree.with_name(f".{worktree.name}.download-{stamp()}")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)

    raw_base = f"https://raw.githubusercontent.com/{owner}/{repo}/{commit}"

    download_timeout = int(package.get("download_timeout", 30))
    download_retries = int(package.get("download_retries", 2))

    def fetch_one(path: str) -> str:
        data = download_url_bytes(
            f"{raw_base}/{urllib.parse.quote(path)}",
            timeout=download_timeout,
            retries=download_retries,
        )
        dest = tmp / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return path

    errors: list[str] = []
    workers = int(package.get("download_workers", 12))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        future_to_path = {executor.submit(fetch_one, path): path for path in entries}
        for future in concurrent.futures.as_completed(future_to_path):
            path = future_to_path[future]
            try:
                future.result()
            except Exception as exc:  # noqa: BLE001 - report all failed paths.
                errors.append(f"{path}: {exc}")

    if errors:
        shutil.rmtree(tmp, ignore_errors=True)
        return {
            "ok": False,
            "worktree": str(worktree),
            "error": "; ".join(errors[:5]),
        }

    manifest = {
        "schema_version": 1,
        "download_strategy": "github-tree-api",
        "repo": package["repo"],
        "commit": commit,
        "sparse_paths": sparse_paths,
        "file_count": len(entries),
        "downloaded_at": iso_now(),
    }
    (tmp / ".source-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if worktree.exists():
        shutil.rmtree(worktree)
    tmp.rename(worktree)
    return {
        "ok": True,
        "worktree": str(worktree),
        "commit": commit,
        "file_count": len(entries),
        "download_strategy": "github-tree-api",
    }


def ensure_upstream_worktree(package: dict[str, Any]) -> dict[str, Any]:
    if package.get("download_strategy") == "github-tree-api":
        return download_github_tree_snapshot(package)

    worktree = expand_path(package["upstream_worktree"])
    repo = package["repo"]
    remote_ref = package.get("remote_ref", "origin/main")
    sparse_paths = package.get("sparse_paths") or []
    worktree.parent.mkdir(parents=True, exist_ok=True)
    if (worktree / ".git").exists():
        if sparse_paths:
            sparse = git(worktree, "sparse-checkout", "set", *sparse_paths, timeout=120)
            if sparse.returncode != 0:
                return {
                    "ok": False,
                    "worktree": str(worktree),
                    "error": (sparse.stderr or sparse.stdout).strip()[:500],
                }
        fetch = git(worktree, "fetch", "origin", timeout=240)
        if fetch.returncode != 0:
            return {
                "ok": False,
                "worktree": str(worktree),
                "error": (fetch.stderr or fetch.stdout).strip()[:500],
            }
    else:
        if worktree.exists():
            shutil.rmtree(worktree)
        clone_cmd = ["git", "clone", repo, str(worktree)]
        if sparse_paths:
            clone_cmd = ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", repo, str(worktree)]
        clone = run(clone_cmd, timeout=600)
        if clone.returncode != 0:
            return {
                "ok": False,
                "worktree": str(worktree),
                "error": (clone.stderr or clone.stdout).strip()[:500],
            }
        if sparse_paths:
            sparse = git(worktree, "sparse-checkout", "set", *sparse_paths, timeout=120)
            if sparse.returncode != 0:
                return {
                    "ok": False,
                    "worktree": str(worktree),
                    "error": (sparse.stderr or sparse.stdout).strip()[:500],
                }
    reset = git(worktree, "reset", "--hard", remote_ref, timeout=180)
    if reset.returncode != 0:
        return {
            "ok": False,
            "worktree": str(worktree),
            "error": (reset.stderr or reset.stdout).strip()[:500],
        }
    return {
        "ok": True,
        "worktree": str(worktree),
        "commit": rev_parse(worktree, "HEAD"),
    }


def is_ignored_rel(rel: Path) -> bool:
    return any(part in MERGE_EXCLUDE_NAMES for part in rel.parts)


def iter_files(root: Path) -> set[Path]:
    if not root.exists():
        return set()
    out: set[Path] = set()
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if is_ignored_rel(rel) or path.is_dir():
            continue
        out.add(rel)
    return out


def sha256(path: Path) -> str | None:
    if not path.exists() or path.is_dir():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def same_file(a: Path, b: Path) -> bool:
    ha = sha256(a)
    hb = sha256(b)
    return ha is not None and ha == hb


def copy_tree_filtered(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        return
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if is_ignored_rel(rel):
            continue
        target = dst / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_symlink():
            target.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(os.readlink(path), target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def remove_empty_dirs(root: Path) -> None:
    if not root.exists():
        return
    for path in sorted([p for p in root.rglob("*") if p.is_dir()], reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def is_probably_text(path: Path) -> bool:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return False
    if b"\0" in data:
        return False
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def git_merge_file(local: Path, base: Path, upstream: Path) -> tuple[bool, str]:
    res = run(["git", "merge-file", "-p", str(local), str(base), str(upstream)], timeout=30)
    if res.returncode == 0:
        return True, res.stdout
    return False, (res.stderr or res.stdout).strip()[:500]


def enforce_frontmatter_name(skill_dir: Path, expected_name: str) -> bool:
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.exists():
        return False
    text = skill_file.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return False
    end = text.find("\n---", 4)
    if end < 0:
        return False
    header = text[4:end].splitlines()
    changed = False
    seen = False
    new_header: list[str] = []
    for line in header:
        if line.startswith("name:"):
            seen = True
            replacement = f"name: {expected_name}"
            new_header.append(replacement)
            changed = changed or line != replacement
        else:
            new_header.append(line)
    if not seen:
        new_header.insert(0, f"name: {expected_name}")
        changed = True
    if changed:
        skill_file.write_text("---\n" + "\n".join(new_header) + text[end:] + "\n", encoding="utf-8")
    return changed


def create_snapshot() -> dict[str, Any]:
    return run_json([
        sys.executable,
        str(ROLLBACK),
        "snapshot",
        "--reason",
        "weekly",
        "--label",
        "weekly-skill-upgrade",
        "--json",
    ], cwd=ROOT, timeout=900)


def restore_snapshot(snapshot_id: str) -> dict[str, Any]:
    res = run([
        sys.executable,
        str(ROLLBACK),
        "restore",
        snapshot_id,
        "--no-safety-snapshot",
    ], cwd=ROOT, timeout=1800)
    return {
        "ok": res.returncode == 0,
        "stdout": res.stdout[-4000:],
        "stderr": res.stderr[-4000:],
        "exit_code": res.returncode,
    }


def verify_current(write_report: bool) -> dict[str, Any]:
    args = [sys.executable, str(ROLLBACK), "verify-current", "--json"]
    if not write_report:
        args.append("--no-report")
    return run_json(args, cwd=ROOT, timeout=120)


def sync_skill_master() -> dict[str, Any]:
    res = run([str(SYNC_SKILLS)], cwd=ROOT, timeout=120)
    return {
        "component": "skill-master",
        "action": "sync",
        "status": "ok" if res.returncode == 0 else "failed",
        "changed": False,
        "summary": "sync-skills.sh completed" if res.returncode == 0 else "sync-skills.sh failed",
        "stdout": res.stdout[-2000:],
        "stderr": res.stderr[-2000:],
    }


def validate_preserve_checks(package: dict[str, Any], root: Path) -> list[str]:
    failures: list[str] = []
    for check in package.get("preserve_checks", []):
        path = root / check["path"]
        if not path.exists():
            failures.append(f"missing preserve check path: {path}")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for needle in check.get("contains", []):
            if needle not in text:
                failures.append(f"missing preserved marker {needle!r} in {path}")
    return failures


def upgrade_superpowers(package: dict[str, Any], apply: bool = True) -> dict[str, Any]:
    root = expand_path(package.get("local_root", str(SUPERPOWERS_ROOT)))
    remote_ref = package.get("remote_ref", "origin/main")
    if not root.exists():
        return {
            "component": "superpowers",
            "action": "selective-upgrade",
            "status": "missing",
            "changed": False,
            "summary": f"missing {root}",
        }
    state = fetch_compare(root, remote_ref=remote_ref)
    if not state.get("ok"):
        return {
            "component": "superpowers",
            "action": "selective-upgrade",
            "status": "failed",
            "changed": False,
            "summary": state.get("error", "fetch failed"),
            "state": state,
        }
    before_status = git_status(root)
    if state["behind"] == 0:
        failures = validate_preserve_checks(package, root)
        return {
            "component": "superpowers",
            "action": "selective-upgrade",
            "status": "failed" if failures else "latest",
            "changed": False,
            "summary": "preserve checks failed" if failures else "already at fetched upstream with local custom layer",
            "policy": "git patch replay; no blind overwrite",
            "state": state,
            "preserve_failures": failures,
        }
    if not apply:
        return {
            "component": "superpowers",
            "action": "selective-upgrade",
            "status": "available",
            "changed": False,
            "summary": f"{remote_ref} is {state['behind']} commit(s) ahead; selective upgrade available",
            "policy": "git patch replay; no blind overwrite",
            "state": state,
        }

    stash_output = ""
    had_local_patch = bool(before_status)
    if had_local_patch:
        stash = git(root, "stash", "push", "-u", "-m", f"weekly-skill-upgrade-superpowers {stamp()}", timeout=180)
        stash_output = (stash.stdout + stash.stderr).strip()
        if stash.returncode != 0:
            return {
                "component": "superpowers",
                "action": "selective-upgrade",
                "status": "failed",
                "changed": False,
                "summary": f"git stash failed: {stash_output[:300]}",
                "state": state,
            }

    reset = git(root, "reset", "--hard", remote_ref, timeout=180)
    if reset.returncode != 0:
        return {
            "component": "superpowers",
            "action": "selective-upgrade",
            "status": "failed",
            "changed": False,
            "summary": f"git reset failed: {(reset.stderr or reset.stdout).strip()[:300]}",
            "stash_output": stash_output,
            "state": state,
        }

    replay_output = ""
    if had_local_patch:
        replay = git(root, "stash", "pop", timeout=240)
        replay_output = (replay.stdout + replay.stderr).strip()
        if replay.returncode != 0:
            return {
                "component": "superpowers",
                "action": "selective-upgrade",
                "status": "failed",
                "changed": True,
                "summary": f"local SuperMatrix patch replay conflicted: {replay_output[:500]}",
                "stash_output": stash_output,
                "replay_output": replay_output[-2000:],
                "state": {**state, "after": rev_parse(root, "HEAD")},
            }

    failures = validate_preserve_checks(package, root)
    return {
        "component": "superpowers",
        "action": "selective-upgrade",
        "status": "failed" if failures else "upgraded",
        "changed": True,
        "summary": "preserve checks failed after upgrade" if failures else f"rebased local SuperMatrix patch layer onto {remote_ref}",
        "policy": "git patch replay; no blind overwrite",
        "stash_output": stash_output,
        "replay_output": replay_output[-2000:],
        "state": {**state, "after": rev_parse(root, "HEAD")},
        "preserve_failures": failures,
    }


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return "unknown"


def upgrade_gstack(apply: bool) -> dict[str, Any]:
    if not GSTACK_ROOT.exists():
        return {
            "component": "gstack",
            "action": "upgrade",
            "status": "missing",
            "changed": False,
            "summary": f"missing {GSTACK_ROOT}",
        }
    old_version = read_text(GSTACK_ROOT / "VERSION")
    state = fetch_compare(GSTACK_ROOT)
    if not state.get("ok"):
        return {
            "component": "gstack",
            "action": "upgrade",
            "status": "failed",
            "changed": False,
            "summary": state.get("error", "fetch failed"),
            "before_version": old_version,
            "after_version": old_version,
            "state": state,
        }
    if state["behind"] == 0:
        return {
            "component": "gstack",
            "action": "upgrade",
            "status": "latest",
            "changed": False,
            "summary": "already at fetched origin/main",
            "before_version": old_version,
            "after_version": old_version,
            "state": state,
        }
    if not apply:
        return {
            "component": "gstack",
            "action": "upgrade",
            "status": "available",
            "changed": False,
            "summary": f"origin/main is {state['behind']} commit(s) ahead; rerun do --apply-gstack to upgrade",
            "before_version": old_version,
            "after_version": old_version,
            "state": state,
        }

    stash_output = ""
    if git_status(GSTACK_ROOT):
        stash = git(GSTACK_ROOT, "stash", "push", "-u", "-m", f"weekly-skill-upgrade {stamp()}", timeout=180)
        stash_output = (stash.stdout + stash.stderr).strip()
        if stash.returncode != 0:
            return {
                "component": "gstack",
                "action": "upgrade",
                "status": "failed",
                "changed": False,
                "summary": f"git stash failed: {stash_output[:300]}",
                "before_version": old_version,
                "after_version": old_version,
                "state": state,
            }

    reset = git(GSTACK_ROOT, "reset", "--hard", "origin/main", timeout=180)
    if reset.returncode != 0:
        return {
            "component": "gstack",
            "action": "upgrade",
            "status": "failed",
            "changed": False,
            "summary": f"git reset failed: {(reset.stderr or reset.stdout).strip()[:300]}",
            "before_version": old_version,
            "after_version": old_version,
            "stash_output": stash_output,
            "state": state,
        }

    setup = run(["./setup"], cwd=GSTACK_ROOT, timeout=900)
    after_version = read_text(GSTACK_ROOT / "VERSION")
    if setup.returncode != 0:
        return {
            "component": "gstack",
            "action": "upgrade",
            "status": "failed",
            "changed": True,
            "summary": f"./setup failed: {(setup.stderr or setup.stdout).strip()[:500]}",
            "before_version": old_version,
            "after_version": after_version,
            "stash_output": stash_output,
            "state": state,
        }

    return {
        "component": "gstack",
        "action": "upgrade",
        "status": "upgraded",
        "changed": True,
        "summary": f"{old_version} -> {after_version}",
        "before_version": old_version,
        "after_version": after_version,
        "stash_output": stash_output,
        "state": {**state, "after": rev_parse(GSTACK_ROOT, "HEAD")},
        "setup_stdout_tail": setup.stdout[-2000:],
        "setup_stderr_tail": setup.stderr[-2000:],
    }


def merge_directory(local_dir: Path, base_dir: Path, upstream_dir: Path, expected_name: str) -> dict[str, Any]:
    changed: list[str] = []
    conflicts: list[str] = []
    warnings: list[str] = []

    if not base_dir.exists():
        copy_tree_filtered(upstream_dir, base_dir)
        return {
            "status": "baseline_initialized",
            "changed": False,
            "summary": f"initialized baseline for {expected_name}; no local files changed",
            "changed_files": [],
            "conflicts": [],
            "warnings": [],
        }

    if not local_dir.exists():
        copy_tree_filtered(upstream_dir, local_dir)
        enforce_frontmatter_name(local_dir, expected_name)
        copy_tree_filtered(upstream_dir, base_dir)
        return {
            "status": "created",
            "changed": True,
            "summary": f"created missing local skill {expected_name} from upstream",
            "changed_files": ["."],
            "conflicts": [],
            "warnings": [],
        }

    base_files = iter_files(base_dir)
    upstream_files = iter_files(upstream_dir)
    local_files = iter_files(local_dir)
    if all(
        rel in base_files and same_file(upstream_dir / rel, base_dir / rel)
        for rel in upstream_files
    ) and all(rel in upstream_files for rel in base_files):
        return {
            "status": "latest",
            "changed": False,
            "summary": f"{expected_name} upstream unchanged since baseline",
            "changed_files": [],
            "conflicts": [],
            "warnings": [],
        }

    with tempfile.TemporaryDirectory(prefix=f"skill-merge-{expected_name}-", dir=str(DATA_DIR)) as tmp:
        temp_dir = Path(tmp) / expected_name
        copy_tree_filtered(local_dir, temp_dir)
        all_files = sorted(base_files | upstream_files | local_files)
        for rel in all_files:
            base_file = base_dir / rel
            upstream_file = upstream_dir / rel
            local_file = local_dir / rel
            temp_file = temp_dir / rel

            base_exists = rel in base_files
            upstream_exists = rel in upstream_files
            local_exists = rel in local_files

            if not base_exists and upstream_exists:
                if not local_exists:
                    temp_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(upstream_file, temp_file)
                    changed.append(str(rel))
                elif same_file(local_file, upstream_file):
                    continue
                else:
                    conflicts.append(f"{rel}: upstream added file but local already has different file")
                continue

            if base_exists and not upstream_exists:
                if local_exists and same_file(local_file, base_file):
                    if temp_file.exists():
                        temp_file.unlink()
                        changed.append(str(rel))
                elif local_exists:
                    warnings.append(f"{rel}: upstream deleted file, kept locally modified copy")
                continue

            if not base_exists or not upstream_exists:
                continue

            if not local_exists:
                if same_file(base_file, upstream_file):
                    continue
                conflicts.append(f"{rel}: local deleted file that upstream changed")
                continue

            if same_file(local_file, base_file):
                if not same_file(base_file, upstream_file):
                    temp_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(upstream_file, temp_file)
                    changed.append(str(rel))
                continue

            if same_file(upstream_file, base_file) or same_file(local_file, upstream_file):
                continue

            if is_probably_text(local_file) and is_probably_text(base_file) and is_probably_text(upstream_file):
                ok, output = git_merge_file(local_file, base_file, upstream_file)
                if ok:
                    temp_file.parent.mkdir(parents=True, exist_ok=True)
                    temp_file.write_text(output, encoding="utf-8")
                    changed.append(str(rel))
                else:
                    conflicts.append(f"{rel}: merge conflict: {output}")
            else:
                conflicts.append(f"{rel}: binary or non-utf8 file changed both locally and upstream")

        if conflicts:
            return {
                "status": "conflict",
                "changed": False,
                "summary": f"{expected_name} has {len(conflicts)} merge conflict(s)",
                "changed_files": changed,
                "conflicts": conflicts,
                "warnings": warnings,
            }

        remove_empty_dirs(temp_dir)
        if local_dir.exists():
            shutil.rmtree(local_dir)
        shutil.copytree(temp_dir, local_dir, symlinks=True)

    frontmatter_changed = enforce_frontmatter_name(local_dir, expected_name)
    if frontmatter_changed:
        changed.append("SKILL.md:frontmatter-name")
    copy_tree_filtered(upstream_dir, base_dir)
    return {
        "status": "merged" if changed else "latest",
        "changed": bool(changed),
        "summary": f"merged upstream changes into {expected_name}" if changed else f"{expected_name} required no local changes",
        "changed_files": changed[:200],
        "conflicts": [],
        "warnings": warnings,
    }


def upgrade_mapped_skill_set(package: dict[str, Any]) -> dict[str, Any]:
    source = ensure_upstream_worktree(package)
    component = package["id"]
    if not source.get("ok"):
        return {
            "component": component,
            "action": "baseline-three-way",
            "status": "failed",
            "changed": False,
            "summary": source.get("error", "failed to fetch upstream"),
            "source": source,
        }

    upstream_root = Path(source["worktree"])
    baseline_root = expand_path(package["baseline_root"])
    local_root = expand_path(package["local_root"])
    details: list[dict[str, Any]] = []
    status_counts: dict[str, int] = {}
    changed = False
    conflicts: list[str] = []

    for mapping in package.get("mappings", []):
        local_name = mapping["local"]
        source_path = mapping["source"]
        source_dir = upstream_root if source_path == "." else upstream_root / source_path
        local_dir = local_root / local_name
        base_dir = baseline_root / local_name
        if not source_dir.exists():
            detail = {
                "skill": local_name,
                "source": source_path,
                "status": "failed",
                "summary": f"missing upstream source path {source_path}",
                "changed": False,
            }
        else:
            detail = {
                "skill": local_name,
                "source": source_path,
                **merge_directory(local_dir, base_dir, source_dir, local_name),
            }
        details.append(detail)
        status_counts[detail["status"]] = status_counts.get(detail["status"], 0) + 1
        changed = changed or bool(detail.get("changed"))
        if detail["status"] in {"failed", "conflict"}:
            conflicts.extend(f"{local_name}: {item}" for item in detail.get("conflicts", [detail["summary"]]))

    if conflicts:
        status = "failed"
        summary = f"{component}: {len(conflicts)} conflict/failure item(s)"
    elif status_counts.get("merged") or status_counts.get("created"):
        status = "upgraded"
        summary = f"{component}: merged {status_counts.get('merged', 0)} skill(s), created {status_counts.get('created', 0)}"
    elif status_counts.get("baseline_initialized"):
        status = "baseline_initialized"
        summary = f"{component}: initialized {status_counts['baseline_initialized']} baseline(s); no local files changed"
    else:
        status = "latest"
        summary = f"{component}: all mapped skills are current"

    return {
        "component": component,
        "action": "baseline-three-way",
        "status": status,
        "changed": changed,
        "summary": summary,
        "source": source,
        "status_counts": status_counts,
        "details": details,
        "unmatched_local": package.get("unmatched_local", []),
    }


def run_external_package(package: dict[str, Any]) -> dict[str, Any]:
    if not package.get("enabled", True):
        return {
            "component": package.get("id", "unknown"),
            "action": "skip",
            "status": "disabled",
            "changed": False,
            "summary": "disabled in source registry",
        }
    kind = package.get("kind")
    policy = package.get("policy")
    package_id = package.get("id")
    if package_id == "gstack" and policy == "reset-and-setup":
        return upgrade_gstack(apply=True)
    if package_id == "superpowers" and policy == "rebase-local-patches":
        return upgrade_superpowers(package, apply=True)
    if kind == "mapped-skill-set" and policy == "baseline-three-way":
        return upgrade_mapped_skill_set(package)
    return {
        "component": package_id or "unknown",
        "action": "skip",
        "status": "failed",
        "changed": False,
        "summary": f"unsupported package kind/policy: {kind}/{policy}",
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def append_log(payload: dict[str, Any]) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def write_receipt(payload: dict[str, Any]) -> None:
    write_json(RECEIPT_FILE, {"written_at": iso_now(), **payload})


def clear_pending() -> None:
    if PENDING_FILE.exists():
        PENDING_FILE.unlink()


def load_pending() -> dict[str, Any] | None:
    if not PENDING_FILE.exists():
        return None
    try:
        return json.loads(PENDING_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def run_do(args: argparse.Namespace) -> int:
    snapshot = create_snapshot()
    snapshot_id = snapshot["snapshot_id"]
    results: list[dict[str, Any]] = []

    results.append(sync_skill_master())
    registry = load_source_registry()
    for package in registry.get("packages", []):
        results.append(run_external_package(package))

    verify = verify_current(write_report=False)
    failed = [r for r in results if r.get("status") == "failed"]
    auto_rollback = None
    if (failed or not verify.get("ok")) and args.auto_rollback:
        auto_rollback = restore_snapshot(snapshot_id)
        verify = verify_current(write_report=False)

    payload = {
        "run_date": utc_day(),
        "started_at": snapshot["created_at"],
        "finished_at": iso_now(),
        "snapshot_id": snapshot_id,
        "source_registry": str(SOURCE_REGISTRY),
        "source_packages": [p.get("id") for p in registry.get("packages", []) if p.get("enabled", True)],
        "results": results,
        "verify": verify,
        "auto_rollback": auto_rollback,
    }
    append_log(payload)
    write_json(PENDING_FILE, payload)
    write_receipt({
        "run_date": payload["run_date"],
        "snapshot_id": snapshot_id,
        "result_statuses": {r["component"]: r["status"] for r in results},
        "verify_ok": verify.get("ok"),
        "auto_rollback": bool(auto_rollback),
    })

    print(f"snapshot_id={snapshot_id}")
    for result in results:
        print(f"{result['component']}: {result['status']} - {result['summary']}")
    print(f"verify_ok={verify.get('ok')}")
    if auto_rollback:
        print(f"auto_rollback_ok={auto_rollback.get('ok')}")
    print(f"pending={PENDING_FILE}")
    print(f"receipt={RECEIPT_FILE}")
    return 0 if not failed and verify.get("ok") else 2


def format_report(pending: dict[str, Any], verify: dict[str, Any]) -> str:
    snapshot_id = pending.get("snapshot_id", "unknown")
    lines = [
        "# Weekly Skill Upgrade Report",
        "",
        f"- run_date: {pending.get('run_date')}",
        f"- snapshot_id: `{snapshot_id}`",
        f"- source_registry: `{pending.get('source_registry')}`",
        f"- source_packages: {', '.join(pending.get('source_packages', []))}",
        f"- verify_ok: {verify.get('ok')}",
        "",
        "## Upgrade Results",
    ]
    for result in pending.get("results", []):
        lines.append(f"- **{result.get('component')}**: {result.get('status')} - {result.get('summary')}")
        if result.get("policy"):
            lines.append(f"  - policy: {result['policy']}")
        if result.get("unmatched_local"):
            lines.append(f"  - unmatched_local: {', '.join(result['unmatched_local'])}")
        if result.get("status_counts"):
            lines.append(f"  - status_counts: {json.dumps(result['status_counts'], ensure_ascii=False)}")
    if pending.get("auto_rollback"):
        rb = pending["auto_rollback"]
        lines.extend([
            "",
            "## Auto Rollback",
            f"- ok: {rb.get('ok')}",
            f"- exit_code: {rb.get('exit_code')}",
        ])
    lines.extend([
        "",
        "## Availability Verification",
        f"- errors: {len(verify.get('errors', []))}",
        f"- warnings: {len(verify.get('warnings', []))}",
    ])
    for err in verify.get("errors", []):
        lines.append(f"- ERROR: {err}")
    for warning in verify.get("warnings", []):
        lines.append(f"- WARN: {warning}")
    lines.extend([
        "",
        "## Rollback",
        "Run this if the upgraded skills behave incorrectly:",
        "",
        "```bash",
        f"scripts/skill-upgrade-rollback.py restore {snapshot_id}",
        "```",
    ])
    return "\n".join(lines) + "\n"


def resolve_chat_id() -> str | None:
    runtime_root = Path(os.environ.get("SM_RUNTIME_ROOT", str(DEFAULT_RUNTIME_ROOT)))
    session_name = os.environ.get("SM_SESSION_NAME", "skill-master")
    db = runtime_root / "data" / "supermatrix.db"
    if not db.exists():
        return None
    safe_session = session_name.replace("'", "''")
    sql = (
        "SELECT b.group_id FROM bindings b "
        "JOIN sessions s ON b.session_id=s.id "
        f"WHERE s.name='{safe_session}' LIMIT 1;"
    )
    res = run(["sqlite3", str(db), sql], timeout=10)
    if res.returncode != 0:
        return None
    chat_id = res.stdout.strip()
    return chat_id or None


def notify_report(report: str, report_path: Path, ok: bool) -> dict[str, Any]:
    chat_id = resolve_chat_id()
    if not chat_id:
        return {"ok": False, "reason": "missing chat_id"}
    body = report
    if len(body) > 3500:
        body = body[:3400] + f"\n\n... truncated. Full report: {report_path}\n"
    key = f"skill-upg-{datetime.now(timezone.utc).strftime('%m%d%H%M')}"
    res = run([
        "lark-cli",
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--chat-id",
        chat_id,
        "--markdown",
        body,
        "--idempotency-key",
        key,
    ], timeout=30)
    return {
        "ok": res.returncode == 0,
        "chat_id": chat_id,
        "exit_code": res.returncode,
        "stdout": res.stdout[-1000:],
        "stderr": res.stderr[-1000:],
        "level": "info" if ok else "warn",
    }


def run_report(args: argparse.Namespace) -> int:
    pending = load_pending()
    if not pending:
        print("no pending weekly skill upgrade")
        return 0
    verify = verify_current(write_report=True)
    report = format_report(pending, verify)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"{stamp()}-weekly-skill-upgrade.md"
    report_path.write_text(report, encoding="utf-8")
    print(f"report={report_path}")
    print(f"verify_ok={verify.get('ok')}")
    if args.notify:
        notify = notify_report(report, report_path, bool(verify.get("ok")))
        print(f"notify_ok={notify.get('ok')}")
        if not notify.get("ok"):
            print(f"notify_reason={notify.get('reason') or notify.get('stderr')}")
    if not args.keep_pending:
        clear_pending()
        print("pending_cleared=true")
    return 0 if verify.get("ok") else 2


def run_status(args: argparse.Namespace) -> int:
    pending = load_pending()
    print(json.dumps({
        "pending": pending,
        "pending_path": str(PENDING_FILE),
        "receipt_path": str(RECEIPT_FILE),
        "log_path": str(LOG_FILE),
        "source_registry": str(SOURCE_REGISTRY),
    }, indent=2, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_do = sub.add_parser("do", help="run weekly upgrade do stage")
    p_do.add_argument("--apply-gstack", action="store_true", help="compatibility flag; external GitHub packages are applied by registry")
    p_do.add_argument("--no-auto-rollback", dest="auto_rollback", action="store_false", help="do not restore snapshot on immediate failure")
    p_do.set_defaults(func=run_do, auto_rollback=True)

    p_report = sub.add_parser("report", help="write report for pending weekly upgrade")
    p_report.add_argument("--keep-pending", action="store_true", help="do not clear pending file after report")
    p_report.add_argument("--notify", action="store_true", help="send report to the skill-master bound Feishu group")
    p_report.set_defaults(func=run_report)

    p_status = sub.add_parser("status", help="print pending/log paths")
    p_status.set_defaults(func=run_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    started = time.time()
    try:
        return args.func(args)
    finally:
        print(f"elapsed={time.time() - started:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
