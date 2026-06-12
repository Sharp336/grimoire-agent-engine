# omp-permissions

Fine-grained, **predicate-based** permission control for tool calls in the
[Oh My Pi (omp)](omp://) coding agent.

omp natively gates tools by *name* (`tools.approval.<tool>: allow|deny|prompt`).
This extension adds *argument-level* rules using the
[opencode permission model](https://opencode.ai/docs/permissions/)
(`permission.<category>` glob → action) plus the
[`liberzon/claude-hooks`](https://github.com/liberzon/claude-hooks) technique of
**decomposing compound bash commands** so a rule like `"rm *": "deny"` cannot be
smuggled past via `git status && rm -rf /`. Rules apply to omp built-ins **and
`serena` MCP tools**.

One `tool_call` interceptor:

1. **Self-protection** — every attempt to modify its own config file (and any
   configured `protect.paths`) is intercepted, independent of the enable flag and
   permission rules. The applied action is configurable (`ask` default, or
   `deny`); the config file itself can never be made writable.
2. **Permission rules** — when enabled, evaluates each call against the config.
3. **Logging** — when `log` is on, every tool call is appended to a JSONL audit
   log with time, identity, and the applied decision.

## Install

Entry point is `index.ts`, auto-discovered under an omp extensions dir:

```
~/.omp/agent/extensions/omp-permissions/index.ts   # user-level (every omp on PATH)
<repo>/.omp/extensions/omp-permissions/index.ts    # project-level
```

Or load explicitly: `omp -e ~/path/to/omp-permissions`.

## Configuration

Strict JSON, discovered and **merged** (later wins; last-match-wins within a
category):

1. user — `${PI_CODING_AGENT_DIR:-~/.omp/agent}/omp-permissions.json`
2. project — `<cwd>/.omp/omp-permissions.json`
3. override — `$OMP_PERMISSIONS_CONFIG`

```json
{
  "enabled": true,
  "log": { "enabled": true, "path": "~/.omp/agent/omp-permissions.log" },
  "permission": {
    "bash": { "*": "allow", "rm -rf /": "deny", "git push *": "ask" },
    "edit": { "*": "allow" },
    "read": { "*": "allow", "*.env": "deny" },
    "external_directory": { "~/projects/**": "allow", "*": "ask" },
    "doom_loop": "ask"
  },
  "protect": {
    "enabled": true,
    "action": "ask",
    "paths": ["**/.env", "~/.ssh/**", "**/secrets/**"]
  }
}
```

- **`enabled`** — defaults `true`. `false` disables rule enforcement (self-protection
  still applies).
- **Actions** — `"allow"` (defer to omp's approval), `"ask"` (confirm; **fail closed
  / blocked** when headless or in a subagent with no UI), `"deny"` (block).
- **Wildcards** — `*` (0+ chars incl `/`), `?` (one char); `~`/`$HOME` expand. A rule
  ending in `" *"` (e.g. `"git *"`) also matches the bare command.
- Category value = object (glob→action) **or** bare action string. Top-level `"*"`
  (or `"permission": "allow"`) is a **global default**. No matching rule → pass-through.

### Permission categories → tools

| Category | Matches | omp | serena |
| --- | --- | --- | --- |
| `bash` | each sub-command | `bash` | `execute_shell_command` |
| `edit` | target path(s) | `edit`, `write`, `ast_edit`, `notebook` | `create_text_file`, `replace_content`, `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `rename_symbol`, `safe_delete_symbol` |
| `read` | file path | `read` | `read_file`, `find_symbol`, `get_symbols_overview`, `find_referencing_symbols`, `find_implementations`, `find_declaration`, `get_diagnostics_for_file` |
| `glob` | glob pattern | `find` | `find_file` |
| `grep` | search pattern | `search` | `search_for_pattern` |
| `task` | subagent type | `task` | — |
| `lsp` | lsp action | `lsp` | — |
| `question` | (non-granular) | `ask` | — |
| `webfetch` | URL | `read` of an `http(s)://…` path | — |
| `websearch` | query | `web_search` | — |
| `external_directory` | abs path outside cwd | any `read`/`edit`/`glob` path | (same) |
| `doom_loop` | 3rd identical repeat | all | (all) |

bash/serena-shell commands are decomposed (`&&`, `||`, `;`, `|`, `$()`, backticks,
newlines; heredocs/env-prefixes/redirections stripped); across pieces the **most
restrictive** outcome wins (`deny > ask > allow > pass-through`). A URL `read` is
evaluated as `webfetch`.

## Self-protection (configurable)

| Field | Meaning |
| --- | --- |
| (always) | the config file — its discovery paths + basename `omp-permissions.json`; cannot be disabled |
| `protect.enabled` | toggles the extra `protect.paths` (default true; config file stays protected either way) |
| `protect.action` | `"ask"` (default) or `"deny"` — applied to **all** protected actions |
| `protect.paths` | extra glob patterns (e.g. `**/.env`, `~/.ssh/**`) |

Coverage: edit-family tools are intercepted on a path match; `bash`/serena-shell on
a reference (in `command`/`cwd`/`env`) to a protected file — including read-only
references (use the `read` tool to inspect protected files). With the default
`ask`, an interactive human can approve a protected action while an autonomous /
headless agent is blocked (no UI to confirm → fail closed).

## Logging

Set `log: true` (or `{ "enabled": true, "path": "…" }`) to append one JSONL line per
tool call. Default path: `${PI_CODING_AGENT_DIR:-~/.omp/agent}/omp-permissions.log`.

```json
{"ts":"2026-06-12T16:54:13.120Z","pid":67211,"session":"019ebcc1-5f07-7000-9b06-8066a8cbfb05","sessionName":null,"cwd":"/work","tool":"bash","category":"bash","permission":"allowed","blocked":false,"reason":"…"}
```

Fields: `ts` (ISO), `pid`, `session` (omp session id when available), `sessionName`,
`cwd`, `tool`, `category`, `permission` (`allowed` | `blocked` | `asked`), `blocked`,
`confirmed` (for `asked`), `reason`. Every tool call is logged — including
pass-throughs and when rule enforcement is disabled.

## Caveats

- Unknown/other MCP tools are pass-through; extend `TOOL_TABLE` to cover more.
- Path comparison uses resolved absolute paths, basenames, and globs; symlinks are
  not followed. `protect.paths` globs are not substring-matched inside shell
  strings (only non-glob entries are); the config file is matched both ways.
- Strict JSON (no comments).

## Development & verification

```sh
bun test     # 34 unit + end-to-end (fake pi) tests
```

Verified against a real `omp -p --mode json` instance (auto-discovered extension):

- a `deny` rule blocks a decomposed bash sub-command; the file is never created;
- self-protection (default `ask`) blocks a config write/bash-reference when headless
  (fail closed), and the config stays byte-unchanged;
- an allowed command still runs;
- with `log` enabled, the JSONL audit log records `allowed` / `blocked` entries with
  timestamp, pid, and the omp session id.

## Credits

- Compound-command decomposition: [`liberzon/claude-hooks`](https://github.com/liberzon/claude-hooks).
- Permission model + wildcards: [opencode](https://opencode.ai/docs/permissions/).
