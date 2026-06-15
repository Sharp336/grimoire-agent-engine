# manage_skill

> Create, update, or delete an isolated managed skill for the auto-learn feature.

## Source
- Entry: `packages/coding-agent/src/tools/manage-skill.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/manage-skill.md`
- Managed-skill collaborators:
  - `packages/coding-agent/src/autolearn/managed-skills.ts` — validates names, writes and deletes managed `SKILL.md` files, enforces size and symlink safety.
  - `packages/coding-agent/src/extensibility/skills.ts` — detects authored skills that would shadow a managed skill name.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"create" \| "update" \| "delete"` | Yes | Operation to perform. `create` fails if the managed skill already exists; `update` fails if it does not exist; `delete` removes an existing managed skill. |
| `name` | `string` | Yes | Kebab-case skill name. It is normalized to lowercase and must use only lowercase letters, digits, and hyphens, 1-64 chars, starting with a letter or digit. |
| `description` | `string` | Required for `create` and `update` | One-line description of when to use the skill. It drives discovery, so make it specific. Not used for `delete`. |
| `body` | `string` | Required for `create` and `update` | `SKILL.md` body in Markdown. Do not include frontmatter; generated frontmatter uses `name` and `description`. Not used for `delete`. |

## Outputs
Returns a single-shot tool result.

When a skill is created:
- `content[0].type = "text"`
- `content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`
- `details = { action: "create", name: "<name>" }`

When a skill is updated:
- `content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`
- `details = { action: "update", name: "<name>" }`

When a skill is deleted:
- `content[0].text = "Deleted managed skill \"<name>\"."`
- `details = { action: "delete", name: "<name>" }`

When `action = "create"` targets a name already claimed by a user-authored skill:
- `content[0].text` explains that managed skills cannot override authored skills;
- `isError = true`;
- `details = { action: "create", name: "<name>", shadowed: true }`.

## Flow
1. `ManageSkillTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true.
2. The tool is backend-independent: it does not require an active memory backend.
3. For `action = "delete"`:
   - `execute(...)` calls `deleteManagedSkill(name)`;
   - the helper normalizes and validates the name, checks the managed-skills root, refuses symlinked skill directories, and removes `~/.omp/agent/managed-skills/<name>`.
4. For `action = "create"` or `"update"`:
   - schema refinement requires both `description` and `body`;
   - `create` checks whether an authored skill already claims the normalized name and returns an error result if so;
   - `writeManagedSkill(...)` normalizes the name, sanitizes the description, trims the body, generates frontmatter, checks the byte cap, and writes `~/.omp/agent/managed-skills/<name>/SKILL.md`.
5. `create` uses atomic file creation and fails if the managed skill already exists.
6. `update` requires an existing plain managed `SKILL.md` and refuses symlinks or unsafe hard-linked files before overwriting.

## Modes / Variants
- `create` adds a new managed skill and fails if it already exists.
- `update` overwrites the generated frontmatter and body for an existing managed skill.
- `delete` removes an existing managed skill directory.
- Managed skills are stored under `~/.omp/agent/managed-skills` and surface like normal skills in future sessions.
- Managed skills are for repeatable procedures worth codifying: setup sequences, debugging recipes, and project-specific workflows.
- Managed skills never edit user-authored skills and cannot override a user-authored skill with the same name.

## Side Effects
- Filesystem
  - `create` writes `~/.omp/agent/managed-skills/<name>/SKILL.md`.
  - `update` overwrites `~/.omp/agent/managed-skills/<name>/SKILL.md`.
  - `delete` removes `~/.omp/agent/managed-skills/<name>`.
- Approval
  - Always uses write approval.
- Memory
  - None. Use `learn` when a lesson should also be stored in long-term memory.

## Limits & Caps
- Tool availability is gated by `autolearn.enabled`.
- Managed skill names must match lowercase kebab-case: lowercase letters, digits, and hyphens, 1-64 chars, starting with a letter or digit.
- `description` must sanitize to a non-empty single line for `create` and `update`.
- `body` must be non-empty after trimming for `create` and `update`.
- Managed skill content is capped at 64,000 UTF-8 bytes for the generated frontmatter plus body.
- The generated file is always named `SKILL.md`; callers provide only the body, not frontmatter.

## Errors
- Schema validation rejects `create` and `update` calls that omit `description` or `body` with `"create" and "update" require both "description" and "body".`
- Throws `Invalid skill name "<raw>". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).` for invalid names.
- Returns an error result when creating a managed skill whose name is already claimed by an authored skill.
- Throws `Managed skill "<name>" needs a non-empty description.` when the sanitized description is empty.
- Throws `Managed skill "<name>" needs a non-empty body.` when the trimmed body is empty.
- Throws `Managed skill is <bytes> bytes; the limit is 64000. Trim the body or description.` when the generated file exceeds the cap.
- Throws `Managed skill "<name>" already exists. Use action "update" to change it.` on duplicate `create`.
- Throws `Managed skill "<name>" does not exist. Use action "create" to add it.` on missing `update`.
- Throws `Managed skill "<name>" does not exist.` on missing `delete`.
- Throws symlink or hard-link safety errors when the managed-skills root, skill directory, or `SKILL.md` is unsafe to mutate.

## Notes
- `name` is the discovery key; choose a specific kebab-case name that will not collide with authored skills.
- `description` is discovery-facing. It should state when to use the skill, not merely what the skill is called.
- `body` should contain the reusable procedure in Markdown and must not include frontmatter.
