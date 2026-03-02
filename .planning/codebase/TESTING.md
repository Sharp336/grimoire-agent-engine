# Testing Patterns

**Analysis Date:** 2026-03-02

## Test Framework

**Runner:**
- Bun test runner via `bun:test` imports across packages (examples: `packages/coding-agent/test/tools/web-search-gemini.test.ts`, `packages/ai/test/auth-storage-codex-selection.test.ts`, `packages/tui/test/render-regressions.test.ts`).
- Config: no dedicated `vitest.config.*`/`jest.config.*` detected; test execution is script-driven from each package `package.json`.

**Assertion Library:**
- Bun `expect` matcher API from `bun:test`.

**Run Commands:**
```bash
bun test                                                     # Package-level default in most packages
bun --cwd=packages/coding-agent run test                    # coding-agent test suite
bun --cwd=packages/ai run test                              # ai test suite
bun --cwd=packages/tui run test                             # tui tests (`test/*.test.ts` only)
bun --cwd=packages/natives run test                         # natives tests (includes native build)
```

## Test File Organization

**Location:**
- Tests are separated from source in package-local `test/` directories (examples: `packages/coding-agent/test`, `packages/ai/test`, `packages/tui/test`, `packages/utils/test`, `packages/agent/test`).

**Naming:**
- Primary executable test pattern is `*.test.ts`.
- Helper/support files live alongside tests without `.test.ts` (examples: `packages/coding-agent/test/utilities.ts`, `packages/tui/test/virtual-terminal.ts`, `packages/ai/test/oauth.ts`).

**Structure:**
```text
packages/<pkg>/
├── src/**
└── test/**            # tests + shared fixtures/helpers for that package
```

## Test Structure

**Suite Organization:**
```typescript
describe("feature area", () => {
   beforeEach(() => { ... });
   afterEach(() => { ... });

   it("handles scenario", async () => {
      // arrange
      // act
      // assert
      expect(result).toBe(...);
   });
});
```
Pattern examples: `packages/coding-agent/test/tools/web-search-gemini.test.ts`, `packages/tui/test/render-regressions.test.ts`.

**Patterns:**
- Setup/teardown commonly manages temp dirs, env vars, and global mocks (`beforeEach`/`afterEach`) in `packages/coding-agent/test/**/*.test.ts` and `packages/ai/test/**/*.test.ts`.
- Async assertions use `await` with direct result checks rather than callback-based completion.
- Tests isolate state aggressively with helper resets like `_resetSettingsForTest()` (`packages/coding-agent/test/config-cli.test.ts`).

## Mocking

**Framework:**
- Bun mock APIs from `bun:test`: `vi`, `mock`, `vi.spyOn`, `vi.restoreAllMocks`.

**Patterns:**
```typescript
beforeEach(() => {
   vi.spyOn(AgentStorage, "open").mockResolvedValue(...);
   globalThis.fetch = mock(async (...) => new Response(...));
});

afterEach(() => {
   vi.restoreAllMocks();
   globalThis.fetch = originalFetch;
});
```
Observed in `packages/coding-agent/test/tools/web-search-gemini.test.ts` and many `packages/ai/test/*.test.ts` files.

**What to Mock:**
- Network boundaries (`fetch`, provider HTTP calls)
- Filesystem/process boundaries for focused unit tests
- Provider/model registries and auth stores where ranking/selection logic is under test (`packages/ai/test/auth-storage-codex-selection.test.ts`)

**What NOT to Mock (when doing integration/e2e):**
- Real provider APIs in gated suites using `describe.skipIf(!e2eApiKey(...))` (`packages/ai/test/stream.test.ts`, `packages/ai/test/total-tokens.test.ts`)
- Local model servers (Ollama/LM Studio/llama.cpp) when present and probed (`packages/ai/test/context-overflow.test.ts`, `packages/ai/test/stream.test.ts`).

## Fixtures and Factories

**Test Data:**
```typescript
const ctx = await createTestSession({ systemPrompt: "..." });
const ids = buildTestTree(ctx.sessionManager, { messages: [...] });
```
Fixture/factory patterns are centralized in `packages/coding-agent/test/utilities.ts`.

**Location:**
- Reusable helpers: `packages/coding-agent/test/utilities.ts`
- Dedicated fixture dirs for assets/samples: `packages/coding-agent/test/fixtures`, `packages/ai/test/data`.

## Coverage

**Requirements:**
- No explicit coverage threshold or coverage script detected in workspace `package.json` files.

**View Coverage:**
```bash
Not configured via package scripts.
```

## Test Types

**Unit Tests:**
- Dominant style; deterministic, mock-heavy component/function tests across all packages.

**Integration Tests:**
- Present for cross-module workflows and process/terminal behavior (for example `packages/tui/test/render-regressions.test.ts`, `packages/coding-agent/test/core/*.test.ts`).

**E2E Tests:**
- Provider E2E tests exist and are environment-gated (`describe.skipIf`) in `packages/ai/test/*`.

## Common Patterns

**Async Testing:**
```typescript
it("returns api key for best-ranked account", async () => {
   const apiKey = await authStorage.getApiKey("openai-codex", "session-id");
   expect(apiKey).toBe("api-acct-near");
});
```
Pattern from `packages/ai/test/auth-storage-codex-selection.test.ts`.

**Error Testing:**
```typescript
if (!authStorage) throw new Error("test setup failed");
await expect(loginFlow()).rejects.toThrow("...");
```
Seen in `packages/ai/test/*oauth*.test.ts` and defensive setup checks in ranking suites.

## Gaps and Inconsistencies (Observed)

- Root `test` script in `package.json` runs `ai`, `agent`, `tui`, `natives`, `coding-agent` but omits `packages/utils` and `packages/react-edit-benchmark` tests despite those packages having test files.
- `packages/tui/package.json` uses `bun test test/*.test.ts`, so non-matching files under `packages/tui/test/` are not part of the default run.
- Coverage reporting/threshold enforcement is not wired; regression detection depends on direct test assertions and CI command selection.

---

*Testing analysis: 2026-03-02*