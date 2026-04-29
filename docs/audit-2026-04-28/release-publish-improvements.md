# Release-Publish Improvements

**Date:** 2026-04-28
**Scope:** `scripts/ci-release-publish.ts`
**Issues:** #856, #857

---

## Finding 1: Hardcoded Package List (#856)

### Problem

The CI release-publish script maintains a hardcoded array of package directories:

```typescript
const packageDirs: PublishPackage[] = [
    { dir: "packages/utils" },
    { dir: "packages/ai" },
    { dir: "packages/natives" },
    { dir: "packages/tui" },
    { dir: "packages/stats" },
    { dir: "packages/agent" },
    { dir: "packages/coding-agent" },
];
```

This creates two failure modes:

1. **Stale list** -- When a new package is added to the workspace (e.g. `packages/swarm-extension`), it is silently omitted from CI publishing unless someone remembers to update this script. The repo currently has `packages/swarm-extension` as a non-private package that is missing from the hardcoded list.
2. **False inclusion** -- If a package is removed or made private, the stale entry either errors or is filtered at runtime by the `private` check in `publishPackage()`. This is handled but wasteful.

The root `package.json` already defines the canonical workspace list via `workspaces.packages`. The publish script should derive its targets from that source of truth.

### Fix Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A. Bun.Glob workspace introspection** | Read `package.json` workspaces field, resolve globs via `Bun.Glob`, filter private packages | Single source of truth, zero drift | Bun-specific API |
| **B. `bun publish --workspaces`** | Use Bun's built-in workspace-aware publish | Simplest command | Less control over ordering, dry-run behavior, error handling |
| **C. Keep hardcoded + CI guard** | Add a CI step that diffs the list against actual workspaces | Preserves explicit control | More moving parts, still requires maintenance |

### Recommendation

**Option A** -- Bun.Glob workspace introspection. The script already depends on Bun (`bun publish`, `Bun.file`), so using `Bun.Glob` adds no new dependency. It eliminates drift entirely while preserving the script's current control flow (per-package publish, dry-run, error handling).

---

## Finding 2: Fragile Republish Detection (#857)

### Problem

The script detects already-published versions via substring matching against stdout/stderr:

```typescript
const alreadyPublishedPatterns = [
    "previously published",
    "cannot publish over",
    "You cannot publish over",
];

function isAlreadyPublished(output: string): boolean {
    return alreadyPublishedPatterns.some((pattern) => output.includes(pattern));
}
```

This is fragile for several reasons:

1. **Message drift** -- If Bun changes its error messages (capitalization, wording, localization), the patterns silently stop matching and CI fails on republish.
2. **Incomplete coverage** -- Only three patterns are listed. Bun's npm-compatible error messages may vary.
3. **Risky exit behavior** -- The fallback `process.exit(result.exitCode ?? 1)` means any unrecognized republish error crashes CI.

Bun 1.1+ provides a built-in `--tolerate-republish` flag that exits with code 0 when the package version already exists. This is exactly the semantic the script needs.

### Fix Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A. `--tolerate-republish` flag** | Add flag to `bun publish`, remove all substring matching | Built-in, maintained by Bun, zero drift | Requires Bun 1.1+ (already in use) |
| **B. Expand pattern list** | Add more patterns, possibly regex | Works without flag | Still fragile, more patterns to maintain |
| **C. Check npm registry first** | Pre-query the registry for existing version | Deterministic | Extra network call, more complex |

### Recommendation

**Option A** -- `--tolerate-republish`. The flag is purpose-built for this use case, already supported in the Bun version this repo uses (`bun@1.3.12`), and eliminates the entire substring-matching mechanism. With the flag, already-published versions return exit code 0, so the error-handling path only needs to deal with genuine failures.

---

## Implementation Summary

Both fixes target `scripts/ci-release-publish.ts`:

1. **#856** -- Replace the hardcoded `packageDirs` array with workspace introspection: read `workspaces.packages` from root `package.json`, resolve via `Bun.Glob`, filter out `private: true` packages.
2. **#857** -- Add `--tolerate-republish` to the `bun publish` command, remove `alreadyPublishedPatterns` and `isAlreadyPublished()`, simplify error handling.
