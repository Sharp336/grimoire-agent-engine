# Merge Gateway provider extension

Registers [Merge Gateway](https://docs.merge.dev/merge-gateway/get-started) (`https://api-gateway.merge.dev`) as an omp model provider, so any Gateway route becomes selectable from `/model` through a single `MERGE_GATEWAY_API_KEY` — with live model discovery, real cost/context metadata, and a `/login` paste-key flow.

## What it registers

| Provider | Wire | Models |
| --- | --- | --- |
| `merge-gateway` | OpenAI-compatible (`/v1/openai/chat/completions`) | every tool-callable text model, any vendor |
| `merge-gateway-anthropic` | Anthropic-compatible (`/v1/messages`) | first-party Claude routes + the routing policy |

Two registrations are required because the two wires need different base URLs: omp builds the OpenAI wire as `<baseUrl>/chat/completions`, but the Anthropic wire as `<baseUrl>/v1/messages`. The Anthropic wire preserves signed thinking blocks across multi-round tool loops (Gateway drops unsigned blocks on replay), which is why Claude routes get their own provider. The OpenAI-wire provider sets `compat.supportsReasoningEffort: false` because Gateway forwards `reasoning_effort` and some vendors reject it.

Selectors look like `merge-gateway/anthropic/claude-sonnet-4-6` or `merge-gateway/google/gemini-3.5-flash`; both providers also expose `default_routing`, which hands each request to your org's routing policy.

## Usage

1. Get a key at <https://gateway.merge.dev/api-keys>.
2. Either export it:

	```sh
	export MERGE_GATEWAY_API_KEY=mg_…
	pi --extension examples/extensions/merge-gateway
	```

	or run without it and paste the key via `/login` → **Merge Gateway** (validated against the API before saving).

3. `/model` → filter `merge`. Without a key only `default_routing` entries appear; with one, the full live catalog populates with display names, context windows, and per-million pricing.

## Notes

- The catalog is fetched once per provider and cached by omp for 24 h.
- The env var is read when the extension loads; changing it requires a restart.
- `default_routing` requires a default routing policy on your Gateway org, otherwise Gateway rejects those requests with `model_required`.

## Tests

```sh
bun test packages/coding-agent/examples/extensions/merge-gateway
```
