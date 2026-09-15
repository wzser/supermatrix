# Public export allowlist

The selectable export root is:

```text
exports/feishu-bitable-control-plane
```

Include exactly these paths from that root:

```text
.gitignore
.python-version
README.md
pyproject.toml
bin/feishu-sync-consumer
bin/feishu-sync-enqueue
bin/feishu-sync-status
bin/sm-feishu
config/public-table-contracts.json
docs/PUBLIC-EXPORT.md
docs/SETUP.md
registry/README.md
src/wendangwang_feishu/*.py
tests/fixtures/lark-cli
tests/fixtures/public-demo.asset.json
tests/test_public_contracts.py
tests/test_public_e2e.py
```

Exclude all other paths, especially `.venv/`, `__pycache__/`, `data/`, local
`registry/assets/*.json`, receipts, locks, generated plans, and any user-owned
contract or row data. This export does not include a maintainer registry,
runtime database, credentials, or absolute private paths.

The public catalog is a static contract review, not a schema mechanism. It
keeps local and remote keys explicit (`session_name` -> `Session`, `module` ->
`模块名`, and patrol `scope` -> `配置项`) and records required versus
conditional fields plus the owner consumers. `queue_consumer: true` means
queue eligibility only; it never changes an owner implementation that uses a
native Lark CLI path. The catalog deliberately remains partial until
user-owned IDs, permissions, schema readback, and exact owner approval are
available. It does not claim a complete platform-table contract set or accept
empty table names as a substitute.

`consumer_refs` entries are provenance objects. `sourceRef` may retain the
owner repository path, but every such reference is marked
`availability: owner-source-only`; it is not an executable package input.
Portable runtime commands are only the package-relative paths listed by
`runtime_entrypoints`, including `bin/sm-feishu`. The catalog's `queue_consumer` flag remains an
eligibility boundary and never rewrites an owner's native runtime transport.
Seed rows are installer-provided, shaped by the same catalog fields and
`unique_key` values, and must be read back before acceptance.
