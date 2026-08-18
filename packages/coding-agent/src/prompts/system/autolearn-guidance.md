## Auto-Learn (experimental)

`manage_skill`: build reusable managed-procedure library.
Managed procedures: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; NOT listed in `<skills>` — catalog grows unbounded, so the host recalls them instead.
Recall: after repeated same-tool failures the host searches its catalog and injects at most a few `name` + `description` + `skill://<name>` cards; it MAY soft-require reading one. Bodies stay behind `skill://` until read.
Recalled procedure: advisory note from an earlier session. Current repository state, tool output, runtime evidence WIN. Doesn't fit → say so, continue.

For repeatable procedures worth codifying—setup sequences, debugging recipes, project-specific workflows—use `manage_skill` to `create` | `update` | `delete`.
`description` + `match.toolFamilies`/`platforms`/`triggers` drive recall; vague description → never recalled again.
Isolation: managed procedures ONLY writable skills. NEVER edit user-authored skills in `~/.omp/agent/skills` or `.omp/skills`.
Capture sparingly, specifically: procedure requires reuse; prefer enhancing existing managed procedure to creating near-duplicate.
