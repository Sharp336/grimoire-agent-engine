# System Prompt Customization

How the coding-agent assembles the system prompt sent to the model, and what users can control via `SYSTEM.md`, `APPEND_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (unified template; handles both default and custom prompts via `{{#if customPrompt}}` conditionals)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (project/environment footer)

---

## 1) Inputs

Four user-controllable inputs feed prompt assembly. All four resolve a value as either a literal string or, if the argument looks like a file path, the contents of that file (`resolvePromptInput`).

| Input | Source | Effect |
|---|---|---|
| `--system-prompt <text-or-file>` | CLI flag | Replaces the default System zone while preserving Runtime and Project. Highest precedence. |
| `SYSTEM.md` | `<cwd>/.omp/SYSTEM.md`, then `~/.omp/agent/SYSTEM.md` (and equivalent paths under `.claude`, `.codex`, `.gemini`) | Same effect as `--system-prompt`; used when the flag is absent. |
| `--append-system-prompt <text-or-file>` | CLI flag | Adds the Append zone after the selected default/custom System and before Project. |
| `APPEND_SYSTEM.md` | Same discovery as `SYSTEM.md` | Same effect as `--append-system-prompt`; used when the flag is absent. |

Discovery for `SYSTEM.md` / `APPEND_SYSTEM.md` uses `findConfigFile` (`packages/coding-agent/src/config.ts`): the first existing file across the ordered bases (`.omp`, `.claude`, `.codex`, `.gemini` — project-level at `<cwd>` first, then user-level at `~`) wins. **No ancestor walk-up.** Running `omp` from `<repo>/subdir` does not pick up `<repo>/.omp/SYSTEM.md`; the file must live directly under the cwd's config base or in the user-level location. See [`docs/config-usage.md`](./config-usage.md) for the full discovery contract.

Precedence (highest first):

1. `--system-prompt`
2. project `SYSTEM.md`
3. user `SYSTEM.md`

For append, the same precedence applies between `--append-system-prompt`, project `APPEND_SYSTEM.md`, and user `APPEND_SYSTEM.md`.

---

## 2) Runtime, System, Append, and Project

CLI startup passes resolved `SYSTEM.md` / `--system-prompt` text as `options.customSystemPrompt` and resolved `APPEND_SYSTEM.md` / `--append-system-prompt` text as `options.appendSystemPrompt` via `applyResolvedSystemPromptInputs` in `packages/coding-agent/src/main.ts`. These flow into `buildSystemPrompt` as `resolvedCustomPrompt` and `resolvedAppendSystemPrompt`.

`buildSystemPrompt` assembles four ordered zones:

1. **Runtime** — conventions, tools, tool policy, skills, rules, MCP/internal protocols, and tool-specific safety. Harness-owned and always preserved.
2. **System** — role, personality, behavior, workflow, and delivery contract. The bundled default is replaced as a unit by a custom prompt.
3. **Append** — optional user text appended after the selected default/custom System.
4. **Project** — workstation, cwd, context files, directory rules, workspace tree, date, and repository context. Dynamically rendered and always preserved.

`system-prompt.md` is the unified Runtime/System/Append template. Its `{{#if customPrompt}}` branch selects custom text; the `{{else}}` branch renders the bundled System behavior. `project-prompt.md` renders the Project zone as a subsequent provider-facing block.

Consequences:

- `SYSTEM.md` replaces default model behavior, not harness capabilities.
- Tool inventory, tool policy, skills, rules, MCP protocols, and tool-specific safety remain available with custom prompts.
- `APPEND_SYSTEM.md` follows the selected System zone and appears exactly once.
- Project/environment context remains after default, custom, and append content.
- Subagent prompts use the same custom-System path, replacing the main-agent role/workflow without losing Runtime or Project.

When a custom prompt is provided, `callerControlsCustomPrompt` suppresses the secondary capability discovery path. This prevents a second `SYSTEM.md` from being loaded or injected.

---

## 3) Templating contract

**Contents of `SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are treated as plain text.** They are resolved before prompt-block replacement and are not rendered as Handlebars templates.

The built-in prompt templates are Handlebars (`packages/utils/src/prompt.ts`), but user-provided strings are not compiled with that renderer. A `{{value}}` reference in Handlebars still does not recursively render its substituted contents — the value is emitted as a string. Concretely:

```handlebars
{{! The custom prompt is emitted verbatim inside the template }}
{{#if customPrompt}}
{{customPrompt}}
{{/if}}
```

If `SYSTEM.md` contains:

```handlebars
Working in {{cwd}} on {{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

the rendered output contains those characters verbatim — `{{cwd}}`, `{{#if hasMemoryRoot}}`, etc. are NOT substituted. They will be shown to the model as literal Handlebars syntax.

This is by design. The internal template variables (`cwd`, `date`, `environment`, `workspaceTree`, `skills`, `rules`, `toolRefs`, `hasMemoryRoot`, `hasObsidian`, `mcpDiscoveryServerSummaries`, ...) are not a supported public surface — they change between releases as the prompt is rewritten, and they would couple user configs to internals. Treat them as private.

If a future release exposes a templating surface for `SYSTEM.md`, it will be opt-in (e.g. via a settings flag or a different filename) and documented here.

---

## 4) Recommended patterns

### Add rules without replacing default behavior

Use `APPEND_SYSTEM.md` (or `--append-system-prompt`) without `SYSTEM.md`. Runtime, the bundled System behavior, and Project remain intact.

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### Replace model behavior while keeping harness capabilities

Use `SYSTEM.md` (or `--system-prompt`). This replaces the bundled role, personality, workflow, and delivery contract. Runtime still supplies generated tool guidance, skills, rules, MCP/internal protocols, and tool-specific safety; Project still supplies environment and repository context.

```text
# ~/.omp/agent/SYSTEM.md
You are a code reviewer. Read diffs, surface issues, never edit files.
- Cite paths with backticks.
- Prefer concrete fixes over abstract advice.
```

Use `APPEND_SYSTEM.md` alongside it when a separate final supplement should follow the custom behavior.

### "Customize automatic session titles"

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect the model call that names a new session. Create the title-specific prompt file instead:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message carries no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` is discovered with the same project-then-user config-directory pattern as `SYSTEM.md` / `APPEND_SYSTEM.md`. When absent, OMP uses the bundled `title-system.md` / `tiny-title-system.md` prompts. When present, both the online title path and the local tiny-model path keep the `<title>...</title>` wrapper while using this file as the system turn.

### "Replace everything, including project context" — SDK-only

The normal CLI file/flag path preserves Runtime and Project. SDK code using `CreateAgentSessionOptions.systemPrompt` can replace the complete provider-facing prompt array and omit either zone; `.omp/SYSTEM.md`, `~/.omp/agent/SYSTEM.md`, and `--system-prompt` cannot.

### "Replace, but keep one section of the default instructions" — not directly supported

There is no built-in way to inherit selected subsections of the bundled System behavior while replacing the rest. Use Append to retain the complete bundled System, or copy the required behavior into `SYSTEM.md`. Runtime remains available in both cases.

---

## 5) Deduplication

When a CLI flag or discovered `SYSTEM.md` provides a custom System zone, `applyResolvedSystemPromptInputs` sets `options.customSystemPrompt`. `callerControlsCustomPrompt` then suppresses secondary capability discovery, so the same `SYSTEM.md` is not loaded twice.

Always-apply rules are deduplicated against the custom prompt, append prompt, and context files. A rule whose body is already present in one of those sources is omitted from Runtime injection.

---

## 6) Discovery paths

Only one path actually drives the customization a CLI user sees: the primary CLI path. The capability layer exists but its `SYSTEM.md` output never reaches the rendered prompt under normal CLI startup.

- The primary CLI path (`discoverSystemPromptFile` / `discoverAppendSystemPromptFile` in `main.ts`, which feeds `resolvedSystemPrompt` / `resolvedAppendPrompt`) calls `findConfigFile`. `findConfigFile` checks only `<cwd>/.omp`, `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.gemini`, and the user-level equivalents — it does **not** walk up ancestors. Files in `<ancestor>/.omp/SYSTEM.md` are ignored when `omp` is started from a subdirectory.
- The secondary capability path (`loadSystemPromptFiles` → builtin discovery) does walk up via `findNearestProjectConfigDir` and requires the project `.omp/` directory to be non-empty. Under normal CLI startup, `callerControlsCustomPrompt` suppresses this path entirely when the primary path found a custom prompt.

Net effect for CLI users: put `SYSTEM.md` / `APPEND_SYSTEM.md` directly under `<cwd>/.omp` (or another supported config base under cwd) or in the user-level location (`~/.omp/agent/SYSTEM.md` etc.). Ancestor paths are not searched.

---

## 7) Quick reference

| Goal | Use |
|---|---|
| Add instructions while keeping bundled model behavior | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Replace bundled model behavior while keeping Runtime and Project | `SYSTEM.md` or `--system-prompt` |
| Preserve generated skills/rules/tool guidance while customizing | `SYSTEM.md`; Runtime remains outside the replaceable System zone |
| Customize automatic session titles | `TITLE_SYSTEM.md`; chat-turn `SYSTEM.md` / `APPEND_SYSTEM.md` do not affect title generation |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Files are inserted verbatim. |
| Inherit selected bundled System subsections | Not supported; use Append or copy the required behavior into `SYSTEM.md` |
| Override at a per-repo level | Project `.omp/SYSTEM.md` under the cwd you launch `omp` from |
| Override globally | `~/.omp/agent/SYSTEM.md` or `~/.omp/agent/APPEND_SYSTEM.md` |
