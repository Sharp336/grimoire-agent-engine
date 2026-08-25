# Merge Gateway provider extension

Registers [Merge Gateway](https://docs.merge.dev/merge-gateway/get-started) (`https://api-gateway.merge.dev`) as an omp model provider, so any Gateway route becomes selectable from `/model` through a single `MERGE_GATEWAY_API_KEY` — with live model discovery via the official [`merge-gateway-sdk`](https://www.npmjs.com/package/merge-gateway-sdk), real cost/context metadata, and a `/login` paste-key flow.

## What it registers

One provider, **`merge-gateway`**, serving the tool-callable catalog over the right wire per model:

| Models | Wire | Base URL |
| --- | --- | --- |
| everything except first-party Claude routes | OpenAI-compatible (`/v1/openai/chat/completions`) | `https://api-gateway.merge.dev/v1/openai` |
| first-party `anthropic/…` vendor routes | Anthropic-compatible (`/v1/messages`) | `https://api-gateway.merge.dev` |

Selectors look like `merge-gateway/openai/gpt-5.2` or `merge-gateway/anthropic/claude-sonnet-4-6`.

## Why per-model wires

omp builds the OpenAI wire as `<baseUrl>/chat/completions`, but the Anthropic wire as `<baseUrl>/v1/messages`. Each model therefore carries its own `api` + `baseUrl`: Claude routes are pinned to the Anthropic-compatible surface because signed thinking blocks survive multi-round tool loops there, while Gateway drops unsigned blocks on replay over the OpenAI wire. Only **first-party** Anthropic routes get this treatment — an `anthropic/…` model served through bedrock rides the OpenAI wire. `reasoning_effort` is suppressed on OpenAI-wire models because Gateway forwards it and some vendors reject it.

## Usage

1. Get a key at <https://gateway.merge.dev/api-keys>.
2. Either export it:

	```sh
	export MERGE_GATEWAY_API_KEY=mg_…
	pi --extension examples/extensions/merge-gateway
	```

	or run without it and paste the key via `/login` → **Merge Gateway** (validated against the API before saving; cancelling aborts an in-flight probe).

3. `/model` → filter `merge`. Without a key the provider shows no models; with one, the live catalog populates with display names, context windows, and per-million pricing.

## Tests

```sh
bun install   # in this directory, for merge-gateway-sdk
bun test packages/coding-agent/examples/extensions/merge-gateway
```

Covers vendor selection (owner preference, third-party fallback), wire pinning, pagination with cursor pass-through, SDK error mapping (401/402/429), pagination-cap warning sink, and login cancel/fetch seams.

## Notes

- Catalog results are cached by omp for 24 h.
- The env var is read when the extension loads; `/login` covers the unset case.
