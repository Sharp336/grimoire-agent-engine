Managed skill: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced as a normal skill in future sessions.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
- `description` plus `match` fields drive procedural recall after repeated tool failures.
- `match.toolFamilies`: failing tool names such as `bash` or `mcp:<server>`.
- `match.platforms`: `process.platform` values.
- `match.triggers`: failure symptoms that should recall this procedure.
- `scope: "project-tagged"` adds current-project ranking affinity; the procedure stays searchable everywhere.
No frontmatter in `body`; generated from `name`, `description`, and catalog metadata.
