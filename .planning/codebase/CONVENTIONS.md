# Coding Conventions

**Analysis Date:** 2026-03-02

## Naming Patterns

**Files:**
- Use kebab-case for source files and directories (examples: `packages/coding-agent/src/config/settings-schema.ts`, `packages/tui/src/terminal-capabilities.ts`, `packages/coding-agent/test/tools/web-search-gemini.test.ts`).
- Use `.test.ts` for executable tests (examples in `packages/ai/test/*.test.ts`, `packages/coding-agent/test/**/*.test.ts`).

**Functions:**
- Use camelCase for functions and methods (examples: `packages/coding-agent/src/main.ts` (`resolveSessionMatch`, `buildSessionOptions`), `packages/tui/src/tui.ts` (`requestRender`, `#compositeOverlays`), `packages/ai/src/api-registry.ts` (`registerCustomApi`)).

**Variables:**
- Use camelCase for locals/fields and UPPER_SNAKE_CASE for constants (examples: `packages/tui/src/tui.ts` (`SEGMENT_RESET`, `#previousLines`), `packages/ai/src/api-registry.ts` (`BUILTIN_APIS`), `packages/coding-agent/src/config/settings.ts` (`SETTING_HOOKS`)).

**Types:**
- Use PascalCase for interfaces/classes/types (examples: `Settings`, `SettingsOptions` in `packages/coding-agent/src/config/settings.ts`; `OverlayOptions` and `Component` in `packages/tui/src/tui.ts`; `RegisteredCustomApi` in `packages/ai/src/api-registry.ts`).

## Code Style

**Formatting (enforced):**
- Formatter is Biome (`biome.json`) with:
  - `indentStyle: "tab"`
  - `indentWidth: 3`
  - `lineWidth: 120`
  - JS formatter: `semicolons: "always"`, `quoteStyle: "double"`, `trailingCommas: "all"`.
- Check/fix commands are wired in root `package.json` scripts (`check:ts`, `fmt:ts`, `fix:ts`).

**Linting (enforced):**
- Lint engine is Biome (`biome.json`) with `recommended: true` and targeted overrides (`noExplicitAny: off`, `useConst: error`, etc.).
- Type checking is strict TS (`tsconfig.base.json`: `"strict": true`) and executed via `tsgo` scripts in root/package `package.json` files.

**Informal style conventions (observed repeatedly):**
- Prefer ES private fields (`#field`) over TypeScript `private/protected/public` in classes (see `packages/coding-agent/src/config/settings.ts`, `packages/tui/src/tui.ts`; reinforced in `AGENTS.md`).
- Use visual section separators and focused block comments for large modules (for example `packages/coding-agent/src/config/settings.ts`).

## Import Organization

**Observed order pattern (not hard-enforced by config, but consistent):**
1. Node built-ins (`node:fs`, `node:path`, etc.)
2. Workspace/external packages (`@oh-my-pi/*`, `chalk`, `winston`, `bun`)
3. Relative internal imports (`./...`, `../...`)

Examples: `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/config/settings.ts`, `packages/tui/src/tui.ts`.

**Path Aliases:**
- Workspace aliases are configured in `tsconfig.base.json` (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-coding-agent/*`, `@oh-my-pi/pi-utils`, etc.).

## Error Handling

**Patterns:**
- Validate invariants early and throw explicit `Error` messages at API boundaries (example: `packages/coding-agent/src/tools/submit-result.ts`).
- For optional/fallback flows, catch and return safe defaults rather than propagating (examples: `checkForNewVersion` and `readPipedInput` in `packages/coding-agent/src/main.ts`; `#loadYaml` in `packages/coding-agent/src/config/settings.ts`).
- Convert unknown errors to user-safe strings using `error instanceof Error ? error.message : String(error)` (seen in `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/tools/submit-result.ts`).

## Logging

**Framework:**
- Shared logger module in `packages/utils/src/logger.ts` using `winston` + `winston-daily-rotate-file`.
- Exported as `logger` namespace via `packages/utils/src/index.ts`.

**Patterns:**
- Use structured context objects with log calls (`logger.warn("...", { key: value })`) as seen in `packages/coding-agent/src/config/settings.ts`.
- Logging wrappers are failure-safe (`try/catch` around logger calls in `packages/utils/src/logger.ts`) to avoid crashing on logging failure.

## Comments

**When to Comment:**
- Add intent comments for non-trivial behavior, migration paths, renderer edge cases, and terminal control flow (`packages/tui/src/tui.ts`, `packages/coding-agent/src/config/settings.ts`).
- Avoid narrating obvious code; comments are mostly rationale-focused.

**JSDoc/TSDoc:**
- Heavily used on public APIs/types and critical internal helpers (`packages/tui/src/tui.ts`, `packages/coding-agent/src/main.ts`, `packages/ai/src/models.ts`).

## Function Design

**Size:**
- Modules can contain large orchestrator functions/classes, but logic is segmented into helper methods (`runRootCommand` in `packages/coding-agent/src/main.ts`, render pipeline methods in `packages/tui/src/tui.ts`).

**Parameters:**
- Typed option objects are preferred for complex call sites (examples: `TestSessionOptions` in `packages/coding-agent/test/utilities.ts`, `OverlayOptions` in `packages/tui/src/tui.ts`).

**Return Values:**
- Prefer explicit typed return objects for multi-value returns (examples: `prepareInitialMessage` in `packages/coding-agent/src/main.ts`, layout result object in `packages/tui/src/tui.ts`).

## Module Design

**Exports:**
- Monorepo packages expose barrel files with explicit re-exports (`packages/utils/src/index.ts`, `packages/ai/src/index.ts`, `packages/coding-agent/src/index.ts`).

**Barrel Files:**
- Barrels are actively used for package public surface; when adding public API, add exports in the package `src/index.ts` and keep internal modules private by default.

---

*Convention analysis: 2026-03-02*