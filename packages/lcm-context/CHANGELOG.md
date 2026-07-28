# Changelog

## [Unreleased]

### Added

- Added a standalone SQLite-backed context engine with branch-aware projection, leased summary jobs, scoped retrieval, diagnostics, retention, quarantine, and rebuild support.
- Added token-fenced job release, current-branch work priority, retry inspection, and safe bounded parallel queue draining.

### Fixed

- Corruption recovery now verifies the database and coordinates with other live contexts before quarantining the main database, WAL, and SHM files.
- Lock contention is retried separately from disk-full, permission, and ordinary I/O failures, which are returned to the caller unchanged.
- Branch-scoped full-text search now filters to the requested lineage before pagination, including maximum-offset queries.
- Corruption quarantine now moves WAL/SHM before the main database, durably recovers interrupted moves, and avoids mode-changing writes for established recovery guards.
