Outlines, finds, and edits code symbols by name via native tree-sitter (no language server).

<instruction>
- `action: "overview"` — outline the symbols (name, kind, line, nesting) in a file or small file scope. Use to map a file's structure before editing, or to confirm where a symbol lives
- `action: "find"` — locate symbols by `name` across a path scope (file, directory, or glob). Within a scope of up to 200 files `find` scans exhaustively and never misses a symbol `overview` would show; for larger scopes it uses a fast content prefilter that skips files over ~4MiB (rare — narrow the scope, or run `overview` on the specific file)
- `action: "manipulate"` — replace, delete, or insert relative to a named symbol (`op`: `replace`/`delete`/`insert_before`/`insert_after`; `text` is the payload for `replace`/`insert_before`/`insert_after`). It previews the edit as a diff and stages it; call `resolve` to apply or discard (like `ast_edit`). `replace`'s `text` overwrites the whole construct, including any attached decorators/attributes, and must carry correct indentation
- Symbols are **name-addressed**: pass `name` for `find`/`manipulate`. `path` scopes the search; for `manipulate` it is the single target file
- For `manipulate`, when a `name` is non-unique in the target file, narrow to exactly one symbol with whichever of `kind` (the raw domain kind string the outline emits, e.g. `function`/`method`/`class`/`trait`/`struct`), `container` (enclosing type name — a Rust `impl`/`trait` or a Go receiver type), or `line` (the symbol's `selectionLine`) uniquely identifies it. Run `find` (or `overview`) first to read the candidates, then `manipulate` with the disambiguator for the one you want
- `symbol` is a LIGHTER alternative to `ast_grep`/`ast_edit` (no AST patterns — address by name, not by structural template) and to `lsp` (no running language server). Reach for it for quick "where is X / what's in this file" work; reach for `ast_grep` when syntax shape matters and `lsp` when you need cross-file references or rename refactors
</instruction>

<output>
- `overview`: per file, a header `<relpath> — <count> symbol(s)` then pre-order lines `<indent><kind> <name>[ <detail>] @ line <selectionLine>` (indent = nesting depth). Unsupported language or parse error → `<relpath> — no symbols (unsupported language or parse error)`
- `find`: flat lines `<kind> <name>[ (<container>)] @ <relpath>:<selectionLine>`, prefixed by `Found <n> symbol(s) matching "<name>":`. Paginate with `skip`/`limit`; a `… <m> more; pass skip=<skip+limit>` line marks truncation
- `manipulate`: a diff preview of the staged edit. `resolve` applies it (returning a fresh `[<relpath>#<tag>]`) or discards it; the edit routes through the same pipeline as `edit` (plan-mode read-only, stale-tag validation, LSP write-through)
</output>

<critical>
- `find` matches the symbol `name` only — exact matches when any exist, otherwise case-insensitive substring — and lists every match; it does not filter by `kind`/`container`/`line` (those are `manipulate` disambiguators)
- A scope too large to outline safely (>50 files for `overview`, >200 candidate files for `find`) errors rather than silently truncating — narrow the path/glob or use a more specific name
</critical>
