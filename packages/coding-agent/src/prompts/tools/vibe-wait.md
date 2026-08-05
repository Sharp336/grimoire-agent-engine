Blocks until ONE watched session finishes its current turn, the timeout elapses, or you are interrupted — not until all finish. Re-issue to keep waiting.

Turn results normally deliver themselves; you NEVER need this to receive output. Use it only when you are completely blocked and cannot direct any other session.

- `sessions` — ids to watch. Omit to watch every session with a turn in flight.
- `timeout` — seconds to wait (default 30).

A settled turn returns the same bounded preview that self-delivery would carry and acknowledges that job, so it is not delivered twice. Each settled entry exposes its immutable `fullOutputUrl` (`agent://<id>/turn-<n>`) when artifact persistence succeeded; `agent://<id>` is only the latest-output alias. A named idle session reports its latest retained settled job, not its whole history.
