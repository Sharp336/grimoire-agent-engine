# code_search

Semantic code search using vector embeddings.

Finds code snippets by meaning, not just text matching. Use when you need to find code by concept (e.g., "authentication middleware", "database connection pool") rather than exact strings.

## Prerequisites

- Enable **Code Search (Zvec)** in `/settings` under Tools → Available Tools.
- Install `@zvec/zvec`: `bun add @zvec/zvec`
- Run `/code-index` to build the index before searching. The tool does **not** auto-index on first use — it only searches the existing index.

## Parameters

- `query` (string, required): Natural language search query.
- `pattern` (string, optional): File glob pattern to filter results (e.g. `*.ts`).
- `topK` (number, optional): Max results to return (default 20).

## Behavior

Returns matching code chunks with file paths, line numbers, and relevance scores. Supports hybrid (vector + FTS) search when embeddings are available, falling back to FTS-only mode otherwise.

If the index is empty, the tool returns a message telling you to run `/code-index`.

Prefer `grep` for exact string/regex matching. Use `code_search` when you need semantic understanding of what the code does.
