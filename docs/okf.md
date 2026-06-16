# Open Knowledge Format (OKF)

OKF is an **additive knowledge layer** that gives the agent a curated, markdown-based knowledge bundle for the current project. It runs alongside any memory backend (Hindsight, Mnemopi, local, or off) — it is not a memory backend replacement.

A bundle is a directory of markdown concept documents with YAML frontmatter. Each concept has a required `type` field and a tag-based `description` for retrieval. Concepts cross-link via standard markdown links, forming a navigable knowledge graph. The agent can read, write, search, visualise, and enrich the bundle.

Disabled by default. Enable via `/settings` (Memory tab → OKF group) or `config.yml`:

```yaml
okf:
  enabled: true
```

## How it works

OKF is **additive** — it coexists with the active memory backend. When enabled, the session:

1. **Indexes** the bundle at startup (reconciles the search index with the on-disk files).
2. **Auto-recalls** relevant concepts into the first turn's system prompt based on the user's message.
3. **Injects** a static instruction block telling the agent how to use `okf://` URLs and `/okf` commands.

The agent can then:
- `read okf://tables/orders.md` — read a concept
- `write okf://tables/orders.md` — create or update a concept
- `read okf://` — list all concepts (progressive-disclosure index)
- `/okf stats` — see bundle statistics
- `/okf enrich` — run the codebase-walking enrichment agent

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `okf.enabled` | `false` | Master toggle |
| `okf.store` | `auto` | Index backend: `auto` (Hindsight if configured, else SQLite), `hindsight`, or `sqlite` |
| `okf.bundleDir` | `<cwd>/.omp/knowledge` | Bundle root directory |
| `okf.scoping` | `per-project` | `global`, `per-project`, or `per-project-tagged` |
| `okf.bankId` | `okf` | Hindsight bank for OKF concepts (when using Hindsight store) |
| `okf.autoRecall` | `true` | Recall relevant concepts into the first turn |
| `okf.recallMaxTokens` | `2000` | Max tokens for the recall snippet |
| `okf.reindexOnStart` | `true` | Reconcile the index with the bundle at session start |
| `okf.enrichmentEnabled` | `false` | Enable the curator agent that authors concepts from sessions and the codebase |

## Store backends

OKF supports two index backends, resolved at startup via `okf.store`:

- **SQLite (FTS5)** — the local fallback. Uses `bun:sqlite` with an FTS5 virtual table for full-text search (porter + unicode61 tokenisation, bm25 ranking). The DB file lives at `<bundleDir>/okf.db`. No server needed.
- **Hindsight (pg0)** — routes concept storage and recall through a Hindsight server (embedded Postgres). Each concept maps to a Hindsight document in a dedicated OKF bank, tagged `okf` for isolation from episodic memories. Recall uses the server's semantic+lexical search.

When `okf.store` is `auto`, OKF probes the Hindsight server health at startup. If it's configured and responsive, Hindsight is used; otherwise SQLite.

## `/okf` slash command

| Subcommand | Effect |
| --- | --- |
| `view` | Show the OKF bundle index listing |
| `list` | List all concepts with type and description |
| `stats` | Concept count, cross-links, broken links, type breakdown |
| `diagnose` | Run OKF §9 conformance check over every concept |
| `reindex` | Rebuild the search index from the on-disk bundle |
| `visualize [out.html]` | Generate a self-contained interactive HTML graph viewer |
| `enrich [focus]` | Author/update concepts from the codebase (enrichment agent) |

## `okf://` protocol

OKF concepts are accessible through the `okf://` internal-URL scheme (like `memory://` or `skill://`):

| URL | Content |
| --- | --- |
| `okf://` | Index listing of all concepts (progressive disclosure) |
| `okf://<category>` | Listing for one category |
| `okf://<category>/<topic>.md` | Read or write a single concept |

## Concept document format

Each concept is one markdown file with YAML frontmatter:

```markdown
---
type: Playbook
title: Incident Response
description: freshness alert, oncall, orders pipeline, escalation
tags: [oncall, incident, ops]
timestamp: 2026-05-28T14:30:00Z
---

# Steps

1. Check the [ingestion dashboard](https://example.com/dash).
2. …
```

**Required:** `type` (a short string identifying the concept kind).

**Recommended:** `title`, `description` (tag-based retrieval keywords), `resource` (URI), `tags`, `timestamp`.

**Reserved filenames:** `index.md` (directory listing), `log.md` (update history). These are structural, not concepts.

**Cross-links:** Use standard Markdown links with absolute bundle paths (`[orders](/tables/orders.md)`) or relative paths (`[other](./other.md)`). Bare `[/tables/orders.md]` text is tolerated by the graph builder but should not be authored intentionally. Broken links are tolerated.

**Citations:** Add a `# Citations` heading with numbered references.

## Enrichment agent

OKF includes an enrichment agent that can author/update concepts automatically:

- **Codebase walking** (`/okf enrich`) — spawns a Task subagent that explores the project tree (modules, entry points, schemas, conventions, pitfalls) and writes concept files via the `okf://` protocol. Uses the agent's existing tools (`read`, `search`, `find`) plus zread/web-reader MCPs when configured.
- **Session extraction** — a post-session LLM pass that reads the preceding conversation and extracts durable knowledge into upsert/delete operations.

Both modes enforce OKF conformance (every concept gets a non-empty `type` and a tag-based `description`).

## HTML graph viewer

`/okf visualize` generates a single self-contained `.html` file that renders an interactive force-directed graph:

- Nodes = concepts (coloured by `type`, sized by degree)
- Edges = cross-links
- Click a node to see its metadata and description
- Pan, zoom, spring-layout simulation
- No backend, no CDN, no install — fully offline

The file is written to `<bundleDir>/okf-graph.html` by default, or a custom path.

## OKF spec conformance

The implementation conforms to OKF v0.1 §9:
1. Every non-reserved `.md` file has parseable YAML frontmatter.
2. Every frontmatter block contains a non-empty `type` field.
3. Reserved filenames (`index.md`, `log.md`) follow the spec's structure.

Use `/okf diagnose` to validate the bundle. Non-conforming files are auto-normalised on read (default `type: Reference`, derived tag-based `description`).

## Key files

- `packages/coding-agent/src/okf/document.ts` — typed parse/serialize/conformance
- `packages/coding-agent/src/okf/bundle.ts` — bundle I/O, link resolution, graph, index, fingerprint
- `packages/coding-agent/src/okf/store/` — store interface, SQLite FTS5, Hindsight pg0, resolver
- `packages/coding-agent/src/okf/state.ts` — session layer (auto-recall, injection, lifecycle)
- `packages/coding-agent/src/okf/enrichment/` — session-extraction + codebase-walking enrichment
- `packages/coding-agent/src/okf/viewer/generator.ts` — HTML graph viewer
- `packages/coding-agent/src/internal-urls/okf-protocol.ts` — `okf://` URL handler
- `packages/coding-agent/src/slash-commands/okf-command.ts` — `/okf` slash command
- `packages/coding-agent/src/prompts/okf/` — enrichment prompt templates

## See also

- [Autonomous Memory](./memory.md) — the memory backend system (Hindsight/Mnemopi/local)
- [OKF spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — the full v0.1 specification
