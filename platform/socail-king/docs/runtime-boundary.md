# Runtime boundary

The receiving agent uses existing host mechanisms:

- Spawn2.0 v2 for cross-agent requests and terminal result retrieval;
- the host's queue/heartbeat path for asynchronous continuation;
- the host watcher for J-class exception admission;
- the host's idempotent table-sync command for judgment rows.

This package adds no cron entry, daemon, queue, watcher, retry channel, messaging
writer, or database schema migration. A missing host capability is an external
input problem: record it as pending and ask the owning host component to supply
the existing command or receipt contract. Do not solve it by adding a second
mechanism here.

The local verifier deliberately uses a stub Spawn2 client and temporary files.
It must remain network-free and must not be used as evidence that a host
deployment or real table write succeeded.
