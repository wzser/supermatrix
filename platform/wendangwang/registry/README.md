# User-owned asset contracts

The package ships no private registry. The safe stub contract lives under
`tests/fixtures/` and is test-only. Put each real contract in this directory
in the receiving agent's namespace; the top-level JSON files are ignored by
Git.

A real contract must contain the IDs and canonical URL read back from the
user-owned table, the exact owner and asset identity, the approved field map,
and the unique-key policy. Validate it before enqueueing. The queue loads only
the explicit `--registry-glob` supplied by the agent; the default registry
scan also skips `examples/`.

Use the public catalog for the field contract and owner/authority boundary.
Do not copy IDs, URLs, rows, or credentials from another namespace.
