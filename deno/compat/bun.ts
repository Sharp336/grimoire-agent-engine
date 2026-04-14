import "@lu-zero/bun-compat";

import {
  $,
  type BunFile,
  CryptoHasher,
  Database,
  type FFIType,
  Glob as BunCompatGlob,
  inspect,
  type JSCallback,
  JSON5,
  JSONC,
  JSONL,
  TOML,
  YAML,
  dlopen,
  env,
  file,
  fileURLToPath,
  gc,
  generateHeapSnapshot,
  hash,
  nanoseconds,
  password,
  pathToFileURL,
  ptr,
  serve,
  sleep,
  spawn,
  spawnSync,
  stdin,
  stringWidth,
  stripANSI,
  suffix,
  toArrayBuffer,
  which,
  wrapAnsi,
  write,
} from "@lu-zero/bun-compat/bun";

export {
  $,
  type BunFile,
  CryptoHasher,
  type Database,
  type FFIType,
  type JSCallback,
  JSON5,
  JSONC,
  JSONL,
  TOML,
  YAML,
  dlopen,
  env,
  file,
  fileURLToPath,
  gc,
  generateHeapSnapshot,
  hash,
  inspect,
  nanoseconds,
  password,
  pathToFileURL,
  ptr,
  serve,
  sleep,
  spawn,
  spawnSync,
  stdin,
  stringWidth,
  stripANSI,
  suffix,
  toArrayBuffer,
  which,
  wrapAnsi,
  write,
};

export interface Subprocess {
  pid: number;
  stdin: WritableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: string | number): void;
}

export type Spawn = typeof spawn;
export type BunWhichOptions = { cwd?: string; PATH?: string };

export { defineEnum, defineStruct } from "@lu-zero/bun-compat/ffi-structs";

import { Archive } from "./archive.ts";

class Glob extends BunCompatGlob {
  override scan(
    options?: Record<string, unknown>,
  ): AsyncIterable<string> & Promise<string[]> {
    const result = BunCompatGlob.prototype.scan.call(
      this,
      options as Parameters<typeof BunCompatGlob.prototype.scan>[0],
    );
    const iter: AsyncIterable<string> = {
      [Symbol.asyncIterator]: async function* () {
        const entries = await result;
        for (const entry of entries) {
          yield entry;
        }
      },
    };
    return Object.assign(result, iter);
  }
}

export { Glob };

const _g = globalThis as Record<string, unknown>;
if (
  _g.Bun &&
  typeof _g.Bun === "object" &&
  !("Archive" in (_g.Bun as object))
) {
  (_g.Bun as Record<string, unknown>).Archive = Archive;
  (_g.Bun as Record<string, unknown>).Glob = Glob;
}
