# Coverage rankings

Documentation coverage per page. Rendered as a badge on every page via the
`coverage` frontmatter field and the `PageTitle` component override
(`src/components/PageTitle.astro`). Update both this file and the page
frontmatter when a ranking changes. Source map: `SOURCES.md`.

- **A — High**: comprehensive for the feature's user-facing surface (all flags/keys/commands verified against sources).
- **B — Medium**: solid guide coverage of primary workflows; secondary detail omitted.
- **C — Low**: sketch; meaningful documented surface missing.

## A (18)

`configuration/settings` · `configuration/environment-variables` · `configuration/keybindings` · `configuration/themes` · `configuration/context-files` · `configuration/system-prompt` · `configuration/approvals` · `models/providers` · `features/compaction` · `features/collab` · `features/computer-use` · `features/magic-keywords` · `features/vibe-mode` · `extending/hooks` · `extending/custom-tools` · `getting-started/installation` · `reference/cli` · `reference/slash-commands`

## B (27)

`getting-started/quickstart` · `getting-started/first-session` · `models/model-roles` · `models/local-models` · `features/sessions` · `features/memory` · `features/advisor` · `features/stats` · `features/code-execution` · `features/code-intelligence` · `features/debugging` · `features/subagents` · `features/code-review` · `features/merge-conflicts` · `features/atomic-commits` · `features/github` · `features/editor-integration` · `features/browser` · `features/web-search` · `features/stream-rules` · `features/voice` · `extending/extensions` · `extending/skills` · `extending/mcp` · `extending/plugins` · `extending/sdk` · `reference/configuration`

## C (1)

`features/tools` — intentional one-line-per-tool index; per-tool parameter detail lives in `docs/tools/*.md`. Promote to B by adding a short parameters block per high-traffic tool (bash, read, edit, write, grep, glob, task).
