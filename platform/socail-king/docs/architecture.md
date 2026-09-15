# Minimal public architecture

```text
communication radar
        |
        v
  interview A + B -- Spawn2.0 message/inline --> terminal A and B
        |
        v
  judgment contract --> append-only local journal --> table projection

host async item --> host watcher --> one frozen exception snapshot
                                      |
                                      v
                         open -> intent -> closed ledger
                                      |
                                      v
                         host-owned verdict writeback
```

The first path is the live interview/judgment workflow. The second path is the
live exception transaction workflow. They share only the principle that a
transport or process state is not business completion.

The queue, heartbeat, scheduler, and exception watcher are host-owned
components. This input package does not reimplement them. It supplies their
stable input/output contracts and a local stub probe only.
