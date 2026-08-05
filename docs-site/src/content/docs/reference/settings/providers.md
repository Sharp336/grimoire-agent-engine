---
title: Settings — Providers
description: Web search, image generation, fetch, and the on-device tiny-model switches per provider.
coverage: B
sidebar:
  label: Settings — Providers
  order: 6
---

Settings that influence how providers and ancillary services behave. Provider credentials and custom model definitions are configured separately — see [Providers](/oh-my-pi/models/providers/) and [Model roles](/oh-my-pi/models/model-roles/).

## Providers and services

Provider credentials and custom model definitions are configured separately — see [Providers](/oh-my-pi/models/providers/) and [Model roles](/oh-my-pi/models/model-roles/).

| Key | Type | Default | Description |
|---|---|---|---|
| `providers.webSearchOrder` | array | `[]` | Provider IDs in priority order for `web_search` (`perplexity`, `gemini`, `anthropic`, `codex`, `zai`, `exa`, `jina`, `kagi`, `tavily`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, …). Duplicates and unknown IDs are ignored; unlisted providers retain their built-in relative order afterward. Empty = built-in order. Replaces the removed `providers.webSearch` enum (a legacy value migrates to the head of this list). |
| `providers.webSearchGeminiModel` | string | _(unset)_ | Gemini model ID for Google Search grounding when `web_search` uses Gemini; defaults to `gemini-2.5-flash`, overridden by `GEMINI_SEARCH_MODEL`. |
| `providers.imageOrder` | array | `[]` | Image-generation provider IDs in priority order (`openai`, `openai-codex`, `antigravity`, `xai`, `gemini`, `openrouter`). Unlisted providers follow the active session provider and the built-in order. Replaces the removed `providers.image` enum (a legacy value migrates to the head of this list). |
| `providers.fetch` | enum | `auto` | One of `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `jina`. |
| `providers.tinyModel` | enum | `online` | One of `online`, `lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`. |
| `providers.tinyModelDevice` | enum | `default` | ONNX execution provider for local tiny models. Overridden by `PI_TINY_DEVICE`. |
| `providers.tinyModelDtype` | enum | `default` | ONNX precision for local tiny models. Overridden by `PI_TINY_DTYPE`. |
| `providers.openaiWebsockets` | enum | `auto` | One of `auto`, `off`, `on`. |
| `providers.openrouterVariant` | enum | `default` | One of `default`, `nitro`, `floor`, `online`, `exacto`. |
| `providers.kimiApiFormat` | enum | `anthropic` | One of `openai`, `anthropic`. |
| `provider.appendOnlyContext` | enum | `auto` | One of `auto`, `on`, `off`. |
| `exa.enabled` | boolean | `true` | Enable Exa integration. |
| `exa.enableSearch` | boolean | `true` | Exa search. |
| `exa.enableResearcher` | boolean | `false` | Exa researcher. |
| `exa.enableWebsets` | boolean | `false` | Exa websets. |
| `searxng.endpoint` | string | _(unset)_ | SearXNG instance URL. |
| `searxng.token` | string | _(unset)_ | SearXNG token; also `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`. |
| `auth.broker.url` | string | _(unset)_ | Auth-broker URL. Overridden by `OMP_AUTH_BROKER_URL`. |
| `auth.broker.token` | string | _(unset)_ | Auth-broker token. Overridden by `OMP_AUTH_BROKER_TOKEN`. |
