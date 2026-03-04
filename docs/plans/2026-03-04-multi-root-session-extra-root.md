# Multi-Root Session (`--extra-root`) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow one `omp` session to work across multiple repository roots by adding repeatable `--extra-root` CLI support and path resolution across those roots.

**Architecture:** Add a new repeatable CLI flag (`--extra-root`) and propagate resolved extra roots into session/tool context. Extend path resolution to support explicit root aliases (`@<root-name>/...`) in addition to existing absolute/relative behavior. Keep backward compatibility by making extra roots optional everywhere.

**Tech Stack:** TypeScript, Bun tests, existing CLI parser (`parseArgs`), tool path resolution utilities.

---

### Task 1: Add failing tests for CLI and path resolution

**Files:**
- Create: `packages/coding-agent/test/cli/args-extra-root.test.ts`
- Create: `packages/coding-agent/test/tools/path-utils-extra-roots.test.ts`

1. Add tests proving repeated `--extra-root` is parsed into `Args.extraRoots`.
2. Add tests proving `resolveToCwd()` supports `@alias/path` when alias matches `basename(extraRoot)`.
3. Run only these tests and confirm they fail first.

### Task 2: Implement CLI plumbing and option propagation

**Files:**
- Modify: `packages/coding-agent/src/cli/args.ts`
- Modify: `packages/coding-agent/src/commands/launch.ts`
- Modify: `packages/coding-agent/src/main.ts`
- Modify: `packages/coding-agent/src/sdk.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`
- Modify: `packages/coding-agent/src/session/agent-session.ts`

1. Add `extraRoots?: string[]` to parsed args and session options.
2. Add repeatable `--extra-root` flag definition in root command help.
3. Normalize extra roots (absolute paths, existing directories, de-dup) in `buildSessionOptions`.
4. Pass extra roots into tool/session context.

### Task 3: Implement path resolution support for extra roots

**Files:**
- Modify: `packages/coding-agent/src/tools/path-utils.ts`
- Modify call sites that resolve user-supplied paths:
  - `packages/coding-agent/src/tools/{read,find,grep,ast-grep,ast-edit,bash,python,notebook}.ts`
  - `packages/coding-agent/src/session/agent-session.ts`
  - `packages/coding-agent/src/lsp/index.ts`

1. Extend `resolveToCwd(filePath, cwd, extraRoots?)`.
2. Support explicit syntax: `@<alias>/relative/path`.
3. Keep old absolute/relative behavior unchanged.

### Task 4: Verify end-to-end and document usage in help examples

**Files:**
- Modify (if needed): `packages/coding-agent/src/commands/launch.ts` examples

1. Run focused tests for new/changed areas.
2. Run a broader `packages/coding-agent` test subset if fast enough.
3. Validate CLI help includes `--extra-root`.
4. Ensure no regression in default single-root behavior.
