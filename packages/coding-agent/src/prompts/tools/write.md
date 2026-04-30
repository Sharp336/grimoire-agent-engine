Creates or overwrites file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
- Supports `.tar`, `.tar.gz`, `.tgz`, and `.zip` archive entries via `archive.ext:path/inside/archive`
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
</conditions>

<critical>
- You **SHOULD** use Edit tool for modifying existing files (more precise, preserves formatting)
- You **MUST NOT** create documentation files (*.md, README) unless explicitly requested
- You **MUST NOT** use emojis unless requested
</critical>

<unicode-content>
Your tool-call JSON is parsed before this tool sees `content`, so `\uXXXX` decodes natively.
- To write the **character** → (U+2192) on disk: emit `"\u2192"` (one backslash) in the JSON, or the literal `→` character. Both arrive at the tool as `→` and are written as 3 UTF-8 bytes.
- To write the **literal 6-char escape sequence** `\u2192` on disk (JS regex `/\u2192/`, Python `r"\u2192"`, JSON fixtures, docs about Unicode): emit `"\\u2192"` (two backslashes) in the JSON. The parser delivers the 6 chars to the tool and we write them verbatim.
- **NEVER** emit `"\\u2192"` (two backslashes) when you intend the character →. That writes the literal text `\u2192`, not the character.
</unicode-content>
