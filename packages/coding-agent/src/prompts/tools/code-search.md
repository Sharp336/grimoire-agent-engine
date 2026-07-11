Semantic code search using vector embeddings.

Finds code snippets by meaning, not just text matching. Use when you need to find code by concept (e.g., "authentication middleware", "database connection pool") rather than exact strings.

Returns matching code chunks with file paths, line numbers, and relevance scores. The first search indexes the workspace; subsequent searches are fast.

Prefer `grep` for exact string/regex matching. Use `code_search` when you need semantic understanding of what the code does.
