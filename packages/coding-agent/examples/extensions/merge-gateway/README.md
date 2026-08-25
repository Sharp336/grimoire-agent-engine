# omp-merge-gateway-provider

A standalone [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) extension that registers [Merge Gateway](https://docs.merge.dev/merge-gateway/get-started) as a model provider, so `omp` can route any Gateway model through a single `MERGE_GATEWAY_API_KEY` — with dynamic model discovery, cost estimates, `/login` paste-key support, and proper extended-thinking support for Claude routes.

## What it provides

One provider, **`merge-gateway`**, serving the entire tool-callable Gateway catalog over the right wire per model:

| Models | Wire | Base URL |
| --- | --- | --- |
| everything except first-party Claude routes | OpenAI-compatible | `https://api-gateway.merge.dev/v1/openai` |
| first-party `anthropic/…` routes | Anthropic-compatible | `https://api-gateway.merge.dev` |

Selectors look like `merge-gateway/openai/gpt-5.2`, `merge-gateway/anthropic/claude-sonnet-4-6`, `merge-gateway/google/gemini-3.5-flash`, plus `merge-gateway/default_routing`, which hands each request to your org's routing policy (requires a default routing policy on your Gateway org).

## Why per-model wires

omp builds the OpenAI wire as `<baseUrl>/chat/completions` but the Anthropic wire as `<baseUrl>/v1/messages`. Each model therefore carries its own wire: Claude routes are pinned to the Anthropic-compatible surface because signed thinking blocks survive multi-round tool loops there, while Gateway drops unsigned blocks on replay over the OpenAI wire. Only **first-party** Anthropic routes get this treatment — an `anthropic/…` model served through bedrock rides the OpenAI wire. `reasoning_effort` is suppressed on OpenAI-wire models (`compat.supportsReasoningEffort: false`) because Gateway forwards it and some vendors reject it, following the [official Pi/Merge Gateway guide](https://docs.merge.dev/merge-gateway/coding-agents/pi).

## Prerequisites

- Node ≥ 20 (or Bun)
- `omp` installed
- A Merge Gateway API key from <https://gateway.merge.dev/api-keys>

## Install

From a checkout of this repo:

```sh
omp plugin link .
```

Once published to npm:

```sh
omp plugin install omp-merge-gateway-provider
```

## Authenticate

Either export the key before launching `omp`:

```sh
export MERGE_GATEWAY_API_KEY=mg_…
omp
```

or paste it via `/login` → **Merge Gateway** — the terminal prompts you to paste the key and validates it against the API before saving.

> The env var is read once when `omp` starts. Changing it requires restarting `omp`.

## Pick a model

Open `/model` and filter by `merge`. With a valid key you will see the live Gateway catalog with real display names, context windows, and per-million-token prices. Without a key only the `default_routing` entry appears (actual requests still need a key).

## Troubleshooting

**Models missing after adding/changing the key.** omp caches discovered models for 24 h; if you launched `omp` before setting `MERGE_GATEWAY_API_KEY`, that empty snapshot sticks until the TTL expires. Clear it and restart:

```sh
bun run fix-cache
```

## Limitations

- `MERGE_GATEWAY_API_KEY` is read at startup; changing it requires an `omp` restart.
- The model catalog is cached by `omp` with a 24 h TTL.
- No usage widget: Gateway usage endpoints (`/v1/organization/usage`) require a separate management key, which this extension deliberately does not ask for.
