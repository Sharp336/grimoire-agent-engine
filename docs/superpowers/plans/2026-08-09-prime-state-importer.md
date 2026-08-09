# Prime State Importer Implementation Plan

> Required workflow: execute each task with a fresh implementation worker, then spec review, then code-quality review. The parent session owns commits.

**Goal:** Add `omp import prime` as a one-time, dry-run-first migration from Prime Agent state into OMP-owned stores without starting Prime, mutating source bytes, overwriting destination data, executing source credential references, or reactivating runtime state.

**Architecture:** A pure Prime reader creates a versioned snapshot and normalized operations. A planner validates create-only destination preconditions and emits one stable report. `--apply` stages and validates every candidate before committing per-item atomic additions through OMP APIs. OMP does not have a cross-filesystem/SQLite transaction, so the command reports truthful `partialApply` state and writes a rollback manifest containing only importer-created artifacts and precondition digests; it never restores an old whole-file snapshot over concurrent user data.

**Source contract:** Prime defaults to `~/.prime/agent`; files include `settings.json`, project `.prime/agent/settings.json`, `models.json`, `auth.json`, legacy `oauth.json`, user/project skill directories, current/legacy session JSONL, and per-session artifacts. Prime startup migrations are forbidden because they mutate source. OAuth, command/env references, kernel dill, schedules, leases, heartbeat control state, harness state, and live RLM topology are reported but never activated.

**Destination contract:** OMP settings use typed `Settings`; models use `models.yml` validated by `ModelsConfigFile` and `ModelRegistry`; credentials use `AuthStorage`/SQLite; skills live at `<agentDir>/skills`; sessions use `SessionManager` plus generic foreign-session provenance; blobs use `BlobStore`. Existing values always win.

**Commands:** Run focused tests from `packages/coding-agent` or `packages/ai` as required. After every code phase run repository-root `bun check`. Never run broad test suites.

---

## Task 1: Define importer contracts and immutable source discovery

**Files (maximum five):**
- Create `packages/coding-agent/src/import/prime/types.ts`
- Create `packages/coding-agent/src/import/prime/source.ts`
- Create `packages/coding-agent/test/prime-import-source.test.ts`

**Red:** Add fixtures in the test itself for explicit `agentDir`, project cwd, current session root, legacy root/nested sessions, and excluded runtime files. Assert dry discovery records canonical path, file type, mode, size, mtime, and SHA-256; catches source mutation between plan/apply; reports malformed/unreadable/symlink items; never creates Prime directories or calls Prime migrations.

**Green:**
- Define schema version `1` contracts for domains, stable loss codes, source records, normalized operations, item outcomes, `PrimeImportPlan`, `PrimeImportReport`, and rollback manifest entries.
- Implement pure discovery accepting explicit `{sourceRoot,cwd,sessionRoot?,primeCliConfigPath?}`. Defaults may be computed by the CLI later; the reader itself takes resolved paths.
- Scan Prime global/project settings, models/auth/legacy auth, global/project skills, current and both legacy session layouts, session artifacts, and excluded state.
- Read regular files into bounded immutable snapshots. Do not follow external symlinks. Hash source before/after and expose a revalidation method used immediately before apply.
- Redact credential values from serializable report types by construction.

**Verify:** `bun test test/prime-import-source.test.ts`; repository-root `bun check`.

## Task 2: Parse and map settings, models, and credentials without side effects

**Files:**
- Create `packages/coding-agent/src/import/prime/config-parser.ts`
- Create `packages/coding-agent/test/prime-import-config-parser.test.ts`
- Update `packages/coding-agent/src/import/prime/types.ts`

**Red:** Cover strict global/project settings precedence and Prime's in-memory legacy migrations; comments/trailing commas in `models.json`; recognized model fields and typed unsupported compat/routing losses; literal API keys; `!command` refs; env-or-literal ambiguity; OAuth/re-login; legacy oauth/settings credentials; malformed input; unknown fields; secret-free serialized reports.

**Green:**
- Parse settings as strict JSON and map only explicitly enumerated OMP equivalents. Project values override global values with Prime's one-level nested merge. Prime-only or unknown fields become stable losses.
- Parse Prime model JSON with comment/trailing-comma behavior matching Prime without executing config values. Normalize only destination-representable provider/model fields and preserve `thinkingLevelMap` semantics where OMP supports them. Unsupported compat becomes loss, never guessed.
- Classify auth into `literal_api_key`, `env_or_literal_ref`, `command_ref`, `oauth_relogin`, `ambient_dependency`, or `unknown`. Never execute shell, read referenced env values, or serialize secrets into reports.
- Keep source credentials in an in-memory apply-only secret table keyed by opaque operation IDs.

**Verify:** `bun test test/prime-import-config-parser.test.ts`; repository-root `bun check`.

## Task 3: Parse skills and Prime session trees safely

**Files:**
- Create `packages/coding-agent/src/import/prime/skill-parser.ts`
- Create `packages/coding-agent/src/import/prime/session-parser.ts`
- Create `packages/coding-agent/test/prime-import-skill-parser.test.ts`
- Create `packages/coding-agent/test/prime-import-session-parser.test.ts`
- Update `packages/coding-agent/src/import/prime/types.ts`

**Red:** Skills: whole directory payload, invalid frontmatter, duplicate precedence, ignored files, internal symlink, external symlink, Python package payload. Sessions: v3 tree with branches, model/thinking/service changes, compaction/branch summary, user/assistant/tool result content, tool-call pairing, custom records, RLM child transcripts, v1/v2 pure migration, broken parent/tool IDs, duplicate IDs, malformed middle/truncated tail, CRLF and Unicode separators, excluded kernel/schedule/lease/runtime artifacts.

**Green:**
- Inventory candidate skill directories without executing skills. Reject external symlinks and special files. Preserve accepted regular-file bytes and relative modes. Validate staged content later with OMP `loadSkillsFromDir`.
- Parse JSONL by LF byte boundaries and report line/byte diagnostics rather than silently skipping malformed records.
- Perform Prime v1→v2→v3 migration in memory only; preserve physical entry order, IDs, parent IDs, timestamps, branches, and supported message/tool content.
- Convert only representable OMP session entries. Ledger opaque custom records, unmatched tool calls/results, broken parents, old header extras, missing full-output files, kernel snapshots, schedule/heartbeat state, lease state, harness state, and live RLM topology.
- Treat valid child transcripts as independent sessions with lineage metadata; do not reactivate child status.

**Verify:** both focused test files; repository-root `bun check`.

## Task 4: Add race-free generic destination primitives

**Files (AI phase):**
- Update `packages/ai/src/auth-storage.ts`
- Update `packages/ai/src/auth/sqlite-credential-store.ts`
- Create `packages/ai/test/auth-storage-insert-if-absent.test.ts`

**Red:** Race two create-only inserts for one provider and prove exactly one wins; seed a destination credential and prove it remains byte-for-byte/logically unchanged; close/reopen SQLite and recheck.

**Green:** Add `AuthStorage.insertCredentialsIfProviderAbsent(provider, credentials)` backed by one SQLite transaction/conditional operation. Return existing public metadata without replacing or merging existing credentials. Do not expose secrets in diagnostics.

**Verify:** focused AI test; repository-root `bun check`.

**Files (coding-agent phase):**
- Update `packages/coding-agent/src/session/foreign-session-store.ts`
- Update `packages/coding-agent/src/session/foreign-session-import.ts`
- Update `packages/coding-agent/test/foreign-session-stores.test.ts`

**Red:** Persist a converted source with `source: 'prime'`, reopen it, and prove fresh OMP identity plus exact provenance while Claude/Codex interactive source selection remains unchanged.

**Green:** Separate generic string-based `ForeignSessionProvenance`/`persistConvertedSession` from the closed interactive `ForeignSessionSource` selector. Existing Claude/Codex behavior remains unchanged; Prime bulk import uses the generic seam.

**Verify:** `bun test test/foreign-session-stores.test.ts`; repository-root `bun check`.

## Task 5: Build destination planning and staged create-only apply

**Files:**
- Create `packages/coding-agent/src/import/prime/destination.ts`
- Create `packages/coding-agent/test/prime-import-destination.test.ts`
- Update `packages/coding-agent/src/import/prime/types.ts`

**Red:** Snapshot all destination bytes/rows, run dry-run, assert exact equality. Apply into seeded settings/models/auth/skills conflicts and prove existing values win. Cover staged validation failure with zero commits, source digest drift, invalid skill, model schema failure, API-key race, duplicate rerun, and stable loss/item ordering.

**Green:**
- Plan typed setting setters only; unknown mappings remain losses. Use `Settings.loadReadOnly` for preflight and native locked `Settings.set`/`flush` for apply.
- Merge only absent model/provider/model-id keys, reject conflicting leaves, stage `models.yml`, validate with relocated `ModelsConfigFile` and explicit-path `ModelRegistry`, then atomically publish.
- Validate copied skill staging root with `loadSkillsFromDir`, then rename each non-conflicting directory create-only. Never merge skill directories.
- Insert only explicitly classified literal API keys through the new race-free auth API. OAuth and references remain skipped/re-login outcomes.
- Revalidate all source digests and destination preconditions immediately before commit.
- Keep output deterministically sorted and credential-redacted.

**Verify:** `bun test test/prime-import-destination.test.ts`; repository-root `bun check`.

## Task 6: Persist converted sessions, blobs, and rollback manifest

**Files:**
- Create `packages/coding-agent/src/import/prime/session-import.ts`
- Create `packages/coding-agent/src/import/prime/apply.ts`
- Create `packages/coding-agent/test/prime-import-apply.test.ts`
- Update `packages/coding-agent/src/import/prime/types.ts`

**Red:** Import branched sessions and inline image bytes into a temporary agent directory, reopen with `SessionManager.open`, compare header/tree/roles/text/tool IDs/title/provenance, verify CAS bytes and fresh OMP ID, then simulate a mid-apply failure and assert truthful `partialApply`, exact committed item IDs, no source changes, and rollback manifest contents. Rerun must be idempotent.

**Green:**
- Build nonpersistent `SessionManager` instances with `ingestReplicatedEntry`, persist via generic `persistConvertedSession`, then close/reopen and verify entry count/tree/provenance.
- Re-hash raw image bytes into OMP `BlobStore`; use only returned `blob:sha256:` refs. Never trust Prime filenames/hashes or deserialize dill.
- Stage and validate all candidates before apply. Commit monotonic create-only items. Stop on failure and report exact committed items.
- Write an OMP-owned versioned rollback manifest atomically. It records importer-created paths/credential identities, prior absence or exact precondition digest, and source snapshot identity. It is not an automatic whole-store restore.
- Cleanup removes only importer-created staging and artifacts whose current digest still matches the manifest; CAS orphans are retained for GC.

**Verify:** `bun test test/prime-import-apply.test.ts`; repository-root `bun check`.

## Task 7: Wire `omp import prime` and prove end-to-end behavior

**Files (maximum five):**
- Create `packages/coding-agent/src/commands/import.ts`
- Create `packages/coding-agent/src/cli/prime-import-cli.ts`
- Update `packages/coding-agent/src/cli-commands.ts`
- Update `packages/coding-agent/src/cli/command-help.ts`
- Create `packages/coding-agent/test/prime-import-cli.test.ts`

**Red:** Invoke the command runner against temp source/destination. Assert default dry run, explicit `--apply`, JSON schema, human summary, unreadable-source exit behavior, ordinary typed-loss success behavior, no secret output, and rejected unknown source kind/flags. Existing command metadata test must continue to load all commands.

**Green:**
- Syntax: `omp import prime [--source <prime-home>] [--cwd <project>] [--session-root <dir>] [--prime-cli-config <file>] [--agent-dir <omp-home>] [--apply] [--json]`.
- Default is dry-run. There is no force/overwrite/live-sync mode.
- Use a thin command class and side-effect-free runner. Human output includes snapshot ID, destination paths, planned/imported/skipped/lost counts, loss table, OAuth re-login list, manifest path, and partial-apply state. JSON emits complete stable `PrimeImportReport`.
- Exit nonzero for unreadable/invalid source/destination or failed apply; ordinary typed losses/skips remain a successful audited migration.

**Verify:** focused CLI test and `bun test test/cli-command-metadata.test.ts`; repository-root `bun check`.

## Task 8: Documentation, changelog, full focused verification, and review

**Files:**
- Update `packages/coding-agent/CHANGELOG.md` under `[Unreleased]`
- Update the existing migration/user documentation location selected from repository conventions; do not add a second standalone guide if command help is sufficient.

**Work:** Document dry-run/apply behavior, exact supported domains, no-overwrite rule, OAuth re-login, excluded runtime state, source immutability, partial-apply semantics, and rollback manifest limits. Remove stale scaffolding/comments.

**Verify:** Run every importer-focused test named above, then repository-root `bun check`. Run the installed/source CLI against an inert temp Prime fixture as the smoke test and compare source/destination digests. Request final spec review and final code-quality/security review. Do not merge automatically.
