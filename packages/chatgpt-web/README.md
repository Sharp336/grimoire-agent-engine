# OMP ChatGPT Web

Use ChatGPT's web interface as a first-party OMP model provider. This is unofficial browser automation, not the OpenAI API; ChatGPT UI changes or account capability changes can break a turn. OMP reports those failures instead of changing model or transport.

## Setup

```text
omp chatgpt-web enable
omp chatgpt-web login
omp models find "ChatGPT Web"
omp --model chatgpt-web/medium
```

`enable` creates a validated browser-only configuration when none exists, then registers the package extension without creating an API-key or OAuth credential. Re-running it preserves an existing browser-only or full configuration. `login` opens a natively verified Chrome executable with the package-owned profile. By default the profile is under `${PI_CODING_AGENT_DIR:-~/.omp/agent}/chatgpt-web/browser-profile`; treat it as a sensitive login artifact and never copy, sync, or commit it.

For full mode, configure the opaque tunnel identifier and import the runtime key from an owner-only absolute file before enabling:

```text
chatgpt-web setup --mode full --tunnel-id tunnel_<32-lowercase-hex> --runtime-key-file /absolute/path/to/key
omp chatgpt-web enable
omp chatgpt-web login
```

The key is imported through the native owner-safe file boundary; do not place key contents in the command or an environment variable.

Available selectors are `chatgpt-web/light`, `chatgpt-web/medium`, `chatgpt-web/high`, and `chatgpt-web/extra-high`. `chatgpt-web/pro` appears only when the verified account exposes Pro. Each selector has one fixed effort.

## Modes

| Mode | Models | Local OMP tools | Additional setup |
| --- | --- | --- | --- |
| **Browser-only** | Instant through Extra High, plus Pro when available | None | Verified Chrome login |
| **Full** | Same model set | Instant through Extra High only | OpenAI tunnel and ChatGPT connector |

Browser-only prompts and Pro prompts contain no local tool names, schemas, or capabilities. Pro can use capabilities supplied by ChatGPT, but it cannot initiate OMP tool calls through this provider.

Full mode uses a dedicated `chatgpt_web_bind_turn` handshake before ChatGPT can see or call the active turn's OMP tools. OMP remains the authority for sandboxing and every tool approval; connector approval never bypasses OMP policy.

Up to five task-bound tabs can run at once for one profile owner. A sixth turn fails explicitly. Cancelling a turn closes its page, releases its broker binding and tab lease, and leaves sibling turns running.

## Operations and limits

- `omp chatgpt-web status` reports activation, configuration, login, Pro availability, and mode without printing secrets or profile identifiers.
- `omp chatgpt-web doctor` performs read-only package health checks and reports only allowlisted status fields.
- `omp chatgpt-web disable` removes only this extension registration; package-local `chatgpt-web uninstall` removes owned state.
- Full mode requires an outbound OpenAI tunnel. Tunnel identifiers and runtime keys are control-plane credentials and never belong in prompts, command arguments, logs, or repository files.
- Temporary Chat is a ChatGPT privacy mode, not local inference or anonymity. Prompts are processed by OpenAI under the account and workspace settings.
- The provider does not bypass plan, workspace, usage, model, connector, or action restrictions. Use only an account and workspace you are authorized to use.

Read [Architecture](docs/architecture.md), [Security model](docs/security-model.md), and [Third-party notices](LICENSES/NOTICE.md) before enabling full mode.

## Package development

```text
bun run chatgpt-web:check
bun run chatgpt-web:test
```

Live-account and live-tunnel checks are separate manual gates. Unit tests require no credentials or network access; the explicit OS integration gate provisions pinned Chromium, then exercises the private pipe without an account, connector, or network request.
