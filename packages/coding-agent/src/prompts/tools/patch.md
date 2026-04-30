Patches files given diff hunks. Primary tool for existing-file edits.

<instruction>
**Hunk Headers:**
- `@@` — bare header when context lines unique
- `@@ $ANCHOR` — anchor copied verbatim from file (full line or unique substring)
**Anchor Selection:**
1. Otherwise choose highly specific anchor copied from file:
   - full function signature
   - class declaration
   - unique string literal/error message
   - config key with uncommon name
2. On "Found multiple matches": add context lines, use multiple hunks with separate anchors, or use longer anchor substring
**Context Lines:**
Use enough ` `-prefixed lines to make match unique (usually 2–8)
When editing structured blocks (nested braces, tags, indented regions), include opening and closing lines so edit stays inside block
</instruction>

<parameters>
```ts
// Input is { path: string, edits: Entry[] }. `path` is required and applies to every entry.
type Entry =
   // Diff is one or more hunks for the top-level path.
   // - Each hunk begins with "@@" (anchor optional).
   // - Each hunk body only has lines starting with ' ' | '+' | '-'.
   // - Each hunk includes at least one change (+ or -).
   | { op: "update", diff: string }
   // Diff is full file content, no prefixes.
   | { op: "create", diff: string }
   // No diff for delete.
   | { op: "delete" }
   // New path for update+move from the top-level path.
   | { op: "update", rename: string, diff: string }
```
</parameters>

<output>
Returns success/failure; on failure, error message indicates:
- "Found multiple matches" — anchor/context not unique enough
- "No match found" — context lines don't exist in file (wrong content or stale read)
- Syntax errors in diff format
</output>

<critical>
- You **MUST** read the target file before editing
- You **MUST** copy anchors and context lines verbatim (including whitespace)
- You **MUST NOT** use anchors as comments (no line numbers, location labels, placeholders like `@@ @@`)
- You **MUST NOT** place new lines outside the intended block
- If edit fails or breaks structure, you **MUST** re-read the file and produce a new patch from current content — you **MUST NOT** retry the same diff
- **NEVER** use edit to fix indentation, whitespace, or reformat code. Formatting is a single command run once at the end (`bun fmt`, `cargo fmt`, `prettier —write`, etc.)—not N individual edits. If you see inconsistent indentation after an edit, leave it; the formatter will fix all of it in one pass.
</critical>

<unicode-content>
Your tool-call JSON is parsed before this tool sees `diff`, so `\uXXXX` decodes natively in `+` lines, ` ` context, and `op:create` payloads.
- To match or add the **character** → (U+2192): emit `"\u2192"` (one backslash) in the JSON, or the literal → character.
- To match or add the **literal 6-char escape sequence** `\u2192` (source code that already contains `\u2192` — JS regex `/\u2192/`, Python `r"\u2192"`, JSON fixtures): emit `"\\u2192"` (two backslashes) in the JSON. The 6 chars arrive verbatim.
- **NEVER** emit `"\\u2192"` when you intend the character →. That is a literal escape, not a Unicode character.
</unicode-content>

<examples>
# Create
`edit {"path":"hello.txt","edits":[{"op":"create","diff":"Hello\n"}]}`
# Update
`edit {"path":"src/app.py","edits":[{"op":"update","diff":"@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n"}]}`
# Rename
`edit {"path":"src/app.py","edits":[{"op":"update","rename":"src/main.py","diff":"@@\n …\n"}]}`
# Delete
`edit {"path":"obsolete.txt","edits":[{"op":"delete"}]}`
# Multiple entries
All entries in one call apply to the top-level `path`; use separate calls for different files.
</examples>

<avoid>
- Generic anchors: `import`, `export`, `describe`, `function`, `const`
- Repeating same addition in multiple hunks (duplicate blocks)
- Full-file overwrites for minor changes (acceptable for major restructures or short files)
</avoid>
