# Public Coding Principle

Keep code changes minimal and local. Before editing, inspect the existing
mechanism and write a reproducible test or smallest failing example. Reuse
the underlying owner mechanism; a second watcher or fallback layer is not a
repair for an unreliable lower layer.

For asynchronous work, completion requires the final artifact, read-back, or
verifiable receipt. Process liveness, exit code zero, HTTP success, queued and
accepted are intermediate evidence only. Stop and report when final evidence
is unavailable.

Public artifacts must exclude credentials, personal data, tenant identifiers,
remote resource identifiers, and machine-private absolute paths. Record the
actual interpreter path, version, command, exit code, tests and hashes used to
support a claim.
