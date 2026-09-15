# Public Python Runtime Principle

Persistent Python entrypoints use Python 3.11.15 and declare compatibility as
`>=3.11,<3.12`. The caller supplies the absolute interpreter path through
`FP_PYTHON`; scripts do not guess from a private machine path or silently fall
back to an unversioned system interpreter.

Runtime state is separate from static package inputs. A new user may start
with an empty state directory and still generate identity documents. Runtime
databases, credentials, keychain entries, tokens and remote bindings must be
created or supplied by their owning setup process, never copied from another
machine.
