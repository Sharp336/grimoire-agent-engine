# Changelog

## [Unreleased]

### Added

- Initial release: session-quota-aware prompt queue (`/scheduler`) — queue prompts and drain them unattended across Claude 5-hour session windows, with provider rate-limit holds (429 retry-after), network-outage backoff probing, a self-healing watchdog, pause-on-user-abort, resume-not-skip semantics, crash recovery, and `/scheduler export`.
