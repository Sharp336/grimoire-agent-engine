# LSP Shutdown — Async Completion Gate

**Issue:** [#860](https://github.com/can1357/oh-my-pi/issues/860)
**Date:** 2026-04-28
**Status:** Recommended fix implemented

## Problem

`shutdownAll()` in `packages/coding-agent/src/lsp/client.ts` spawns fire-and-forget async IIFEs to gracefully shut down each LSP child process (send `shutdown` request, wait up to 5 s, then `proc.kill()`). However, the `SIGINT`/`SIGTERM` signal handlers call `process.exit(0)` synchronously right after `shutdownAll()`, which kills the Node/Bun event loop before those IIFEs complete. Result: LSP child processes are orphaned.

```typescript
// BEFORE — fire-and-forget
export function shutdownAll(): void {
    // ...
    void (async () => {
        const timeout = Bun.sleep(5_000);
        const result = sendRequest(client, "shutdown", null).catch(() => {});
        await Promise.race([result, timeout]);
        client.proc.kill();       // ← never reached
    })().catch(() => {});
}

process.on("SIGINT", () => {
    shutdownAll();   // returns immediately
    process.exit(0); // kills event loop → IIFEs abandoned
});
```

### Impact

- On every Ctrl-C or `kill`, LSP server child processes (clangd, rust-analyzer, typescript-language-server, etc.) survive the parent exit.
- Orphaned processes accumulate over repeated runs, consuming memory and potentially holding file locks.
- Platform-agnostic: affects macOS, Linux, and Windows (Bun).

## Fix Options

### Option A: Async `shutdownAll` with `Promise.allSettled` (Recommended)

Make `shutdownAll()` async, collect all shutdown promises, await them with `Promise.allSettled`, and make the signal handlers async so `process.exit(0)` runs only after all children are killed or timed out.

**Pros:**
- Minimal change (10 lines modified).
- Preserves the existing 5-second per-server timeout.
- `Promise.allSettled` ensures one slow server doesn't block others.
- Async signal handlers are safe in Bun and Node 16+.
- The `beforeExit` handler needs no change — Node ignores the returned promise and the event loop stays alive.

**Cons:**
- Signal delivery is slightly delayed (up to 5 s worst-case) while children drain.

### Option B: `process.on('exit')` hook with synchronous kill

Move cleanup into a `process.on('exit')` handler that iterates the client map and calls `proc.kill()` synchronously, without sending the LSP `shutdown` request.

**Pros:**
- Guaranteed to run before the process exits.
- Zero async dependency.

**Cons:**
- No graceful shutdown — servers receive no `shutdown` request, so they can't flush state or clean up temp files.
- `process.on('exit')` cannot do async work; the `sendRequest` call must be dropped.
- Loss of the 5-second timeout grace period.

### Option C: Detach child processes (`detached: true` + `unref()`)

Spawn LSP servers in a detached process group so they survive the parent exit, and rely on the OS or an external supervisor to reap them.

**Pros:**
- Parent exit is instant; no waiting.

**Cons:**
- Orphans the problem rather than solving it — children still run unmanaged.
- Requires an external reaping mechanism (pidfile, cgroup, systemd scope).
- Increases complexity for no user-visible benefit.

## Recommendation

**Option A** is the best balance of correctness, simplicity, and backward compatibility. It requires the smallest diff, keeps the graceful shutdown protocol intact, and is safe on all supported runtimes.

## Chosen Fix

### 1. `shutdownAll()` becomes async

```typescript
export async function shutdownAll(): Promise<void> {
    const clientsToShutdown = Array.from(clients.values());
    clients.clear();
    const err = new Error("LSP client shutdown");
    const shutdownPromises: Promise<void>[] = [];

    for (const client of clientsToShutdown) {
        const reqs = Array.from(client.pendingRequests.values());
        client.pendingRequests.clear();
        for (const pending of reqs) {
            pending.reject(err);
        }
        shutdownPromises.push(
            (async () => {
                const timeout = Bun.sleep(5_000);
                const result = sendRequest(client, "shutdown", null).catch(() => {});
                await Promise.race([result, timeout]);
                client.proc.kill();
            })()
        );
    }

    await Promise.allSettled(shutdownPromises);
}
```

### 2. Signal handlers await before exit

```typescript
process.on("SIGINT", async () => {
    await shutdownAll();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    await shutdownAll();
    process.exit(0);
});
```

### 3. `beforeExit` handler unchanged

The `beforeExit` event does not call `process.exit()`, so the event loop stays alive long enough for the returned promise to settle. Node silently ignores the returned promise from `beforeExit` handlers — this is safe.

## Regression Test

A new test file at `packages/coding-agent/src/lsp/__tests__/shutdown.test.ts` verifies that `proc.kill()` is called on every mock LSP client after `shutdownAll()` resolves. Mock clients are injected via a `_resetClientsForTest()` / `_injectClientForTest()` test helper added to `client.ts`.

## References

- [Node.js signal handling docs](https://nodejs.org/api/process.html#process_signal_events)
- [Promise.allSettled spec](https://tc39.es/ecma262/#sec-promise.allsettled)
- Issue [#860](https://github.com/can1357/oh-my-pi/issues/860)
