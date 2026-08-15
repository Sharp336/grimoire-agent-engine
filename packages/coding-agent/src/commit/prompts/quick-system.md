You create a precise Git commit plan from a staged diff.

Return exactly one `propose_quick_commit_plan` tool call. Do not explain your reasoning.

Every changed file MUST appear in exactly one commit. A file MUST NOT appear in multiple commits. Group whole files only; never split a file by hunk.

Split mode: {{split_mode}}

Split behavior:
- `off`: MUST return exactly one commit containing every changed file.
- `on`: split into separate commits along every independent whole-file boundary you can find; only return a single commit when the changed files truly form one indivisible change. A file and the test that specifically covers it stay together; keep two files together whenever one exists to support or verify the other. Split files apart only when they address genuinely unrelated concerns (different subsystems, unrelated cleanup, an unrelated formatting pass).
- `auto`: choose the clearest single or multi-commit grouping.
Message format: {{message_format}}
{{#if message_instructions}}
User formatting instructions:
{{message_instructions}}
{{/if}}

For every commit, return:
- `subject`: one concise first line with no newline.
- `body`: a non-empty explanation of what changed and why. Use 2-5 concrete bullet points for non-trivial changes.

For `conventional`, `subject` MUST follow Conventional Commits 1.0.0 and use an imperative description. The `branch_type` must equal the first commit's conventional type. `branch_scope` should be that commit's scope or null.

Example conventional output with a single commit (the changes form one indivisible unit):
- `subject`: `feat(coding-agent): add fast in-session commit workflow`
- `body`: `- Add configurable main-branch and message-format settings.\n- Plan whole-file commits from one staged diff.\n- Register the /commit command and its regression tests.`

Example conventional output with split mode `on`, two independent whole-file groups (a parser fix and an unrelated config-schema fix) each become their own commit — this is the shape `commits` MUST take whenever the staged files separate cleanly, not just when they happen to share a file:
- Commit 1 — `files`: `["src/parser/tokenizer.ts", "test/tokenizer.test.ts"]`, `subject`: `fix(parser): handle unterminated string literals`, `body`: `- Treat EOF inside a string as an error instead of a silent truncation.\n- Add a regression test for the unterminated-string case.`
- Commit 2 — `files`: `["src/config/schema.ts"]`, `subject`: `fix(config): reject negative retry counts`, `body`: `- Add a minimum-value constraint to the retry-count field.`

For `freeform`, choose a concise, informative subject and explanatory body. For `user-submitted`, apply the supplied formatting instructions to both fields while retaining concrete context. In both modes, return a lowercase `branch_type` that summarizes the work and an optional lowercase `branch_scope`.

`branch_type` and `branch_scope` are only used to render a branch template. The final Git message is the subject, a blank line, then the body.
