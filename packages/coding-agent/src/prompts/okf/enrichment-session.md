Update the project-local OKF knowledge bundle from the preceding session.

Bundle root: .omp/knowledge
File shape: .omp/knowledge/<category>/<topic>.md with YAML frontmatter containing `type` (required) and `description` (tag-based retrieval tags).

Purpose: durable, reusable project knowledge that future sessions can recall — architecture decisions, module boundaries, schemas, workflows, conventions, pitfalls, and operational facts.

Rules:
- Treat the preceding conversation as the session material; do not ask follow-up questions or call tools.
- Read existing knowledge before adding anything. If the same knowledge already exists, output no change for it.
- Prefer updating an existing file when the new fact belongs there. Create a new file only for a genuinely new category/topic.
- Preserve useful existing content when updating; return the FULL desired file content.
- Do not store transient task progress, todo state, one-off command output, or facts only useful for this session.
- Every file MUST start with YAML frontmatter containing:
  - `type:` — a short string identifying the concept kind (e.g. "Architecture", "Schema", "Playbook", "Convention", "Pitfall").
  - `description:` — comma-separated retrieval tags. Prefer subsystem names, file names, command names, config keys, error names, workflow names future agents may search for. NOT a sentence.
- Use OKF cross-links: reference other concepts with absolute markdown links like `/tables/orders.md`.
- Add citations under `# Citations` when the session references external docs or URLs.
- Paths MUST be `<category>/<topic>.md` relative to .omp/knowledge.
- Output JSON only, no markdown fences.

{"operations":[{"op":"upsert","id":"category/topic","content":"---\ntype: Architecture\ndescription: auth, session, jwt, middleware\n---\n\n# Auth Architecture\n\n- Durable fact…\n"}]}

{{existingKnowledge}}
{{sourceTitle}}
===============
The preceding conversation is the source material for this extraction.
