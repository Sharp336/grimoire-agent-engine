Semantic code search using vector embeddings.

Finds code snippets by meaning, not just text matching. Use when you need to find code by concept (e.g., "authentication middleware", "database connection pool") rather than exact strings.

Returns matching code chunks with file paths, line numbers, and relevance scores. The index must be built before searching — if the index is empty, the tool returns a message telling you to run `/code-index` first. Use `/code-index` to build or rebuild the index.

Prefer `grep` for exact string/regex matching. Use `code_search` when you need semantic understanding of what the code does.
