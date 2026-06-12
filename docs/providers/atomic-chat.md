# Atomic Chat

[Atomic Chat](https://atomic.chat) is a local-first desktop app for running open-weight LLMs with an OpenAI-compatible API at `http://127.0.0.1:1337/v1`.

oh-my-pi registers **atomic-chat** as a built-in, keyless local provider. Models are discovered from `GET /v1/models` when Atomic Chat's Local API Server is running.

## Quick start

1. Install [Atomic Chat](https://atomic.chat) and download at least one model.
2. Enable **Settings → Local API Server** (default port `1337`).
3. Run `omp` and pick a model under the **atomic-chat** provider tab (`/model`).

No API key is required for a default local install.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ATOMIC_CHAT_BASE_URL` | Override discovery/chat base URL (default `http://127.0.0.1:1337/v1`) |
| `ATOMIC_CHAT_API_KEY` | Optional bearer token when Atomic Chat is behind auth or a reverse proxy |

## Explicit `models.yml` override

```yaml
providers:
  atomic-chat:
    baseUrl: http://127.0.0.1:1337/v1
    api: openai-completions
    auth: none
    discovery:
      type: openai-models-list
```

Configuring `atomic-chat` in `models.yml` disables implicit discovery for that provider; include `discovery` explicitly as shown above.

## MCP and agents

Atomic Chat supports MCP servers (web search, tools, file access). oh-my-pi connects to Atomic Chat as the **model backend**; MCP tools configured inside Atomic Chat are used by Atomic Chat's own agent loop, not by oh-my-pi's tool harness directly.

For agent workflows that call Atomic Chat as an OpenAI-compatible endpoint from another tool, point that tool's base URL at `http://127.0.0.1:1337/v1`.
