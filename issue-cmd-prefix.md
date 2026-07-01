### Description

Currently, all slash commands and prompt templates are merged into the same autocomplete picker namespace. Builtin slash commands, extension commands, custom commands, and prompt templates occupy the root namespace (e.g. `/model`, `/review`). This causes a few pain points:

1. **Autocomplete clutter:** When a project defines many prompt templates in its `.omp/prompts` or `.codex/prompts` directory, the root autocomplete picker becomes extremely noisy. Typing `/` floods the UI with templates, burying core session commands like `/compact` or `/settings`.
2. **Namespace collision and priority inversion:** A prompt template named `model` will silently conflict with or shadow the builtin `/model` command, leading to unpredictable behavior or broken core features.
3. **Lack of visual distinction:** Users cannot easily distinguish between a hardcoded runtime command, a custom TypeScript hook, and a file-based prompt template.

### Proposed Solution

Namespace all non-skill commands (built-ins, extensions, custom TS commands, file-based commands, and prompt templates) under a `cmd:` prefix in the UI.

- Built-ins and templates will appear as `/cmd:<name>`.
- Skills remain under the `/skill:<name>` namespace.
- Typing `/cmd:` will cleanly filter the autocomplete list to commands/templates only.
- Typing `/skill:` will filter to skills only.
- The underlying dispatcher should automatically strip the `/cmd:` prefix and route to the raw command, preserving legacy raw invocations for backward compatibility (e.g., executing `/review` still works), while properly supporting edge cases where legacy dynamic commands actually start with `cmd:`.

*Note: The code for this is already implemented locally on the `cmd-prefix-slash-commands` branch (commit `6115ecca7`), but requires manual pushing due to remote GitHub credential constraints.*