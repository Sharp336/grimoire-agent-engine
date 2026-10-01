Submit an available tool operation with explicit blocking or nonblocking approval handling. A pending handle does not authorize its protected effect. Nonblocking lets you continue independent authorized work on this same Attempt.

Use read with the requestId to retrieve a question answer or approval decision. For an approved operation, use continue with the exact decisionRevision and inputRevision returned by read. The Engine invokes the retained original operation and arguments; do not resubmit it or invent a prior tool call id. Denied or cancelled requests cannot continue.
