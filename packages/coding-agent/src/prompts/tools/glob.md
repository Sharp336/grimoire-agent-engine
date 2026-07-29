Globs the local filesystem with fast pattern matching.

<instruction>
- `path`: glob, file, or directory; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).
- Local filesystem only. For `ssh://` paths or internal URI discovery, use `read`; internal URI globs are unsupported.
- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.
- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.
</instruction>

<output>
Matches are newest-first and grouped by directory; directories end in `/`.
</output>

<avoid>
Open-ended multi-round discovery → Task + scout.
</avoid>
