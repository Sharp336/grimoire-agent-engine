# symbol

> Name-addressed code overview, find, and edit via native tree-sitter — a lighter alternative to `ast_grep`/`ast_edit` (no AST patterns) and `lsp` (no running language server).

## Source
- Entry: `packages/coding-agent/src/tools/symbol.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/symbol.md`
- Key collaborators:
  - `crates/pi-ast/src/symbols.rs` — native tree-sitter symbol extractor (`outline_code`)
  - `crates/pi-natives/src/symbols.rs` — NAPI wrapper exposing `outlineCode`, `outlineLanguages`, `isOutlineSupportedPath`, and `isOutlineSupportedLang` (the latter three keep the TS scan glob, per-file gate, and explicit-`lang`-override validation native-derived so they never drift from the extractor)
  - `packages/coding-agent/src/tools/path-utils.ts` — `resolveToolSearchScope` scope resolution
  - `packages/coding-agent/src/edit/hashline/diff.ts` / `execute.ts` — `manipulate` preview (`computeHashlineDiff`) and apply (`executeHashlineSingle`)
  - `packages/coding-agent/src/tools/resolve.ts` — `queueResolveHandler` stages the `manipulate` apply
  - `packages/coding-agent/src/lsp/utils.ts` — `symbolKindToIcon` for the TUI renderer

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"overview" \| "find" \| "manipulate"` | Yes | Operation to perform. |
| `path` | `string \| string[]` | No | File, directory, glob, or internal URL scope. Defaults to `.` for `overview`/`find`; required as the single target file for name-addressed `manipulate`. Rejected when `selector` is present (selector mode decodes its own source address). |
| `name` | `string` | For `find`/name-mode `manipulate` | Symbol identifier to locate or edit. Not required when `manipulate` uses a `selector`. |
| `selector` | `string` | Alternative for `manipulate` | Opaque selector from `find`/`overview` output (`sym:v1:<encoded>`). Decoded before scope resolution — embeds source address, language, and structural identity. Rejected together with `name`/`path`; the only way to omit `path` from `manipulate`. |
| `op` | `"replace" \| "delete" \| "insert_before" \| "insert_after"` | For `manipulate` | Edit operation relative to the resolved symbol. |
| `text` | `string` | For `manipulate` `replace`/`insert_*` | Verbatim payload; the model owns its indentation. Rejected for `delete`. |
| `kind` | `string` | No | Filter for `find` (narrows candidates after outlining) and disambiguator for name-addressed `manipulate` — the raw domain kind string (e.g. `function`, `method`, `class`, `trait`, `struct`). |
| `container` | `string` | No | Filter for `find` (narrows candidates after outlining) and disambiguator for name-addressed `manipulate` — enclosing type name (a Rust `impl`/`trait`, a Go receiver type). |
| `line` | `number` | No | Name-mode `manipulate` disambiguator — the symbol's `selectionLine`. Never a selection predicate for selector mode. |
| `lang` | `string` | No | Explicit language override forwarded to the extractor. |
| `skip` | `number` | No | `find` pagination offset (default `0`). |
| `limit` | `number` | No | `find` page size (default `100`, clamped to `≥ 1`). |

Supported languages: the native extractor (`pi-ast`) emits symbols for 44 languages — every language omp's tree-sitter layer parses that has named code definitions. **Programming languages:** TypeScript, TSX, JavaScript, Python, Rust, Go, Java, C#, Kotlin, C, C++, Objective-C, Scala, Swift, Dart, PHP, Ruby, Lua, Perl, Odin, Bash, Solidity, Starlark, R, Julia, Zig, Haskell, OCaml, Elixir, Erlang, Clojure, Emacs Lisp, PowerShell. **DSL / HDL / schema:** GraphQL, Protobuf, SQL, Verilog/SystemVerilog, HCL, Nix, TLA+. **Build / task files:** Dockerfile (stages), CMake (function/macro), Make (targets + variables), Just (recipes). Excluded — the data, markup, and component-wrapper formats with no addressable code symbols: JSON, YAML, TOML, INI, CSS, HTML, XML, Markdown, Diff, Regex, Astro, Svelte, Vue (the component formats embed scripts the grammar does not expose as a code AST). A Rust exhaustiveness test pins every grammar into exactly one of supported/excluded. The base languages plus the contextual grammars use bespoke emitters; the rest are table-driven. The supported set, its file extensions, and its fixed-name files (`Dockerfile`, `Makefile`, `CMakeLists.txt`, `justfile`, ...) are derived from the native `outlineLanguages()` (single source of truth — the Rust extractor and the TS scan filter never drift); per-file gating uses the native `isOutlineSupportedPath`, so extensionless name-based files resolve too (shell rc dotfiles resolve for an explicit target but are not surfaced by a directory walk). Table-driven languages may report a coarser `kind` where one grammar node covers several concepts (e.g. a Kotlin `interface`/`enum class` reports as `class`); the symbol name is always correct. The extractor emits these domain `kind` strings: `function`, `method`, `constructor`, `class`, `interface`, `trait`, `struct`, `union`, `enum`, `enum_member`, `property`, `field`, `constant`, `variable`, `type_alias`, `namespace`, `module`, `macro`. The TS layer maps each to an LSP `SymbolKind` for the TUI icon; the model-facing text uses the raw domain kind string.

## Outputs
- `overview`: per file, a header `<relpath> — <count> symbol(s)` then pre-order lines `<indent><kind> <name>[ <detail>] @ line <selectionLine>[ selector=<value>]` (indent = nesting depth). Each uniquely addressable symbol appends `selector=sym:v1:<encoded>` (copyable into `manipulate`); byte-identical structural duplicates append `selector=ambiguous` instead, signaling the model to fall back to name-addressing with `line`. Symbols inside an internal-URL-backed directory scope whose provenance cannot be preserved append `selector=internal` — like `ambiguous`, this is not selector-addressable; fall back to name-addressing with `path` and `line`. A file with no symbols (empty file or parse error) renders `<relpath> — no symbols (empty file or parse error)`. Directory scopes are grouped by file.
- `find`: flat lines `<kind> <name>[ (<container>)] @ <relpath>:<selectionLine>[ selector=<value>]`, prefixed by `Found <n> symbol(s) matching "<name>":`. Exact name matches are preferred; case-insensitive substring is the fallback only when no symbol matches exactly. Optional `kind` and `container` parameters filter the candidate set after outlining, narrowing results before exact-vs-substring selection. Paginated with `skip`/`limit`; truncation appends `… <m> more; pass skip=<skip+limit>`. No match → `No symbols found.`.
- `manipulate`: a diff preview of the staged edit, with a pending `resolve`. Applying via `resolve` rewrites exactly the resolved symbol's range and returns a fresh `[<relpath>#<tag>]`; discarding leaves the file untouched.
- `details`: `{ action, scopePath, symbolCount, fileCount, displayContent, cwd }`.

## Flow
1. Validation rejects selector-mode calls with explicit `path`, or with both `selector` and `name`, before any file read or scope resolution. In selector mode, `SymbolTool.execute()` decodes the selector first and uses its embedded source address as the raw path; otherwise it normalizes `path` to `string[]`, resolves scope via `resolveToolSearchScope` (`surfaceExactFilePaths`, `fanOutFileTargets`), then dispatches on `action`.
2. `overview`: enumerate supported files via native `glob` (the supported-extension brace pattern when unconstrained), cap at 50 files, `outlineCode` each, render. Each uniquely addressable symbol is emitted with a `selector=sym:v1:<encoded>` suffix; byte-identical duplicates get `selector=ambiguous`; symbols whose provenance cannot be preserved (descendants of an internal-URL-backed directory scope) get `selector=internal`.
3. `find`: enumerate the resolved scope; within the parse cap (200 files) prefilter candidates with `hasMatch` (reads any size, no grep size cap, so it never misses a symbol `overview` would show); fall back to native `grep` for larger scopes. Outline candidates, apply optional `kind`/`container` filters after outlining, then keep name matches (exact preferred, substring fallback).
4. `manipulate` (selector mode): decode the opaque `sym:v1:<encoded>` selector before path normalization and scope resolution, extracting the embedded source address, language, name, kind, container, and range-text fingerprint. Resolve the single target file from the decoded source address, outline it, and match exactly one current symbol whose structural fields plus SHA-256 fingerprint equal the selector's. Reject if zero or more than one match (stale or ambiguous); ordinal and selection-line fields in the selector are diagnostics only, never selection predicates.
5. `manipulate` (name mode): read the file, `outlineCode`, resolve exactly one symbol by `name` (+ `kind`/`container`/`line`), mint a snapshot tag, build a one-op hashline `input` from the exact `[start, end]` range, preview with `computeHashlineDiff`, and stage the apply with `queueResolveHandler`. At apply time it re-reads, re-resolves the symbol by spec, requires the same range, mints a fresh tag, and calls `executeHashlineSingle`.

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
**Validation-time** (reject before file reads or scope resolution):
- Missing `name` for `find` or name-mode `manipulate`.
- `manipulate` missing `op`, or missing `text` for `replace`/`insert_*`.
- Both `selector` and `name` provided to `manipulate`.
- `selector` provided together with explicit `path`.
- Malformed selector syntax.
- Name-mode `manipulate` missing `path`, or given an empty path array / multi-entry path array.

**Execute-time** (require file reads, scope resolution, or symbol existence):
- `manipulate` scope that resolves to a directory, glob, multiple targets, or a delimited path with missing entries.
- Unsupported file language for `manipulate`.
- Symbol resolves to 0 matches (`No symbol named '<name>'…`) or >1 (lists candidates with kinds, containers, and lines).
- Scope exceeds the file caps (>50 for `overview`, >200 candidate files for `find`).
- Selector resolves to zero or more than one current symbol (stale or ambiguous); the model falls back to name-addressing.

**At `manipulate` apply:**
- A stale result if the symbol no longer uniquely resolves or its range moved since the preview (the model re-previews); in plan mode the apply throws the working-tree read-only error.

## Notes
- The `manipulate` symbol spec (name + disambiguators) is authoritative, not a frozen line range: re-resolving at apply prevents the hashline textual recovery from relocating a stale edit onto the wrong code after unrelated edits land between preview and apply.
- Selector identity invariant: structural fields (name, kind, container, source address, language) plus a SHA-256 range-text fingerprint choose the target; ordinal and selection-line fields are diagnostics only, never selection predicates. Selectors are emitted only for symbols whose structural fields plus fingerprint are unique in the current file; byte-identical duplicates receive an `ambiguous` marker instead. Symbols inside an internal-URL-backed directory scope whose provenance cannot be preserved receive an `internal` marker — neither `ambiguous` nor `internal` is selector-addressable; use name-addressing with `path` and `line` for those.
- `symbol.enabled` (default `false`) gates the tool — it is **opt-in**. Enable it in `/settings` (Tools → Available Tools) or with `omp config set symbol.enabled true`. Like every built-in tool toggle, the change is applied when a session builds its tool registry, so start a new session for it to take effect. `loadMode` is `discoverable`, so once enabled it surfaces via tool discovery rather than being force-loaded.
