# learn

> Capture a reusable lesson into long-term memory, and optionally create or update a managed skill in the same call.

## Source
- Entry: `packages/coding-agent/src/tools/learn.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/learn.md`
- Managed-skill collaborators:
  - `packages/coding-agent/src/autolearn/managed-skills.ts` — validates names, writes managed `SKILL.md` files, enforces size and symlink safety.
  - `packages/coding-agent/src/extensibility/skills.ts` — detects authored skills that would shadow a managed skill name.
- Memory collaborators:
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped Mnemopi retention path.
  - `packages/coding-agent/src/memory-backend/local-backend.ts` — local file-backed lesson storage.
  - `packages/coding-agent/src/hindsight/state.ts` — Hindsight queued retention path.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `memory` | `string` | Yes | Durable, self-contained lesson to remember. Include what, when, and why so a future session understands it without this conversation. |
| `context` | `string` | No | Optional source context for the lesson. Stored with the lesson when the active backend supports it. |
| `skill` | `object` | No | Also create or enhance a managed skill in the same call. Use only when the lesson is a repeatable procedure worth codifying. |
| `skill.action` | `"create" \| "update"` | Yes, when `skill` is present | Create a new managed skill or update an existing one. |
| `skill.name` | `string` | Yes, when `skill` is present | Kebab-case skill name. It is normalized to lowercase and must use only lowercase letters, digits, and hyphens, 1-64 chars, starting with a letter or digit. |
| `skill.description` | `string` | Yes, when `skill` is present | One-line description of when to use the skill. It drives discovery, so make it specific. |
| `skill.body` | `string` | Yes, when `skill` is present | `SKILL.md` body in Markdown. Do not include frontmatter; generated frontmatter uses `skill.name` and `skill.description`. |

## Outputs
Returns a single-shot tool result.

When only the lesson is captured:
- `content[0].type = "text"`
- `content[0].text = "Lesson stored."` for Mnemopi or local memory.
- `content[0].text = "Lesson queued for retention."` for Hindsight.
- `details = { skill: null }`

When a managed skill is also written:
- `content[0].text = "Lesson stored. Created managed skill \"<name>\"."` or `"Lesson stored. Updated managed skill \"<name>\"."`
- Hindsight uses `"Lesson queued for retention. ..."` instead of `"Lesson stored. ..."`.
- `details = { skill: "<name>" }`

When `skill.action = "create"` targets a name already claimed by a user-authored skill:
- the lesson has already been stored or queued;
- `content[0].text` explains that the managed skill was not created because managed skills cannot override authored skills;
- `isError = true`;
- `details = { skill: null, shadowed: true }`.

## Flow
1. `LearnTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true and `memory.backend` is one of `"hindsight"`, `"mnemopi"`, or `"local"`.
2. `execute(...)` reads the active memory backend.
3. If the backend is `mnemopi`:
   - it reads `session.getMnemopiSessionState()` and throws if the backend was not started;
   - it calls `state.rememberScoped(...)` with source `coding-agent-learn`, importance `0.8`, bank scope, extraction enabled, `veracity = "tool"`, and `memoryType = "fact"`;
   - it throws if Mnemopi does not return a memory id.
4. If the backend is `local`:
   - it calls `localBackend.save(...)` with source `coding-agent-learn`, importance `0.8`, the current agent directory, and cwd;
   - it throws if the sanitized lesson stores zero entries.
5. If the backend is `hindsight`:
   - it reads `session.getHindsightSessionState()` and throws if the backend was not started;
   - it calls `state.enqueueRetain(memory, context)` and reports the lesson as queued.
6. If `skill` is present:
   - a `create` request first checks whether an authored skill already claims the normalized name;
   - if the name is not shadowed, it writes the managed skill through `writeManagedSkill(...)`;
   - write failures are surfaced after the memory operation, so the error message states that the lesson was stored or queued but the managed skill could not be written.

## Modes / Variants
- Memory-only mode records a reusable lesson without changing managed skills.
- Memory-plus-skill mode records the lesson and creates or updates an isolated managed skill.
- Managed skills are stored under `~/.omp/agent/managed-skills` and surface like normal skills in future sessions.
- Managed skills never touch user-authored skills and cannot override a user-authored skill with the same name.
- Capture sparingly and specifically: one strong reusable lesson is preferred over several vague lessons.

## Side Effects
- Memory
  - Mnemopi: stores a scoped fact in the configured Mnemopi bank.
  - Local: appends to the local backend's learned-memory store.
  - Hindsight: queues a retention request for the backend.
- Filesystem
  - When `skill` is present, creates or overwrites `~/.omp/agent/managed-skills/<name>/SKILL.md`.
- Approval
  - Uses write approval when `skill` is present or when `memory.backend = "local"`; otherwise uses read approval.

## Limits & Caps
- Tool availability is gated by `autolearn.enabled`.
- Tool availability also requires `memory.backend` to be `"hindsight"`, `"mnemopi"`, or `"local"`.
- Managed skill names must match lowercase kebab-case: lowercase letters, digits, and hyphens, 1-64 chars, starting with a letter or digit.
- Managed skill content is capped at 64,000 UTF-8 bytes for the generated frontmatter plus body.
- `skill.action` supports only `"create"` and `"update"`; deletion uses `manage_skill`.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no Mnemopi state exists.
- Throws `Mnemopi did not store the lesson (no memory id returned).` when scoped Mnemopi retention returns no id.
- Throws `Lesson was empty after sanitization; nothing stored.` when local storage rejects the sanitized lesson.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no Hindsight state exists.
- Returns an error result, after storing or queueing the lesson, when creating a managed skill whose name is already claimed by an authored skill.
- Throws `Lesson stored, but the managed skill could not be written: <reason>` or `Lesson queued for retention, but the managed skill could not be written: <reason>` when managed-skill writing fails.
- Managed-skill write failures include invalid names, empty descriptions, empty bodies, existing skills on `create`, missing skills on `update`, symlink safety failures, and the 64,000-byte size cap.

## Notes
- Use `learn` after solving something whose insight will pay off again: a non-obvious fix, a project convention, or a workflow that worked.
- Use the optional `skill` object only for repeatable procedures worth codifying as a skill, not for ordinary facts.
- The managed-skill `body` is the Markdown content below frontmatter; frontmatter is generated automatically from `name` and `description`.
