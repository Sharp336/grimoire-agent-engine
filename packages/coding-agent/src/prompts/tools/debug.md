Debugger access.

<instruction>
- You SHOULD prefer this over bash for program state, breakpoints, stepping, thread inspection, or interrupting a running process.
- `action: "launch"` starts a session; `program` required, `adapter` optional. Bun: `adapter: "bun"`, target `.js`/`.ts`; Python: `adapter: "debugpy"`, target `.py`; JS/TS/Node/Vitest: `adapter: "js-debug-adapter"`, target Node entrypoint.
- `action: "attach"` connects to a running process: `pid` (local), `port` (remote), or `url`/`inspector_url` (Bun WebSocket); `adapter` forces a specific debugger.
- **Breakpoints**: `set_breakpoint`/`remove_breakpoint` with source (`file`+`line`) or function (`function`); optional `condition`.
- Fast targets/tests? Call `set_breakpoint` before `launch`/`attach`; pending breakpoints apply to your next session and child sessions, then clear on `terminate`.
- **Targeting**: tool calls use your active session by default; pass `session_id` from `launch`/`attach`/`sessions` to target a specific session.
- **Flow control**: `continue` (resume), `step_over`/`step_in`/`step_out` (single-step), `pause` (interrupt a running program).
- **Inspect**: `threads`, `stack_trace` (current stopped thread), `scopes` (needs `frame_id` or current stopped frame), `variables` (needs `variable_ref` or `scope_id`), `evaluate` (needs `expression`; `context: "repl"` for raw debugger commands), `output` (stdout/stderr/console), `sessions`, `terminate`.
</instruction>

<caution>
- Each agent has its own active debug session; use `session_id` when several are listed.
- Valid `adapter` values include `bun`, `gdb`, `lldb-dap`, `debugpy`, `dlv`, `js-debug-adapter` (external adapters must be installed/discoverable locally).
- `program` must be an executable file or debug target, not a directory or bare interpreter name.
- Python debugging requires `debugpy`; `pip install debugpy` if unavailable.
</caution>
