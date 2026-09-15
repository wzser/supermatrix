#!/usr/bin/env python3.11
"""fp_assemble.py — 确定性装配 session 的 CLAUDE.md/AGENTS.md。

按 manifest 三位数 section_no 升序，把 universal + 命中 capability 的模块 snippet
拼成文档；999 段从旧文件逐字保留。生成结果与旧文件相同则 no-op。零 LLM。
"""
import argparse, json, os, re, sqlite3, subprocess, sys
from pathlib import Path
from typing import Optional

FP_ROOT = Path(__file__).resolve().parents[1]


def resolve_sm_db_path(env=None, home=None) -> Optional[Path]:
    """Resolve an optional runtime database without guessing a private path.

    A public checkout is allowed to assemble identity documents before a live
    runtime exists.  Only an explicit SM_DB/SM_RUNTIME_ROOT (or the optional
    public fixture path) may opt into SQLite lookup; otherwise callers receive
    ``None`` and use the documented empty-runtime behavior.
    """
    env = env if env is not None else os.environ
    if env.get("SM_DB"):
        return Path(env["SM_DB"])
    if env.get("SM_RUNTIME_ROOT"):
        return Path(env["SM_RUNTIME_ROOT"]) / "data/supermatrix.db"
    if env.get("SM_PUBLIC_DB"):
        return Path(env["SM_PUBLIC_DB"])
    if home is not None:
        return home / "SuperMatrixRuntime/data/supermatrix.db"
    return None


SM_DB = resolve_sm_db_path()
SELF_PLACEHOLDER = "<!-- 本 session 自有内容；由 session 自行维护 -->"
SEC_RE = lambda no: re.compile(rf"^## {no}\b.*$", re.MULTILINE)

# backend/model/effort 统一 catalog（owner=wendangwang，见 §243）：每个 session 工作区
# 放一份指过去的 symlink，消费方本地直读，SSoT 仍在 owner 仓、随其 publish 原子刷新。
CATALOG_SYMLINK_NAME = "backend-model-effort-catalog.json"
CATALOG_SOURCE = Path(
    os.environ.get(
        "SM_CATALOG_SOURCE",
        str(FP_ROOT / "data/backend-model-effort-catalog.json"),
    )
)


def ensure_catalog_symlink(workdir: Path) -> str:
    """幂等保证 workdir 下有指向统一 catalog 的 symlink。
    已是正确 symlink → ok；指向别处/断链 → 重指；同名真实文件/目录 → skip（不覆盖 session 自有内容）。
    """
    link = workdir / CATALOG_SYMLINK_NAME
    if link.is_symlink():
        if Path(os.readlink(link)) == CATALOG_SOURCE:
            return "ok"
        link.unlink()
    elif link.exists():
        return "skip-exists"
    os.symlink(str(CATALOG_SOURCE), link)
    return "created"


class AssemblerVariantMissing(Exception):
    """Raised when a session selected a variant via session-variants.json but its snippet
    file is empty or missing. Use this instead of silently emitting an empty section."""
    pass


# §000 子节的常见标题特征（用于识别"本该是 ### 却被误标为 ##"的子节）。
# 故意不加 re.I：避免误伤 legacy 英文 h2（"Habits"/"Responsibilities"）。
# 模板正文用小写 `working habits`，所以小写匹配即可覆盖。
SELF_SUBSECTION_RE = re.compile(
    r"我是谁|身份|我做什么|我不做什么|我的职责|我\s*own|习惯|偏好|working habits"
)


def detect_self_truncation(text: str):
    """检测 §000 段内是否有被误标为 `## ` 的子节标题。

    extract_self_section 在 §000 之后遇到第一个 `^## ` 就收尾；若该 `## ` 实为
    §000 子节（身份/职责/习惯），它本身及其后整段 §000 会被静默洗掉
    （larkc 2026-06-02 实测）。返回被误标的标题行列表（空=无问题）。
    """
    problems = []
    for no in ("000", "0", "999"):
        m = SEC_RE(no).search(text)
        if not m:
            continue
        body = text[m.end():]
        nxt = re.search(r"^## .*$", body, re.MULTILINE)
        if nxt and SELF_SUBSECTION_RE.search(nxt.group(0).lstrip("#").strip()):
            problems.append(nxt.group(0).strip())
        break  # 只判定第一个命中的 §000 编号
    return problems


def _section_body(text: str, no: int):
    """抽 `## <no>` 段正文（到下一个 `^## ` 前）。no==0 兼容老编号 000/0/999。

    收尾边界 = 该段之后第一个 `^## ` 标题：自有子节用 `###` 不会被误截；
    §000/§002… 互为边界各自收尾；未模块化旧文件里 §000 后跟一串 legacy 通用
    h2（Core Behavioral Rules / Cross-Session 等）也在此截断，否则 legacy 尾巴
    会被并进自有段并与注入模块重复。找不到该段返回 None（由调用方决定占位/略过）。
    """
    candidates = ("000", "0", "999") if no == 0 else (f"{no:03d}",)
    for c in candidates:
        m = SEC_RE(c).search(text)
        if not m:
            continue
        body = text[m.end():]
        nxt = re.search(r"^## ", body, re.MULTILINE)
        if nxt:
            body = body[:nxt.start()]
        return body.strip()
    return None


def extract_self_sections(text: str, self_nos) -> dict:
    """self_nos：manifest 里 owner=__session__ 的 section_no 升序列表。
    返回 {no: body or None}——session 没在自己文件里写该段则 None。
    §000 永远逐字保留；§002/003/004 等可选自有段同样逐字保留，缺则 None。"""
    return {no: _section_body(text, no) for no in self_nos}


def render_session001(chat_id) -> str:
    """§001 正文：FP 从运行时库装配的本 session 路由参数。所有 session 同一套渲染、
    同一个数据源（bindings 表），不写任何 per-session 特例逻辑。"""
    lines = [
        "> 本段由 first-principle 装配时从运行时库 `supermatrix.db` 自动生成，"
        "**不是你维护的**；手改下次装配即被覆盖。要改值改 SuperMatrix `bindings` 表，别改这里。",
        "",
    ]
    if chat_id:
        lines += [
            f"- **绑定群 chat_id**：`{chat_id}`",
            "  - 用途：你发飞书通知 / 图片 / 文件的目标群——"
            "`lark-cli im +messages-send --chat-id <值>` 即送达本 session 对应的人。",
            "  - 脚本里仍按 `$SM_SESSION_NAME` 动态解析，别把上面的字面值复制进脚本"
            "（workdir 可能多 session 共用，硬编码会路由到错群）：",
            "    `sqlite3 \"$SM_RUNTIME_ROOT/data/supermatrix.db\" "
            "\"SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id "
            "WHERE s.name='$SM_SESSION_NAME' LIMIT 1;\"`",
        ]
    else:
        lines += [
            "- **绑定群 chat_id**：（未绑定）——本 session 暂无飞书群绑定；"
            "发消息前先确认绑定，或用 `$SM_SESSION_NAME` 查 `bindings` 表。",
        ]
    lines += [
        f"- **可用 backend / model / effort 参数**：本工作区 `{CATALOG_SYMLINK_NAME}`"
        "（symlink → wendangwang 维护的统一 catalog，随其发布自动刷新）；"
        "只可用其中 `status=available` 的值，禁硬编码或另起私有枚举（硬约束见 §243）。",
    ]
    return "\n".join(lines)


def normalize_runtime_paths(text: str, runtime_params=None) -> str:
    home = (runtime_params or {}).get("home") or str(Path.home())
    source_home = (runtime_params or {}).get("source_home") or str(Path.home())
    return text.replace(source_home, home)


def load_session_variants(path):
    """Read data/session-variants.json. Missing file = empty sessions dict
    (default behavior preserved for all sessions). Schema is permissive in v1:
    we trust the file content."""
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"schema_version": 1, "sessions": {}}


def load_category_policy(path):
    """Read data/category-capability-defaults.json.

    Missing/invalid policy preserves the historical full-assembly behavior.
    """
    try:
        data = json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"defaults": {}, "variants": {}}
    if not isinstance(data, dict):
        return {"defaults": {}, "variants": {}}
    data.setdefault("defaults", {})
    data.setdefault("variants", {})
    return data


def category_module_set(category, category_policy):
    defaults = (category_policy or {}).get("defaults") or {}
    if category and category in defaults and isinstance(defaults[category], list):
        return set(defaults[category])
    return None


def module_included_for_category(mod, category, category_policy):
    no = mod.get("section_no")
    if no in (0, 1) or mod.get("owner") == "__session__":
        return True
    allowed = category_module_set(category, category_policy)
    if allowed is None:
        return True
    return mod.get("module") in allowed


def resolve_module_variant(session_name, module_name, variants_data, category=None, category_policy=None):
    """Returns 'original' | 'omit' | single lowercase letter 'a'-'z'.

    Lookup: per-session variant overrides category variant; absent = 'original'.
    Validation: letter must be [a-z]; anything else not 'omit' falls back to 'original'.
    """
    sess = variants_data.get("sessions", {}).get(session_name, {})
    modules = sess.get("modules", {})
    if isinstance(modules, dict) and module_name in modules:
        choice = modules.get(module_name)
    else:
        choice = ((category_policy or {}).get("variants") or {}).get(category or "", {}).get(module_name)
    if choice is None:
        choice = "original"
    if choice == "omit":
        return "omit"
    if isinstance(choice, str) and len(choice) == 1 and "a" <= choice <= "z":
        return choice
    return "original"


def variant_snippet_filename(module_meta, variant):
    """Map (module, variant) → snippet file name (not path).
    variant='original' or None → '<module>.md'
    variant='a' → '<module>.a.md'
    """
    sp = module_meta.get("snippet_path")
    if not sp:
        return None
    base = Path(sp).name  # e.g., 'larkcli.md'
    if variant in (None, "original"):
        return base
    # Insert variant before '.md': larkcli.md → larkcli.a.md
    stem, ext = base.rsplit(".", 1)
    return f"{stem}.{variant}.{ext}"


def compute_fingerprint(session_name, manifest, variants_data, category=None, category_policy=None):
    """Compute the deterministic fingerprint for what this session will assemble.

    Format: concatenation of '<3-digit section_no>[<variant letter>]' per included module,
    in ascending section_no order. Omitted modules absent.

    Example: 000001121240a300  (sections 0,1,121,240 with variant a, 300; no omits)
    """
    pieces = []
    for mod in sorted(manifest, key=lambda x: x["section_no"]):
        if not module_included_for_category(mod, category, category_policy):
            continue
        # Global disable (启用/停用 from principle table → manifest.enabled): a module with
        # enabled=false is skipped for ALL sessions. §0/§1 (identity/runtime) can never be
        # disabled. Absent enabled → true. Must mirror the build loop so the fingerprint drops
        # the disabled section (else hash-short-circuit would wrongly skip re-assembly).
        if mod.get("enabled", True) is False and mod["section_no"] not in (0, 1):
            continue
        variant = resolve_module_variant(session_name, mod["module"], variants_data, category, category_policy)
        if variant == "omit":
            continue
        sec = f"{mod['section_no']:03d}"
        if variant == "original":
            pieces.append(sec)
        else:
            pieces.append(f"{sec}{variant}")
    return "".join(pieces)


def build_doc(
    session_name,
    manifest,
    snippets,
    self_bodies,
    runtime_params,
    variants_data=None,
    category=None,
    category_policy=None,
) -> str:
    """Variant-aware document assembly.

    variants_data: dict from data/session-variants.json (None / empty → all defaults).
    Backward compat: passing None or {'sessions':{}} produces byte-identical output to pre-variant code.
    """
    if variants_data is None:
        variants_data = {"sessions": {}}
    mods = sorted(manifest, key=lambda x: x["section_no"])
    fp_string = compute_fingerprint(session_name, manifest, variants_data, category, category_policy)
    parts = [f"# {session_name}", "", f"<!-- fp-fingerprint: {fp_string} -->", ""]
    for mod in mods:
        if not module_included_for_category(mod, category, category_policy):
            continue
        no, cov = mod["section_no"], mod["coverage"]
        # Global disable (enabled=false, mirrored in compute_fingerprint): skip for ALL sessions.
        # §0/§1 identity/runtime are never disableable. Absent enabled → true (assembled).
        if mod.get("enabled", True) is False and no not in (0, 1):
            continue
        variant = resolve_module_variant(session_name, mod["module"], variants_data, category, category_policy)
        # Sections 0, 1 cannot be omitted (identity + runtime required)
        if variant == "omit" and no in (0, 1):
            # Lint should reject this; defensively treat as 'original'
            variant = "original"
        if variant == "omit":
            continue
        if mod.get("assembly") == "fp_runtime":
            parts += [f"## {no:03d} {mod['title']}", "",
                      render_session001(runtime_params.get("chat_id")).strip(), ""]
            continue
        if mod.get("owner") == "__session__":
            body = (self_bodies or {}).get(no)
            if not body:
                if cov == "preserve-optional":
                    continue  # 选填自有段（§002/003/004）：session 没写就不出空段
                body = SELF_PLACEHOLDER  # §000 必出：缺失给占位提示 session 自维护
            body = normalize_runtime_paths(body, runtime_params)
            parts += [f"## {no:03d} {mod['title']}", "", body.strip(), ""]
            continue
        # Framework principle: pick variant or default. Manifest is authoritative.
        body = ""
        if mod.get("snippet_path"):
            # Resolve snippet file: manifest variants[letter].snippet_path wins; fall back to filename convention.
            if variant != "original" and isinstance(mod.get("variants"), dict) and variant in mod["variants"]:
                ventry = mod["variants"][variant]
                resolved_path = ventry.get("snippet_path", "")
                fname = Path(resolved_path).name if resolved_path else variant_snippet_filename(mod, variant)
            else:
                fname = variant_snippet_filename(mod, variant)
            body = snippets.get(fname, "")
            # Hard-fail: if session selected a NON-default variant and its body is empty,
            # don't silently ship an empty section.
            if variant != "original" and not body.strip():
                raise AssemblerVariantMissing(
                    f"session '{session_name}' selected variant '{variant}' for module "
                    f"'{mod['module']}' but snippet '{fname}' is empty or missing. "
                    f"Either fix session-variants.json, restore the variant file, or remove the manifest variant entry."
                )
        body = body.replace("{session-name}", session_name)
        body = normalize_runtime_paths(body, runtime_params)
        parts += [f"## {no} {mod['title']}", "", body.strip(), ""]
    return "\n".join(parts).rstrip() + "\n"


def load_snippets(manifest, category):
    """Load default + all variant snippet files. Returns dict keyed by file basename.

    For each module with snippet_path 'snippets/<module>.md':
      - Always loads <module>.md (default)
      - Discovers snippets/<module>.<letter>.md siblings and loads them
    """
    out = {}
    for mod in manifest:
        sp = mod.get("snippet_path")
        if not sp:
            continue
        sp = sp.replace("{category}", category or "业务")
        default_p = FP_ROOT / sp
        out[Path(sp).name] = default_p.read_text() if default_p.exists() else ""
        # Discover variants: snippets/<stem>.<letter>.md
        stem = Path(sp).stem  # e.g., 'larkcli'
        parent = default_p.parent
        if parent.exists():
            for variant_file in parent.glob(f"{stem}.*.md"):
                # Skip if this IS the default (no variant letter between stem and .md)
                rel_name = variant_file.name
                if rel_name == Path(sp).name:
                    continue
                # Validate variant letter format: <stem>.<letter>.md where letter is [a-z]
                middle = rel_name[len(stem) + 1:-3]  # between '<stem>.' and '.md'
                if len(middle) == 1 and "a" <= middle <= "z":
                    out[rel_name] = variant_file.read_text()
    return out


def session_category(name):
    if SM_DB is None:
        return None
    try:
        conn = sqlite3.connect(str(SM_DB))
        row = conn.execute("SELECT category FROM sessions WHERE name=? LIMIT 1;", (name,)).fetchone()
        conn.close()
        return row[0] if row and row[0] else None
    except Exception:
        return None


def session_chat_id(name):
    """本 session 绑定的飞书群 chat_id（bindings 表，session 1:1 group）。无绑定/读不到返回 None。"""
    if SM_DB is None:
        return None
    try:
        conn = sqlite3.connect(str(SM_DB))
        row = conn.execute(
            "SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id "
            "WHERE s.name=? LIMIT 1;", (name,)).fetchone()
        conn.close()
        return row[0] if row and row[0] else None
    except Exception:
        return None


def write_pair(workdir: Path, text: str, do_write: bool) -> str:
    claude = workdir / "CLAUDE.md"
    old = claude.read_text() if claude.exists() else ""
    if text == old:
        return "no-op"
    if do_write:
        claude.write_text(text)
        (workdir / "AGENTS.md").write_text(text)  # byte 对称镜像
    return "changed"


def declared_session_name(text: str) -> Optional[str]:
    """Return the generated document's first-line session title, if it has one."""
    first_line = text.splitlines()[0] if text.splitlines() else ""
    match = re.fullmatch(r"#\s+([^\n]+?)\s*", first_line)
    return match.group(1).strip() if match else None


def conflicting_workspace_identity(workdir: Path, session: str) -> Optional[str]:
    """Return a fail-closed diagnostic for an unsafe generated-doc target."""
    for filename in ("CLAUDE.md", "AGENTS.md"):
        path = workdir / filename
        if not path.exists():
            continue
        actual = declared_session_name(path.read_text())
        if actual is None:
            return f"{filename} has no first-line '# <session>' header"
        if actual != session:
            return f"workspace identity belongs to {actual} ({filename})"
    return None


def missing_required_self_section(workdir: Path) -> Optional[str]:
    """Fail closed before an existing legacy document can lose owner-authored text.

    A missing §000 is valid only for a brand-new workspace with no identity files yet:
    build_doc() intentionally creates its placeholder in that case.  Once either
    identity file exists, however, treating an unnumbered legacy document as empty
    would replace the whole owner-owned body on --write.  Its owner must first
    envelope that content as §000.
    """
    for filename in ("CLAUDE.md", "AGENTS.md"):
        path = workdir / filename
        if path.exists() and _section_body(path.read_text(), 0) is None:
            return f"{filename} lacks required ## 000 self-owned section"
    return None


def check_self_dirty(workdir: Path, manifest) -> int:
    """v2.6 新增：dirty-check 只看自有段，不看框架段。

    对比 working tree CLAUDE.md 的自有段 vs HEAD CLAUDE.md 的自有段：
    相同 = clean（exit 0，可装配）；不同 = dirty（exit 1，session 在写自有段中应 defer）。
    框架段 dirty / AGENTS.md 单边 dirty 不影响——那些是 FP-owned，装配器会正确刷新。
    HEAD 无 CLAUDE.md（新 session 初始化期）= treat as clean。
    """
    claude = workdir / "CLAUDE.md"
    if not claude.exists():
        return 0  # 没文件不 dirty
    self_nos = sorted(m["section_no"] for m in manifest if m.get("owner") == "__session__")
    wt_bodies = extract_self_sections(claude.read_text(), self_nos)
    try:
        head_text = subprocess.run(
            ["git", "-C", str(workdir), "show", "HEAD:CLAUDE.md"],
            capture_output=True, text=True, check=True).stdout
    except subprocess.CalledProcessError:
        return 0  # HEAD 无 CLAUDE.md（新 session）= clean
    head_bodies = extract_self_sections(head_text, self_nos)
    return 0 if wt_bodies == head_bodies else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--manifest", default=str(FP_ROOT / "data/module-manifest.json"))
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--check-self-dirty", action="store_true",
                    help="v2.6：仅检自有段 dirty，exit 0=clean / 1=dirty。框架段 dirty 不阻塞")
    ap.add_argument("--fingerprint", action="store_true",
                    help="Print the fingerprint for this session's variant selection and exit (no file writes)")
    ap.add_argument("--category-override",
                    help="Use this category instead of reading the sessions table; used during /new init before DB metadata is durable")
    a = ap.parse_args()

    manifest = json.loads(Path(a.manifest).read_text())["modules"]
    category = a.category_override or session_category(a.session)
    category_policy = load_category_policy(str(FP_ROOT / "data/category-capability-defaults.json"))
    workdir = Path(a.workdir)
    identity_conflict = conflicting_workspace_identity(workdir, a.session)
    missing_self_section = missing_required_self_section(workdir)
    if getattr(a, "check_self_dirty"):
        if identity_conflict:
            sys.stderr.write(f"{a.session}: blocked — {identity_conflict}\n")
            sys.exit(5)
        if missing_self_section:
            sys.stderr.write(f"{a.session}: blocked — {missing_self_section}\n")
            sys.exit(6)
        sys.exit(check_self_dirty(workdir, manifest))

    if getattr(a, "fingerprint", False):
        variants_data = load_session_variants(str(FP_ROOT / "data/session-variants.json"))
        print(compute_fingerprint(a.session, manifest, variants_data, category, category_policy))
        sys.exit(0)

    snippets = load_snippets(manifest, category)
    self_nos = sorted(m["section_no"] for m in manifest if m.get("owner") == "__session__")
    existing = workdir / "CLAUDE.md"
    if identity_conflict:
        sys.stderr.write(f"{a.session}: blocked — {identity_conflict}\n")
        print(f"{a.session}: blocked ({identity_conflict})")
        sys.exit(5)
    if missing_self_section:
        sys.stderr.write(f"{a.session}: blocked — {missing_self_section}\n")
        print(f"{a.session}: blocked ({missing_self_section})")
        sys.exit(6)
    if existing.exists():
        raw = existing.read_text()
        problems = detect_self_truncation(raw)
        if problems:
            sys.stderr.write(
                f"\n!!! BLOCKED {a.session}: §000 子节被误标为 `## ` 二级标题，"
                "装配会静默截断 §000。请把下列标题降级为 `### `:\n"
            )
            for h in problems:
                sys.stderr.write(f"      {h}\n")
            sys.stderr.write(
                "  原因：extract_self_section 在 §000 后遇到第一个 `## ` 即收尾，"
                "误标子节及其后整段会丢失。修好标题再装配。\n\n"
            )
            print(f"{a.session}: blocked (self-000 mis-leveled heading)")
            sys.exit(3)
        self_bodies = extract_self_sections(raw, self_nos)
    else:
        self_bodies = {}
    runtime_params = {"chat_id": session_chat_id(a.session), "home": str(Path.home())}
    variants_data = load_session_variants(str(FP_ROOT / "data/session-variants.json"))
    try:
        doc = build_doc(
            a.session,
            manifest,
            snippets,
            self_bodies,
            runtime_params,
            variants_data,
            category,
            category_policy,
        )
    except AssemblerVariantMissing as e:
        sys.stderr.write(f"\n!!! BLOCKED {a.session}: variant snippet missing\n  {e}\n\n")
        print(f"{a.session}: blocked (variant missing)")
        sys.exit(4)
    status = write_pair(workdir, doc, a.write)
    if a.write:
        ensure_catalog_symlink(workdir)
    print(f"{a.session}: {status}")


if __name__ == "__main__":
    main()
