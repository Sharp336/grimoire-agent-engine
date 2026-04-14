import "@lu-zero/bun-compat";
import { hash as hashObj } from "@lu-zero/bun-compat/bun";
import { Archive } from "./archive.ts";
import { build } from "./build.ts";
import { listen, connect } from "./socket.ts";
import natives from "../../packages/natives/src/index.ts";

function hash(input: string | Uint8Array | ArrayBuffer, seed?: number): number {
  return Number(
    hashObj.xxHash64(
      input instanceof ArrayBuffer ? new Uint8Array(input) : input,
      seed,
    ),
  );
}
function xxHash32(input: string | Uint8Array, seed: number = 0): number {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const len = data.length;
  let h32 = (seed + 0x9e3779b1 + len * 0x85ebca6b) >>> 0;
  if (len >= 16) {
    const limit = len - 16;
    let i = 0;
    while (i <= limit) {
      h32 =
        (h32 +
          Math.imul(
            data[i]! |
              (data[i + 1]! << 8) |
              (data[i + 2]! << 16) |
              (data[i + 3]! << 24),
            0x9e3779b1,
          )) >>>
        0;
      h32 =
        (h32 +
          Math.imul(
            data[i + 4]! |
              (data[i + 5]! << 8) |
              (data[i + 6]! << 16) |
              (data[i + 7]! << 24),
            0x85ebca6b,
          )) >>>
        0;
      h32 =
        (h32 +
          Math.imul(
            data[i + 8]! |
              (data[i + 9]! << 8) |
              (data[i + 10]! << 16) |
              (data[i + 11]! << 24),
            0x9e3779b1,
          )) >>>
        0;
      h32 =
        (h32 +
          Math.imul(
            data[i + 12]! |
              (data[i + 13]! << 8) |
              (data[i + 14]! << 16) |
              (data[i + 15]! << 24),
            0x85ebca6b,
          )) >>>
        0;
      h32 = Math.imul(h32 ^ (h32 >>> 16), 0x85ebca6b) >>> 0;
      h32 = Math.imul(h32 ^ (h32 >>> 13), 0x9e3779b1) >>> 0;
      h32 = h32 ^ (h32 >>> 16);
      i += 16;
    }
  }
  for (let i = len & ~0xf; i < len; i++) {
    h32 = (h32 + data[i]! * 0x9e3779b1) >>> 0;
  }
  h32 = Math.imul(h32 ^ (h32 >>> 15), 0x85ebca6b) >>> 0;
  h32 = Math.imul(h32 ^ (h32 >>> 13), 0x9e3779b1) >>> 0;
  return (h32 ^ (h32 >>> 16)) >>> 0;
}
(hash as unknown as Record<string, unknown>).xxHash64 = hashObj.xxHash64;
(hash as unknown as Record<string, unknown>).wyhash = function wyhashNative(
  input: Uint8Array | string,
  seed?: number,
): bigint {
  return natives.wyhash(input, seed) as bigint;
};
(hash as unknown as Record<string, unknown>).xxHash32 = xxHash32;

function color(input: string | number, format: string): string | null {
  if (typeof input === "number") {
    if (format === "ansi-16m") {
      const r = (input >> 16) & 0xff;
      const g = (input >> 8) & 0xff;
      const b = input & 0xff;
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    if (format === "ansi-256") {
      return `\x1b[38;5;${Math.min(255, input)}m`;
    }
    return null;
  }
  const hex = input.startsWith("#") ? input : null;
  if (!hex) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  if (format === "ansi-16m") {
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  if (format === "ansi-256") {
    if (r === g && g === b) return `\x1b[38;5;${Math.round((r / 255) * 24)}m`;
    const idx =
      16 +
      36 * Math.round((r / 255) * 5) +
      6 * Math.round((g / 255) * 5) +
      Math.round((b / 255) * 5);
    return `\x1b[38;5;${idx}m`;
  }
  if (format === "css") {
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (format === "hex") {
    return hex.toLowerCase();
  }
  return null;
}

const g = globalThis as unknown as Record<string, Record<string, unknown>>;
if (g.Bun) {
  g.Bun.hash = hash as unknown as Record<string, unknown>;
  g.Bun.Archive = Archive;
  g.Bun.build = build as unknown as Record<string, unknown>;
  g.Bun.listen = listen as unknown as Record<string, unknown>;
  g.Bun.connect = connect as unknown as Record<string, unknown>;
  g.Bun.color = color;
  g.Bun.version ??= "1.3.7";

  const rawEnv = g.Bun.env as Record<string, string>;
  const envProxy = new Proxy(rawEnv, {
    get(target, prop: string) {
      const val = Deno.env.get(prop);
      return val === undefined ? undefined : val;
    },
    set(_target, prop: string, value: string) {
      Deno.env.set(prop, value);
      return true;
    },
    deleteProperty(_target, prop: string) {
      Deno.env.delete(prop);
      return true;
    },
    ownKeys() {
      return Reflect.ownKeys(Deno.env.toObject());
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      const val = Deno.env.get(prop);
      if (val === undefined) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: val,
        writable: true,
      };
    },
    has(_target, prop: string) {
      return Deno.env.get(prop) !== undefined;
    },
  });
  g.Bun.env = envProxy;
}

{
  const origSetInterval = globalThis.setInterval;
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = function (
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) {
    const id = origSetInterval(cb, ms, ...args);
    return typeof id === "number"
      ? {
          [Symbol.toPrimitive]: () => id,
          unref: () => {},
          ref: () => {},
          hasRef: () => false,
          refresh: () => id,
        }
      : id;
  } as unknown as typeof globalThis.setInterval;
  globalThis.setTimeout = function (
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) {
    const id = origSetTimeout(cb, ms, ...args);
    return typeof id === "number"
      ? {
          [Symbol.toPrimitive]: () => id,
          unref: () => {},
          ref: () => {},
          hasRef: () => false,
          refresh: () => id,
        }
      : id;
  } as unknown as typeof globalThis.setTimeout;
}

export { Archive } from "./archive.ts";
export { Database } from "./sqlite.ts";
