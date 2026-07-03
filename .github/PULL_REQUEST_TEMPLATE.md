
Remove Windows staging mechanism; lazy-load theme in update path

- Delete `shouldStageNodeModulesAddon`/`maybeStageNodeModulesAddon`, `stageFromNodeModules` parameter, and staging branches from `loader-state.js` + `loader-state.d.ts`
- Replace static `import { theme }` with dynamic `import()` in `update-cli.ts`; make `printVerifiedVersion` async
- Remove `initTheme` import/call from `commands/update.ts`
- Add `checkOtherOmpProcesses()` to warn on Windows file-lock risk
- Update tests (`windows-staging.test.ts`, `issue-823-repro.test.ts`)
- Sync `docs/natives-addon-loader-runtime.md`

## What

Three changes to the update path:

1. **Remove Windows staging mechanism** — `shouldStageNodeModulesAddon` and `maybeStageNodeModulesAddon` copied `.node` files from `node_modules` to `~/.omp/natives/<version>/` at startup to work around Windows file-locks during `bun install -g`. Removed along with the `stageFromNodeModules` parameter in `resolveLoaderCandidates` and all staging branches. `cleanupStaleNativeVersions` is kept (still used by compiled-binary mode).

2. **Lazy-load theme in update path** — `update-cli.ts` had a static `import { theme }` which transitively triggered `loadNative()` via `@oh-my-pi/pi-natives`. Neither `printVerifiedVersion()` nor `runUpdateCommand()` actually call any native function through the theme — the import was purely for `theme.status.success` display. Changed to `await import("../modes/theme/theme")` inside the async functions. Also removed `initTheme` import and `await initTheme()` from `commands/update.ts`.

3. **Windows process detection warning** — Added `checkOtherOmpProcesses()` which runs `tasklist` on Windows to detect other running `omp.exe` instances before updating. Replaces the old silent workaround with a user-facing warning.

## Why

- The staging mechanism added startup-time I/O and complexity for a problem better solved by asking the user to close other omp processes during update.
- Loading pi-natives during `omp update` was unnecessary — none of the theme APIs called in the update path touch native functions — and added a failure point (a missing or mismatched `.node` binary could break update even though update doesn't need it).
- A warning is simpler, more transparent, and avoids the file-lock problem at the right layer (update time, not load time).

## Testing

- `packages/natives` test suite: `windows-staging.test.ts` 2/2 pass, `issue-823-repro.test.ts` 6/6 pass
- `native.test.ts` failure is pre-existing (no `.node` built in dev checkout — same failure on `main`)
- `bun check` requires `node_modules` (biome, bun types) not installed in this checkout — pre-existing dev environment issue, not caused by these changes

---

- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated (if user-facing)
