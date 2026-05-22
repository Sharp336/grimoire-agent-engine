# OpenAI Codex OAuth in OMP

This guide covers setup, login, import behavior, and model switching when using OpenAI Codex OAuth with OMP.

## What `omp setup codex` does

Run:

```bash
omp setup codex
```

Behavior:

1. OMP checks whether Codex CLI credentials are present at `~/.codex/auth.json`.
2. If found, OMP can import those credentials into OMP auth storage.
3. If not found (or you decline import), OMP starts OpenAI Codex device-code OAuth login.
4. On success, OMP stores credentials as provider `openai-codex`.

## Explicit setup modes

Import only from Codex CLI:

```bash
omp setup codex --from-codex
```

- Succeeds only if `~/.codex/auth.json` exists and is valid.
- Fails fast if no valid Codex CLI credentials are found.

Force fresh device-code login:

```bash
omp setup codex --device
```

- Skips import flow and starts OAuth device-code login directly.

Check status:

```bash
omp setup codex --check
```

- Reports whether OMP already has stored Codex credentials.
- If not stored, reports whether Codex CLI credentials are available to import.

Machine-readable status:

```bash
omp setup codex --check --json
```

## If the user already has Codex auth

If `~/.codex/auth.json` is already present, `omp setup codex` can import it and avoid re-login.  
For non-interactive flows, use `--from-codex`.

## Switching models after login

Once OAuth is set:

- Use `/model` inside a session to switch models.
- Use `Ctrl+P` to cycle models configured for the active role.
- Use role flags at launch (`--smol`, `--slow`, `--plan`) to change role-scoped model selection behavior.

## Notes

- Credentials are stored in OMP auth storage (not only read from Codex CLI files).
- Re-running setup is safe for refresh/import flows.
- `omp setup` also supports `python` and `stt`; `codex` is dedicated to OpenAI Codex OAuth setup.
