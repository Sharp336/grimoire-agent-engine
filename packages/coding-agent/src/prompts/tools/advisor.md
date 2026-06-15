Consult a separately-paired advisor model for a concise strategic second opinion on the current task.

The advisor reads the full conversation and returns a short plan or course-correction — the key decision, the approach it would take, and the failure mode to avoid. It does NOT write the solution; you remain the executor.

Reach for it at a genuine fork: an architectural choice, a stubborn bug after a failed attempt, or before committing to a direction that is expensive to reverse. Pass `focus` to ask a specific question; omit it for general guidance on where things stand.

The advisor model is configured separately (the `advisor` model role) and may be a more capable model from any provider. When a `compactor` model role is also paired, a cheaper long-context model first digests the conversation into a brief that the advisor reviews — so an expensive or shorter-context advisor stays affordable. If no advisor is paired, or the call fails, the tool returns a note and the turn continues — a missing second opinion never blocks you.
