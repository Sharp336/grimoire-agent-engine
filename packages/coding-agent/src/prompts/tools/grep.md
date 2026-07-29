Searches local files with Rust regex plus PCRE2 fallback.

<instruction>
- Scope `path` to known files/directories; separate roots with `;`.
- Broad searches can time out; scope them narrowly or use `glob` first.
- One-file line selector: `src/foo.ts:50-100` (selectors never choose the search root).
- Literal `\n` or `\\n` enables cross-line patterns.
</instruction>

<critical>
- Use this instead of shell `grep`/`rg`.
- Open-ended multi-round search → Task + scout, not chained calls.
</critical>
