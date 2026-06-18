# symbol

> Name-addressed code overview, find, and edit via native tree-sitter — a lighter alternative to `ast_grep`/`ast_edit` (no AST patterns) and `lsp` (no running language server).

## Source
- Entry: `packages/coding-agent/src/tools/symbol.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/symbol.md`
- Key collaborators:
  - `crates/pi-ast/src/symbols.rs` — native tree-sitter symbol extractor (`outline_code`)
  - `crates/pi-natives/src/symbols.rs` — NAPI wrapper exposing `outlineCode`
  - `packages/coding-agent/src/tools/path-utils.ts` — `resolveToolSearchScope` scope resolution
  - `packages/coding-agent/src/edit/hashline/diff.ts` / `execute.ts` — `manipulate` preview (`computeHashlineDiff`) and apply (`executeHashlineSingle`)
  - `packages/coding-agent/src/tools/resolve.ts` — `queueResolveHandler` stages the `manipulate` apply
  - `packages/coding-agent/src/lsp/utils.ts` — `symbolKindToIcon` for the TUI renderer

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"overview" \| "find" \| "manipulate"` | Yes | Operation to perform. |
| `path` | `string \| string[]` | No | File, directory, glob, or internal URL scope. Defaults to `.` for `overview`/`find`; a single target file for `manipulate`. |
| `name` | `string` | For `find`/`manipulate` | Symbol identifier to locate or edit. |
| `op` | `"replace" \| "delete" \| "insert_before" \| "insert_after"` | For `manipulate` | Edit operation relative to the resolved symbol. |
| `text` | `string` | For `manipulate` `replace`/`insert_*` | Verbatim payload; the model owns its indentation. Ignored for `delete`. |
| `kind` | `string` | No | `manipulate` disambiguator — the raw domain kind string the outline emits (e.g. `function`, `method`, `class`, `trait`, `struct`). |
| `container` | `string` | No | `manipulate` disambiguator — enclosing type name (a Rust `impl`/`trait`, a Go receiver type). |
| `line` | `number` | No | `manipulate` disambiguator — the symbol's `selectionLine`. |
| `lang` | `string` | No | Explicit language override forwarded to the extractor. |
| `skip` | `number` | No | `find` pagination offset (default `0`). |
| `limit` | `number` | No | `find` page size (default `100`, clamped to `≥ 1`). |

Supported languages: the native extractor (`pi-ast`) emits symbols for 44 languages — every language omp's tree-sitter layer parses that has named code definitions. **Programming languages:** TypeScript, TSX, JavaScript, Python, Rust, Go, Java, C#, Kotlin, C, C++, Objective-C, Scala, Swift, Dart, PHP, Ruby, Lua, Perl, Odin, Bash, Solidity, Starlark, R, Julia, Zig, Haskell, OCaml, Elixir, Erlang, Clojure, Emacs Lisp, PowerShell. **DSL / HDL / schema:** GraphQL, Protobuf, SQL, Verilog/SystemVerilog, HCL, Nix, TLA+. **Build / task files:** Dockerfile (stages), CMake (function/macro), Make (targets + variables), Just (recipes). Excluded — the data, markup, and component-wrapper formats with no addressable code symbols: JSON, YAML, TOML, INI, CSS, HTML, XML, Markdown, Diff, Regex, Astro, Svelte, Vue (the component formats embed scripts the grammar does not expose as a code AST). A Rust exhaustiveness test pins every grammar into exactly one of supported/excluded. The base languages plus the contextual grammars use bespoke emitters; the rest are table-driven. The supported set, its file extensions, and its fixed-name files (`Dockerfile`, `Makefile`, `CMakeLists.txt`, `justfile`, ...) are derived from the native `outlineLanguages()` (single source of truth — the Rust extractor and the TS scan filter never drift); per-file gating uses the native `isOutlineSupportedPath`, so extensionless name-based files resolve too (shell rc dotfiles resolve for an explicit target but are not surfaced by a directory walk). Table-driven languages may report a coarser `kind` where one grammar node covers several concepts (e.g. a Kotlin `interface`/`enum class` reports as `class`); the symbol name is always correct. The extractor emits these domain `kind` strings: `function`, `method`, `constructor`, `class`, `interface`, `trait`, `struct`, `union`, `enum`, `enum_member`, `property`, `field`, `constant`, `variable`, `type_alias`, `namespace`, `module`, `macro`. The TS layer maps each to an LSP `SymbolKind` for the TUI icon; the model-facing text uses the raw domain kind string.

## Outputs
- `overview`: per file, a header `<relpath> — <count> symbol(s)` then pre-order lines `<indent><kind> <name>[ <detail>] @ line <selectionLine>` (indent = nesting depth). A file with no symbols (unsupported language or parse error) renders `<relpath> — no symbols (unsupported language or parse error)`. Directory scopes are grouped by file.
- `find`: flat lines `<kind> <name>[ (<container>)] @ <relpath>:<selectionLine>`, prefixed by `Found <n> symbol(s) matching "<name>":`. Exact name matches are preferred; case-insensitive substring is the fallback only when no symbol matches exactly. Paginated with `skip`/`limit`; truncation appends `… <m> more; pass skip=<skip+limit>`. No match → `No symbols found.`.
- `manipulate`: a diff preview of the staged edit, with a pending `resolve`. Applying via `resolve` rewrites exactly the resolved symbol's range and returns a fresh `[<relpath>#<tag>]`; discarding leaves the file untouched.
- `details`: `{ action, scopePath, symbolCount, fileCount, displayContent, cwd }`.

## Flow
1. `SymbolTool.execute()` normalizes `path` to `string[]`, resolves the scope via `resolveToolSearchScope` (`surfaceExactFilePaths`, `fanOutFileTargets`), then dispatches on `action`.
2. `overview`: enumerate supported files via native `glob` (the supported-extension brace pattern when unconstrained), cap at 50 files, `outlineCode` each, render.
3. `find`: enumerate the resolved scope; within the parse cap (200 files) prefilter candidates with `hasMatch` (reads any size, no grep size cap, so it never misses a symbol `overview` would show); fall back to native `grep` for larger scopes. Outline candidates, keep name matches.
4. `manipulate`: read the file, `outlineCode`, resolve exactly one symbol by `name` (+ `kind`/`container`/`line`), mint a snapshot tag, build a one-op hashline `input` from the exact `[start, end]` range, preview with `computeHashlineDiff`, and stage the apply with `queueResolveHandler`. At apply time it re-reads, re-resolves the symbol by spec, requires the same range, mints a fresh tag, and calls `executeHashlineSingle`.

## Modes / Variants
- Single file vs directory vs multi-target / explicit-file scopes are all handled by `resolveToolSearchScope`; `manipulate` requires a single target file.
- Edit-mode display (`hashline` vs line-number) is inherited from the shared edit pipeline for `manipulate` output.

## Side Effects
- `overview`/`find`: read-only (file reads only).
- `manipulate`: no write at preview; the file is written only when `resolve` applies, through the same pipeline as `edit` (plan-mode read-only guard, fs-cache invalidation, LSP write-through and deferred diagnostics).

## Limits & Caps
- `overview`: `OVERVIEW_FILE_CAP = 50` files; a larger scope errors instead of truncating.
- `find`: `FIND_PARSE_CAP = 200` candidate files; a larger candidate set errors. The large-scope grep prefilter skips files over the native grep size cap (~4 MiB); point `find`/`overview` at the specific file to inspect those.
- `manipulate`: single file, single symbol per call.

## Errors
- `ToolError` for: a `find`/`manipulate` call missing `name`; a `manipulate` missing `op` or (for `replace`/`insert_*`) `text`; a `manipulate` scope that is not a single file or an unsupported language; a symbol that resolves to 0 matches (`No symbol named '<name>'…`) or >1 (lists candidates with their kinds, containers, and lines); a scope that exceeds the file caps.
- At `manipulate` apply: a stale result if the symbol no longer uniquely resolves or its range moved since the preview (the model re-previews); in plan mode the apply throws the working-tree read-only error.

## Notes
- The `manipulate` symbol spec (name + disambiguators) is authoritative, not a frozen line range: re-resolving at apply prevents the hashline textual recovery from relocating a stale edit onto the wrong code after unrelated edits land between preview and apply.
- `symbol.enabled` (default `false`) gates the tool — it is **opt-in**. Enable it in `/settings` (Tools → Available Tools) or with `omp config set symbol.enabled true`. Like every built-in tool toggle, the change is applied when a session builds its tool registry, so start a new session for it to take effect. `loadMode` is `discoverable`, so once enabled it surfaces via tool discovery rather than being force-loaded.
