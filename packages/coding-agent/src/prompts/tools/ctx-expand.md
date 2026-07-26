Read canonical session history for stable managed-context tags.

Pass tags exactly as shown in the transcript, for example `§12§`. This is read-only: it returns the original persisted messages even when their wire-context copies were reduced, and it does not cancel queued or active reductions. Use `max_chars` only to cap the returned preview.