#!/usr/bin/env python3
# scripts/kimi-sea-autonomous-turn-patch.py
#
# Patches the kimi-code SEA binary for SuperMatrix's ACP contract:
#   - the top-level --skills-dir option is forwarded into the ACP harness;
#   - content events of agent-initiated turns with no client prompt active are forwarded as
#     standard session/update notifications (assistant/thought/tool events);
#   - every turn emits a `_sm_turn` lifecycle extension notification
#     ({sessionId, turnId, phase, reason, origin}).
#
# v2 (2026-07-22): the forwarder is installed at most once per SDK Session
# (guarded by `session.__smTurnForwarding`) and the prompt-active suppress
# flag lives on the shared Session (`session.__smAcpPromptTurnActive`).
# v1 installed one forwarder per AcpSession wrapper; session/load re-wraps
# the SAME cached Session (KimiHarness.activeSessions), so stale wrappers
# re-emitted every content chunk — the doubled-output incident (mr_ada1a0f3).
# v1-patched binaries are rejected with a restore-pristine instruction.
#
# Compatibility (2026-08-06): the 0.33.0 installer build left only 314 bytes
# between SEA and __LINKEDIT. Keep the SEA change as a compact loader and put
# the forwarding implementation in the versioned local helper so no Mach-O
# surgery is needed. kimi-code 0.33.0+ defaults to the native V2 engine
# (KIMI_CODE_LEGACY_FLAG=1 falls back to the legacy V1 classes): the patch is
# injected into the V2 AcpSession ctor (the legacy V1 ctor scope has no
# `require`, and a V1-only injection is inert on the default path). The
# loader uses `process.getBuiltinModule("fs")` instead of `require` because
# the 0.33.0 bundle is ESM-scoped. Layout is detected from the anchors; on a
# legacy V1 layout (<=0.30.0) the V1 ctor loader is used as before.
#
# Background: kimi-code ACP only emits session/update while a client
# session/prompt is in flight (runTurnBody's onEvent subscription).
# Autonomous turns run with no subscription and are ACP-invisible, which
# caused "Cannot launch a new turn while another turn (ID N) is active"
# collisions in SuperMatrix (docs/upstream-kimi-cli/issue-5).
#
# Usage:
#   python3 scripts/kimi-sea-autonomous-turn-patch.py [kimi-binary-path]
#   python3 scripts/kimi-sea-autonomous-turn-patch.py --verify [kimi-binary-path]
# Default path: ~/.kimi-code/bin/kimi. Idempotent: exits early when the
# binary already carries the patch. Creates <binary>.pre-sm-patch backup
# on first run, re-signs ad-hoc (codesign --sign -), verifies --version.
# --verify is read-only and reports the two required marker count for the
# post-upgrade watchdog audit; it never writes or re-signs the binary.
#
# Repatch after EVERY kimi-code upgrade (the upgrade replaces the binary).
# Rollback: cp <binary>.pre-sm-patch <binary> (or reinstall kimi-code).

import subprocess
import sys
import tempfile
from pathlib import Path

MAGIC = bytes([0x20, 0xDA, 0x43, 0x01])
PATCH_MARKER_V1 = "SM-PATCH (local fork)"
PATCH_MARKER_V2 = "SM-PATCH v2 (local fork)"
PATCH_MARKER_SKILLS_DIR = "SM-PATCH acp-skills-dir (local fork)"
PATCH_MARKER_V2_ENGINE = "SM-PATCH v2-engine (local fork)"
PATCH_MARKER_SKILLS_DIR_V2 = "SM-PATCH acp-skills-dir-v2 (local fork)"
RUNTIME_HELPER = Path(__file__).with_name("kimi-sea-runtime.cjs")
COMPACT_RUNTIME_SIDECAR_EXPRESSION = 'process.execPath+".sm.cjs"'

# --- JS patch anchors -------------------------------------------------------

ANCHOR_CTOR = (
    '\t\tif (typeof this.session.setQuestionHandler === "function") '
    "this.session.setQuestionHandler(async (req) => this.handleQuestion(req));\n\t}"
)
MAIN_AGENT_PREDICATE_PREFIX = "\t\t\tconst isFromMainAgent = "
MAIN_AGENT_PREDICATE_TOKEN = "__SM_MAIN_AGENT_PREDICATE__"

ANCHOR_ENTRY = "\trunTurnBody(sessionId, conn, kick) {\n\t\treturn new Promise((resolve, reject) => {\n"
ANCHOR_FINALLY = (
    "\t\t\tkick().catch((err) => {\n\t\t\t\tif (settled) return;\n\t\t\t\tsettled = true;"
    "\n\t\t\t\tunsub();\n\t\t\t\treject(mapPromptError(err, sessionId));\n\t\t\t});\n\t\t});\n\t}\n"
)
COMPACT_TURN_LOADER_TEMPLATE = (
    ANCHOR_CTOR[:-3]
    + "\n\t\tif(!this.session.__smTurnForwarding)Function(\"return \"+require(\"fs\").readFileSync(process.execPath+\".sm.cjs\"))()(this,"
      + MAIN_AGENT_PREDICATE_TOKEN
      + ");/*SM-PATCH v2 (local fork)*/\n\t}"
)

ANCHOR_ACP_HARNESS = (
    '\t\tconst harness = createKimiHarness({\n'
    '\t\t\tidentity: createKimiCodeHostIdentity(),\n'
    '\t\t\tuiMode: "acp"\n'
    '\t\t});'
)
REPLACEMENT_ACP_HARNESS = (
    '\t\tconst harness = createKimiHarness({\n'
    '\t\t\tidentity: createKimiCodeHostIdentity(),\n'
    '\t\t\tuiMode: "acp",\n'
    f'\t\t\tskillDirs: parent.opts().skillsDir /* {PATCH_MARKER_SKILLS_DIR} */\n'
    '\t\t});'
)

# Native V2 engine layout (kimi-code 0.33.0+). The V2 AcpSession ctor ends
# with the interaction-bridge assignment; the compact loader installs the
# V1/V2-agnostic runtime helper, which branches on the owner's shape. The
# top-level --skills-dir option is forwarded via the native acp command's
# runAcpServer opts, which the acp-server bootstrap forwards into the V2
# engine's host args (same `args.skillDirs` contract the prompt-mode server
# already uses).
ANCHOR_V2_CTOR = (
    "\t\t\tthis.interactionBridge = new AcpInteractionBridge(conn, this.session, sessionId, elicitationForm);\n\t\t}"
)
COMPACT_V2_TURN_LOADER_TEMPLATE = (
    ANCHOR_V2_CTOR[:-3]
    + '\n\t\t\tFunction("return "+process.getBuiltinModule("fs").readFileSync(process.execPath+".sm.cjs"))()(this);'
      + "/*" + PATCH_MARKER_V2_ENGINE + "*/\n\t\t}"
)
ANCHOR_V2_ACP_HOME_DIR = "\t\t\t\thomeDir: getDataDir(),"
REPLACEMENT_V2_ACP_ARGS = (
    "\t\t\t\targs: { skillDirs: parent.opts().skillsDir "
    + "/* " + PATCH_MARKER_SKILLS_DIR_V2 + " */"
    + " },\n"
    + "\t\t\t\thomeDir: getDataDir(),"
)
ANCHOR_V2_BOOTSTRAP = (
    '\tconst { app: core } = bootstrap({\n'
    '\t\thomeDir,\n'
    '\t\tconfigPath,\n'
    '\t\tclientIdentity: {\n'
    '\t\t\tproductName: opts.agentInfo?.name ?? "kimi-code-acp",'
)
REPLACEMENT_V2_BOOTSTRAP = (
    '\tconst { app: core } = bootstrap({\n'
    '\t\thomeDir,\n'
    '\t\tconfigPath,\n'
    '\t\targs: opts.args,\n'
    '\t\tclientIdentity: {\n'
    '\t\t\tproductName: opts.agentInfo?.name ?? "kimi-code-acp",'
)


def fail(msg: str) -> "SystemExit":
    print(f"ERROR: {msg}", file=sys.stderr)
    return SystemExit(1)


def apply_js_patch(js: str) -> str:
    if PATCH_MARKER_V1 in js:
        raise fail(
            "binary carries the v1 SM-PATCH (per-AcpSession forwarder — causes "
            "doubled output after session/load). Restore the pristine binary "
            "(<binary>.pre-sm-patch or kimi.pristine-*) first, then re-run."
        )

    # Native V2 engine layout (kimi-code 0.33.0+): the V2 classes are the
    # default runtime, so the loader goes into the V2 AcpSession ctor and the
    # skills-dir option is forwarded through the native acp command. The V1
    # classes are left pristine — a V1 injection is inert on the default path
    # and its `require`-based loader would crash legacy mode on this layout.
    v2_ctor_count = js.count(ANCHOR_V2_CTOR)
    v2_home_count = js.count(ANCHOR_V2_ACP_HOME_DIR)
    if v2_ctor_count or v2_home_count:
        if v2_ctor_count != 1 or v2_home_count != 1:
            raise fail(
                f"v2 anchors drifted: ctor {v2_ctor_count}x, acp-home {v2_home_count}x "
                "(expected 1 each) — kimi-code version drift?"
            )
        has_turn_patch = PATCH_MARKER_V2_ENGINE in js
        has_skills_dir_patch = PATCH_MARKER_SKILLS_DIR_V2 in js
        if has_turn_patch and has_skills_dir_patch:
            print("already patched (v2-engine + acp-skills-dir-v2) — nothing to do")
            return js
        if PATCH_MARKER_V2 in js or PATCH_MARKER_SKILLS_DIR in js:
            raise fail(
                "binary carries the legacy V1 SM-PATCH on the native-V2 layout; "
                "restore the pristine binary (<binary>.pre-sm-patch or "
                "kimi.pristine-*) first, then re-run."
            )
        if not has_turn_patch:
            js = js.replace(ANCHOR_V2_CTOR, COMPACT_V2_TURN_LOADER_TEMPLATE)
        if not has_skills_dir_patch:
            if js.count(ANCHOR_V2_ACP_HOME_DIR) != 1:
                raise fail(
                    "anchor 'native acp homeDir' found "
                    f"{js.count(ANCHOR_V2_ACP_HOME_DIR)}x (expected 1) — kimi-code version drift?"
                )
            js = js.replace(ANCHOR_V2_ACP_HOME_DIR, REPLACEMENT_V2_ACP_ARGS)
            if js.count(ANCHOR_V2_BOOTSTRAP) != 1:
                raise fail(
                    "anchor 'v2 acp bootstrap' found "
                    f"{js.count(ANCHOR_V2_BOOTSTRAP)}x (expected 1) — kimi-code version drift?"
                )
            js = js.replace(ANCHOR_V2_BOOTSTRAP, REPLACEMENT_V2_BOOTSTRAP)
        return js

    # Legacy V1 layout (<=0.30.0): patch the legacy AcpSession ctor and the
    # legacy acp command's harness creation.
    has_turn_patch = PATCH_MARKER_V2 in js
    has_skills_dir_patch = PATCH_MARKER_SKILLS_DIR in js
    if has_turn_patch and has_skills_dir_patch:
        print("already patched (turn-v2 + acp-skills-dir) — nothing to do")
        return js

    if not has_turn_patch:
        for name, anchor in [
            ("ctor", ANCHOR_CTOR),
            ("entry", ANCHOR_ENTRY),
            ("finally", ANCHOR_FINALLY),
        ]:
            if js.count(anchor) != 1:
                raise fail(f"anchor {name!r} found {js.count(anchor)}x (expected 1) — kimi-code version drift?")

        run_turn_body = js[js.index(ANCHOR_ENTRY) : js.index(ANCHOR_FINALLY)]
        if run_turn_body.count(MAIN_AGENT_PREDICATE_PREFIX) != 1:
            raise fail(
                "anchor 'main-agent predicate' found "
                f"{run_turn_body.count(MAIN_AGENT_PREDICATE_PREFIX)}x (expected 1) — "
                "kimi-code version drift?"
            )
        predicate_start = run_turn_body.index(MAIN_AGENT_PREDICATE_PREFIX) + len(MAIN_AGENT_PREDICATE_PREFIX)
        predicate_end = run_turn_body.index(";\n", predicate_start)
        main_agent_predicate = run_turn_body[predicate_start:predicate_end]
        compact_loader = COMPACT_TURN_LOADER_TEMPLATE.replace(
            MAIN_AGENT_PREDICATE_TOKEN,
            main_agent_predicate,
        )
        js = js.replace(ANCHOR_CTOR, compact_loader)

    if not has_skills_dir_patch:
        if js.count(ANCHOR_ACP_HARNESS) != 1:
            raise fail(
                "anchor 'acp harness' found "
                f"{js.count(ANCHOR_ACP_HARNESS)}x (expected 1) — kimi-code version drift?"
            )
        js = js.replace(ANCHOR_ACP_HARNESS, REPLACEMENT_ACP_HARNESS)

    return js


def verify_sm_patch_markers(js: str) -> int:
    """Return the installed marker count, failing closed for an incomplete patch.

    Layout-aware: a native-V2 layout (0.33.0+) validates the v2-engine /
    acp-skills-dir-v2 markers; a legacy V1 layout validates turn-v2 /
    acp-skills-dir. Both layouts report markerCount=2 when complete.
    """
    if PATCH_MARKER_V1 in js:
        raise fail(
            "binary carries the v1 SM-PATCH (per-AcpSession forwarder — causes "
            "doubled output after session/load); restore pristine before continuing"
        )
    v2_engine = js.count(PATCH_MARKER_V2_ENGINE)
    v2_skills = js.count(PATCH_MARKER_SKILLS_DIR_V2)
    if v2_engine or v2_skills:
        marker_counts = {
            "v2-engine": v2_engine,
            "acp-skills-dir-v2": v2_skills,
        }
        missing = [name for name, count in marker_counts.items() if count < 1]
        if missing:
            raise fail(f"required SM-PATCH markers missing: {', '.join(missing)}")
        duplicate = [name for name, count in marker_counts.items() if count > 1]
        if duplicate:
            raise fail(f"SM-PATCH markers duplicated: {', '.join(duplicate)}")
        return sum(marker_counts.values())
    marker_counts = {
        "turn-v2": js.count(PATCH_MARKER_V2),
        "acp-skills-dir": js.count(PATCH_MARKER_SKILLS_DIR),
    }
    missing = [name for name, count in marker_counts.items() if count < 1]
    if missing:
        raise fail(f"required SM-PATCH markers missing: {', '.join(missing)}")
    duplicate = [name for name, count in marker_counts.items() if count > 1]
    if duplicate:
        raise fail(f"SM-PATCH markers duplicated: {', '.join(duplicate)}")
    return sum(marker_counts.values())


def find_sea_section(data: bytes) -> tuple[int, int, int]:
    """Returns (fileoff, size, slack_after) of the __NODE_SEA_BLOB section.

    slack_after = bytes between section end and __LINKEDIT start. The SEA
    deserializer parses the blob by its internal length fields (js_len,
    asset count/sizes), not the declared section size, so the blob may
    safely spill into this slack (verified on 0.27.0: 6687 bytes slack;
    on 0.29.0 the compact +1343-byte patch fits its 1700-byte slack).
    """
    if int.from_bytes(data[0:4], "little") != 0xFEEDFACF:
        raise fail("not a 64-bit Mach-O binary")
    ncmds = int.from_bytes(data[16:20], "little")
    pos = 32
    sea: tuple[int, int] | None = None
    linkedit_off: int | None = None
    for _ in range(ncmds):
        cmd = int.from_bytes(data[pos : pos + 4], "little")
        cmdsize = int.from_bytes(data[pos + 4 : pos + 8], "little")
        if cmd == 0x19:  # LC_SEGMENT_64
            segname = data[pos + 8 : pos + 24].rstrip(b"\x00")
            if segname == b"__LINKEDIT":
                linkedit_off = int.from_bytes(data[pos + 40 : pos + 48], "little")
            nsects = int.from_bytes(data[pos + 56 : pos + 60], "little")
            sp = pos + 72
            for _ in range(nsects):
                sectname = data[sp : sp + 16].rstrip(b"\x00")
                if segname == b"NODE_SEA" and sectname == b"__NODE_SEA_BLOB":
                    size = int.from_bytes(data[sp + 40 : sp + 48], "little")
                    off = int.from_bytes(data[sp + 48 : sp + 56], "little")
                    sea = (off, size)
                sp += 80
        pos += cmdsize
    if sea is None or linkedit_off is None:
        raise fail("__NODE_SEA_BLOB or __LINKEDIT not found")
    return sea[0], sea[1], linkedit_off - (sea[0] + sea[1])


def find_sea_payload_end(blob: bytes, js_end: int) -> int:
    """Return the end of the self-describing SEA asset table."""
    if js_end + 8 > len(blob):
        raise fail("SEA asset count falls outside available section slack")
    asset_count = int.from_bytes(blob[js_end : js_end + 8], "little")
    pos = js_end + 8
    for index in range(asset_count):
        for field in ("name", "content"):
            if pos + 8 > len(blob):
                raise fail(
                    f"SEA asset {index} {field} length falls outside available section slack"
                )
            field_len = int.from_bytes(blob[pos : pos + 8], "little")
            pos += 8 + field_len
            if pos > len(blob):
                raise fail(
                    f"SEA asset {index} {field} falls outside available section slack"
                )
    return pos


def parse_cli() -> tuple[Path, bool]:
    args = sys.argv[1:]
    verify_only = False
    if "--verify" in args:
        if args.count("--verify") != 1:
            raise fail("--verify may be specified at most once")
        args.remove("--verify")
        verify_only = True
    if len(args) > 1:
        raise fail("usage: kimi-sea-autonomous-turn-patch.py [--verify] [kimi-binary-path]")
    return Path(args[0]) if args else Path.home() / ".kimi-code/bin/kimi", verify_only


def verify_runtime_helper() -> None:
    if not RUNTIME_HELPER.is_file():
        raise fail(f"compact runtime helper not found: {RUNTIME_HELPER}")
    check = subprocess.run(["node", "--check", str(RUNTIME_HELPER)], capture_output=True)
    if check.returncode != 0:
        raise fail(f"compact runtime helper failed node --check:\n{check.stderr.decode()[:2000]}")


def runtime_sidecar_path(binary: Path) -> Path:
    return binary.with_name(binary.name + ".sm.cjs")


def verify_runtime_sidecar(binary: Path, js: str) -> None:
    if COMPACT_RUNTIME_SIDECAR_EXPRESSION not in js:
        return
    sidecar = runtime_sidecar_path(binary)
    if not sidecar.is_file():
        raise fail(f"compact runtime sidecar not found: {sidecar}")
    check = subprocess.run(["node", "--check", str(sidecar)], capture_output=True)
    if check.returncode != 0:
        raise fail(f"compact runtime sidecar failed node --check:\n{check.stderr.decode()[:2000]}")


def stage_runtime_helper(binary: Path) -> None:
    sidecar = runtime_sidecar_path(binary)
    with tempfile.NamedTemporaryFile(
        "wb",
        dir=sidecar.parent,
        prefix=f".{sidecar.name}.",
        delete=False,
    ) as tmp:
        tmp.write(RUNTIME_HELPER.read_bytes())
        tmp_path = Path(tmp.name)
    tmp_path.chmod(0o644)
    tmp_path.replace(sidecar)


def main() -> None:
    binary, verify_only = parse_cli()
    if not binary.is_file():
        raise fail(f"binary not found: {binary}")
    data = binary.read_bytes()

    sec_off, sec_size, slack = find_sea_section(data)
    blob = data[sec_off : sec_off + sec_size + slack]
    if blob[:4] != MAGIC:
        raise fail("SEA magic not found at section start — layout drift?")
    flags = int.from_bytes(blob[4:8], "little")
    if flags & 0b110:  # kUseSnapshot / kUseCodeCache — layout would differ
        raise fail(f"unexpected SEA flags {flags:#x} (snapshot/code-cache present)")
    pos = 9
    path_len = int.from_bytes(blob[pos : pos + 8], "little")
    pos += 8 + path_len
    js_len = int.from_bytes(blob[pos : pos + 8], "little")
    js_start = pos + 8
    js_end = js_start + js_len
    js = blob[js_start:js_end].decode("utf-8")
    payload_end = find_sea_payload_end(blob, js_end)
    rest = blob[js_end:payload_end]  # u64 asset count + self-describing assets

    if verify_only:
        marker_count = verify_sm_patch_markers(js)
        verify_runtime_sidecar(binary, js)
        print(f"SM-PATCH verification OK: markerCount={marker_count}")
        return

    patched = apply_js_patch(js)
    if patched is js:
        marker_count = verify_sm_patch_markers(js)
        verify_runtime_sidecar(binary, js)
        print(f"already patched (turn-v2 + acp-skills-dir) — markerCount={marker_count}")
        return
    verify_runtime_helper()
    patched_bytes = patched.encode("utf-8")
    delta = len(patched_bytes) - js_len

    with tempfile.NamedTemporaryFile("wb", suffix=".cjs", delete=False) as tmp:
        tmp.write(patched_bytes)
        tmp_path = tmp.name
    check = subprocess.run(["node", "--check", tmp_path], capture_output=True)
    if check.returncode != 0:
        raise fail(f"patched JS failed node --check:\n{check.stderr.decode()[:2000]}")

    new_blob = blob[:pos] + len(patched_bytes).to_bytes(8, "little") + patched_bytes + rest
    if len(new_blob) > len(blob):
        raise fail(
            f"patch needs {len(new_blob) - len(blob)} bytes beyond the section slack — "
            "no room without Mach-O surgery (kimi-code version drift?)"
        )

    backup = Path(str(binary) + ".pre-sm-patch")
    if not backup.exists():
        backup.write_bytes(data)
        print(f"backup written: {backup}")

    out = bytearray(data)
    out[sec_off : sec_off + len(blob)] = new_blob + bytes(len(blob) - len(new_blob))
    tmp_out = binary.with_name(binary.name + ".sm-patch-tmp")
    tmp_out.write_bytes(bytes(out))
    tmp_out.chmod(0o755)
    subprocess.run(["codesign", "--sign", "-", "--force", str(tmp_out)], check=True)
    verify = subprocess.run([str(tmp_out), "--version"], capture_output=True)
    if verify.returncode != 0:
        tmp_out.unlink()
        raise fail(f"patched binary failed --version:\n{verify.stderr.decode()[:1000]}")
    stage_runtime_helper(binary)
    tmp_out.replace(binary)
    verify_runtime_sidecar(binary, patched)
    slack_used = max(0, len(new_blob) - sec_size)
    print(
        f"patched OK: {binary} (js delta {delta:+d} bytes, "
        f"slack used {slack_used}/{slack}, version {verify.stdout.decode().strip()})"
    )
    print("NOTE: long-lived kimi ACP processes keep the old code until respawned.")


if __name__ == "__main__":
    main()
