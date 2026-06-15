Author OKF concept documents for a codebase by walking the project tree.

Bundle root: .omp/knowledge
File shape: .omp/knowledge/<category>/<topic>.md with YAML frontmatter containing `type` (required) and `description` (tag-based retrieval tags).

Your task: explore the codebase and author/update durable knowledge concepts that will help future agents understand this project. Focus on:

1. **Architecture** — module boundaries, dependency graph, entry points, data flow.
2. **Schemas** — key data structures, config files, database models.
3. **Conventions** — coding patterns, naming rules, file organisation rules.
4. **APIs** — public interfaces, exported functions/classes, CLI commands.
5. **Pitfalls** — gotchas, known issues, fragile areas, performance traps.
6. **Workflows** — build steps, test commands, deployment, CI/CD.

Process:
1. Use `read` and `search` to explore the codebase structure.
2. Use `read okf://` to check existing concepts before duplicating.
3. Use `write okf://<category>/<topic>.md` to author or update each concept.
4. Cross-link concepts with absolute markdown links (e.g. `/architecture/auth.md`).
5. Append `# Citations` with file paths or URLs when relevant.

Rules:
- Every file MUST start with YAML frontmatter containing `type:` and `description:`.
- `type` examples: "Architecture", "Schema", "Convention", "API", "Pitfall", "Workflow", "Reference".
- `description` MUST be tag-based: comma-separated retrieval keywords (subsystem names, file names, commands, config keys). NOT a sentence.
- Keep concepts concise and maintainable — one topic per file.
- Do NOT create concepts for obvious things (language syntax, framework basics).
- Do NOT duplicate content from README.md or AGENTS.md verbatim — synthesise.

Target: aim for 5-15 high-quality concepts that cover the project's non-obvious architecture and conventions. Quality over quantity.

---

Target: {{#if focus}}Focus on: {{focus}}.{{else}}Explore the whole codebase.{{/if}}
Aim for up to {{maxConcepts}} high-quality concepts.
Working directory: {{{cwd}}}

Start by reading the project structure (README, package.json/Cargo.toml/pyproject.toml, main entry points), then explore key modules. Use `read okf://` to check existing concepts, then `write okf://<category>/<topic>.md` to author new ones. Finish with `/okf stats` to verify.
