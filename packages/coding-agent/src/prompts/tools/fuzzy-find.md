# Fuzzy Content Search

Search file contents using fuzzy (subsequence) matching.

Use `fuzzy_find` when:

- The exact text is unknown or may contain typos or missing characters.
- You only remember fragments of a variable, function, message string, or log line.
- Regex is too strict and `grep` returns no matches.

Prefer `grep` or `search` when you know the exact pattern or need precise regex control.

Example:
  fuzzy_find "dbmigrate" path="src"
