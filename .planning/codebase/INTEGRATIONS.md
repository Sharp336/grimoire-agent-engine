# External Integrations

**Analysis Date:** 2026-03-02

## APIs & External Services

**Internal package integrations (not third-party services):**
- Workspace libraries (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-agent-core`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-natives`, `@oh-my-pi/omp-stats`) are internal dependencies declared in `packages/coding-agent/package.json` and path-mapped in `tsconfig.base.json`.
- These are in-repo module boundaries, not networked external services.

**Third-party LLM APIs (env-gated):**
- OpenAI / Azure OpenAI / Anthropic / Gemini / Vertex / Bedrock / Cursor / GitLab Duo / Codex / Synthetic / Kimi providers implemented in `packages/ai/src/providers/*.ts` and provider registry in `packages/ai/src/stream.ts`.
  - SDK/Client: `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime` (`packages/ai/package.json`).
  - Auth: `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`, `GEMINI_API_KEY`, Vertex ADC (`GOOGLE_APPLICATION_CREDENTIALS` + project/location vars), AWS credential env/profile variables (`docs/environment-variables.md`, `packages/ai/src/stream.ts`).

**Third-party Web Search APIs (env-gated):**
- Provider chain and availability in `packages/coding-agent/src/web/search/provider.ts` and `packages/coding-agent/src/web/search/providers/*.ts`.
  - Exa (`https://api.exa.ai/search`), Brave (`https://api.search.brave.com/res/v1/web/search`), Perplexity (`https://api.perplexity.ai/chat/completions`), Kagi (`https://kagi.com/api/v0/search`), Jina (`https://s.jina.ai`), Z.AI MCP (`https://api.z.ai/api/mcp/web_search_prime/mcp`), Kimi (`https://api.kimi.com/coding/v1/search`), Gemini Antigravity endpoints.
  - Auth: `EXA_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`/`PERPLEXITY_COOKIES`, `KAGI_API_KEY`, `JINA_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_SEARCH_API_KEY`/`KIMI_SEARCH_API_KEY`.

**Public data/source APIs (no first-party backend):**
- URL-specific scraper integrations in `packages/coding-agent/src/web/scrapers/*.ts` (examples: GitHub API, GitLab API, NVD, PyPI, npm registry, crates.io, arXiv, SEC EDGAR, Wikipedia, Docker Hub, etc.).
  - SDK/Client: direct `fetch` calls in scraper modules.
  - Auth: mostly unauthenticated; optional tokens for some providers (for example `GITHUB_TOKEN`/`GH_TOKEN` in `packages/coding-agent/src/web/scrapers/github.ts`).

## Data Storage

**Databases:**
- Local SQLite only (Bun SQLite), no hosted DB detected.
  - Connection: filesystem paths from `packages/utils/src/dirs.ts` (`getAgentDbPath()`, `getStatsDbPath()`).
  - Client: `bun:sqlite` in `packages/coding-agent/src/session/agent-storage.ts`, `packages/coding-agent/src/session/history-storage.ts`, `packages/coding-agent/src/memories/storage.ts`, `packages/ai/src/auth-storage.ts`, `packages/ai/src/model-cache.ts`, `packages/stats/src/db.ts`.

**File Storage:**
- Local filesystem only under `~/.omp` (sessions/blobs/logs/plugins/themes/tools) via path helpers in `packages/utils/src/dirs.ts`.

**Caching:**
- Local cache DB in `packages/ai/src/model-cache.ts`.
- In-process and file-based caches only; no Redis/Memcached service detected.

## Authentication & Identity

**Auth Provider:**
- Multi-provider API key and OAuth strategy implemented internally (not a single IdP).
  - Implementation: provider-specific OAuth and token exchange in `packages/ai/src/utils/oauth/*.ts`, auth persistence in `packages/ai/src/auth-storage.ts` and `packages/coding-agent/src/session/auth-storage.ts`.

## Monitoring & Observability

**Error Tracking:**
- No external SaaS error tracker detected.

**Logs:**
- Local rotating logs via `winston` in `packages/utils/src/logger.ts` (`~/.omp/logs`).
- Local observability dashboard service in `packages/stats/src/server.ts` backed by `packages/stats/src/db.ts`.

## CI/CD & Deployment

**Hosting:**
- CLI/binary product; no always-on hosted application detected.
- Distribution targets are npm packages and GitHub release binaries (`package.json` publish scripts, `.github/workflows/ci.yml`).

**CI Pipeline:**
- GitHub Actions in `.github/workflows/ci.yml` (Rust checks, Bun checks/tests, native addon matrix builds, release creation, npm publish).

## Environment Configuration

**Required env vars:**
- Core provider keys: `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY` fallback in some tools), `AZURE_OPENAI_API_KEY`, AWS Bedrock credential set, `EXA_API_KEY` for Exa-specific search tooling.
- Full integration matrix is in `docs/environment-variables.md`.

**Secrets location:**
- Environment variables loaded by `packages/utils/src/env.ts`.
- Persisted OAuth/provider credentials in local SQLite (`~/.omp/agent/agent.db`) via `packages/ai/src/auth-storage.ts` and coding-agent auth/session storage modules.

## Webhooks & Callbacks

**Incoming:**
- Local OAuth callback server (`http://localhost:<port>/callback`) in `packages/ai/src/utils/oauth/callback-server.ts`; port can fall back dynamically if preferred port is busy.

**Outgoing:**
- HTTP requests to third-party provider/search/scraper endpoints from `packages/ai/src/providers/*.ts`, `packages/coding-agent/src/web/search/providers/*.ts`, and `packages/coding-agent/src/web/scrapers/*.ts`.

---

*Integration audit: 2026-03-02*