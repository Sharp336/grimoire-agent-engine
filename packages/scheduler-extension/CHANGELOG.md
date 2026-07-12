# Changelog

## [Unreleased]

### Added

- Initial release: session-quota-aware prompt queue (`/scheduler`) — queue prompts and drain them unattended across Claude 5-hour session windows, with provider rate-limit holds (429 retry-after), network-outage backoff probing, a self-healing watchdog, pause-on-user-abort, resume-not-skip semantics, crash recovery, and `/scheduler export`.
- `/scheduler add-file` batch format: a file of comma-separated `{prompt: "..."}` objects (whitespace/newline tolerant, bare or quoted keys, optional `[...]`, trailing comma ok) queues up to 30 tasks atomically; syntax/shape errors queue nothing and name the offending entry. Plain-text files still queue as one prompt.
- Content-policy ("cyber") violation recovery: when a turn is rejected by Anthropic's usage-policy classifier, the poisoned conversation is purged with a fresh context (`ctx.newSession`, `compact` fallback) before the task is re-dispatched with the resume preamble, and the attempt is refunded so a poison cascade never burns the `maxAttempts` budget. A new `maxContextResets` config (default 5) fails a prompt that trips the classifier even in a clean context instead of looping forever. Logged as a `context_reset` event.
