# Deno Porting Notes

## Status

Runtime: all core polyfills verified working on Deno 2.7.11.
Type checking: ~37 residual errors in pi-ai (mostly `Timeout` vs `number`, `unknown` from parsers,
`Headers.entries()`). These do not affect runtime behavior.

## What to upstream to bun-compat

### Bugs / missing features discovered during integration

1. **`Bun.hash` is not callable**
   `install.ts` exports `hash` as a plain object `{ xxHash64, wyhash }`, but Bun's `Bun.hash()`
   is directly callable as a function (returns a number/string). Need to wrap the object in a
   callable function that delegates to `xxHash64`.

2. **`Bun.Glob.scan()` returns `Promise<string[]>`, not `AsyncIterable<string>`**
   Bun's native `Glob.scan()` returns an async iterable usable with `for await`. The compat
   version only returns a promise of an array. Should return an object that is both
   thenable and async-iterable.

3. **`Bun.serve()` request object is recreated per-request**
   The `BunServerImpl` in `serve.ts` is instantiated fresh on each request, so any state
   stored on the server object is lost. Should create a single server instance.

4. **`Bun.write()` does not support `Blob`, `ReadableStream`, or `Response`**
   Only handles `string` and `Uint8Array`. Bun natively supports all of these as input types.

5. **`Bun.password` uses PBKDF2 for all algorithms**
   Output is incompatible with real bcrypt/argon2. This is acceptable for non-security contexts
   (testing) but should be documented clearly.

6. **`Bun.hash.wyhash` is aliased to xxHash64**
   Produces different output than real Bun's wyhash. Will cause cache key mismatches.

### New modules to contribute

7. **`Bun.listen()` / `Bun.connect()` polyfill** (`deno/compat/socket.ts`)
   Wraps `Deno.listen()` and `Deno.connect()` to match Bun's socket handler API
   (`open`, `data`, `close`, `error` callbacks). Supports both TCP and Unix domain sockets.
   Returns socket objects with `write()`, `flush()`, `end()`, `reload()` methods.

8. **`Bun.Archive` polyfill** (`deno/compat/archive.ts`)
   Pure-JS tar + gzip read/write using `node:zlib`. Supports:
   - `new Archive(bytes)` + `archive.files()` for reading
   - `Archive.write(path, entries, { compress: "gzip" })` for writing
     Works with the same API shape as Bun's native Archive.

### Type declarations

9. **Global type declarations** (`deno/compat/bun.d.ts`)
   Comprehensive `.d.ts` covering `Bun` global, `BunFile`, `BunSubprocess` (with generics),
   `BunSpawnOptions` (with generics), `BunServer`, `Buffer`, `Timer`/setTimeout overrides,
   and all parser types. Could be published as `@lu-zero/bun-compat/types`.

## Known Deno-specific gaps (not bun-compat issues)

| Gap                                         | Files affected       | Status / Notes                                  |
| ------------------------------------------- | -------------------- | ----------------------------------------------- |
| `import.meta.dir` → `import.meta.dirname`   | 3 source files       | Done — migrated to `import.meta.dirname!`       |
| `Bun.Socket` / `Bun.listen` / `Bun.connect` | 1 file (DAP client)  | Done — polyfill in `deno/compat/socket.ts`      |
| `Bun.build()`                               | 1 file (stats build) | Use esbuild/rollup or `Deno.emit()`             |
| `setTimeout` returns `Timeout` not `number` | ~17 type errors      | Runtime works; type-only issue                  |
| pi-natives (N-API addon)                    | 20+ modules          | Needs `deno_bindgen` or FFI bridge              |
| `bun:test`                                  | All test files       | Needs Deno test adapter or migration            |
| `Headers.entries()`                         | 2 files              | Deno Headers may need `Object.entries(headers)` |

## Running under Deno

```bash
# Bootstrap the Bun global shim and run the CLI
deno run --allow-all --unstable-raw-imports \
  deno/compat/bootstrap.ts \
  packages/coding-agent/src/cli.ts

# Type check
deno check --unstable-raw-imports packages/utils/src/index.ts
```

The `--unstable-raw-imports` flag is required for `import ... with { type: "text" }`
(136+ sites importing .md/.py prompt templates).
