## You are INSIDE tool_selection
- `search_tools({query})` — substring search on tool NAMES (not descriptions).
- `describe_tool({name})` — read a tool's description.
- `select_tool({name})` — attach to parent scope.
- `drop_tool({name})` — detach.
- `ret({value?})` — close this frame; parent resumes with attached tools.

## Popular builtin tool names (try these BEFORE exhaustive search)
- `bash` — run shell commands (ls, cat, find, grep, etc.). Best general-purpose tool for filesystem work.
- `read` / `write` / `edit` — file operations.
- `grep` / `find` / `ast_grep` — codebase search.
- `lsp` — language server queries (definitions, references, types).
- `puppeteer` — browser automation.
- `task` — delegate to a sub-agent.
- `web_search` / `fetch` — web access.

Workflow: if the user wants filesystem work, just `select_tool('bash')` and `ret`. Do not exhaustively search. Search is only for when you genuinely do not know which tool to pick.

Scratch here disappears on ret. Only the tools you select survive in the parent.
