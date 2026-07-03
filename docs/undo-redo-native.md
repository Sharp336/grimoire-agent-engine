# Native `/undo` and `/redo`

This proposal documents a native implementation path for the existing undo/redo behavior.

## Reference implementation

Working standalone package:

- `https://github.com/Baylar55/omp-undo-redo`
- `v1.0.0`

## Problem

`oh-my-pi` already contains checkpoint / rewind primitives in the session layer, but the current distribution path for undo/redo is external. A native implementation would make the commands discoverable and maintainable inside the core slash-command registry.

## Suggested shape

- Add `/undo` and `/redo` as built-in slash commands.
- Reuse the existing session checkpoint / rewind machinery.
- Keep the behavior symmetric with the current standalone wrapper.
- Preserve the existing shell / TUI semantics for reverting the last message and file edits.

## Review notes

- The slash-command registry currently prioritizes built-ins over extension commands, so a third-party plugin cannot safely shadow these names.
- This is why the standalone package is useful as a reference implementation, but the final user-facing feature should live in core.

## Acceptance criteria

- `/undo` reverts the last user-visible turn and file changes atomically.
- `/redo` restores the last reverted checkpoint.
- The commands work from both the CLI and TUI entrypoints.
- The implementation remains consistent with the current checkpoint/rewind flow.
