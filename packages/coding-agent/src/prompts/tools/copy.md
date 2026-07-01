Copy one regular file between local/internal paths and `ssh://` remote paths.

<instruction>
- `source` — required. Local path, writable internal file URI (`local://...`), or `ssh://host/<absolute-path>`.
- `destination` — required. Local path, writable internal file URI (`local://...`), or `ssh://host/<absolute-path>`.
- `timeout` — optional seconds for SSH transfer operations.
- Copies raw bytes; no UTF-8 decoding, line selectors, archive members, SQLite rows, or directory recursion.
- Use explicit `local://...` when copying between a remote eval host and the local session scratch space.
</instruction>

<critical>
- Regular files only. Directories and special files are rejected.
- `ssh://` paths require absolute remote paths.
- Large files are rejected before transfer; use `ssh` with `scp`/`rsync` for bulk copies.
</critical>
