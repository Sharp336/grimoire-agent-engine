import "@lu-zero/bun-compat";
import { Archive } from "@lu-zero/bun-compat/archive";
import { listen, connect } from "@lu-zero/bun-compat/socket";

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
  g.Bun.Archive = Archive;
  g.Bun.listen = listen as unknown as Record<string, unknown>;
  g.Bun.connect = connect as unknown as Record<string, unknown>;
  g.Bun.color = color;
  g.Bun.version ??= "1.3.7";
  g.Bun.nanoseconds = () => performance.now() * 1e6;
}

function toBunTimer(id: unknown): BunTimer {
  const num = typeof id === "number" ? id : 0;
  const timer = {
    [Symbol.toPrimitive]: () => num,
    ref() {
      return timer;
    },
    unref() {
      return timer;
    },
    hasRef: () => false,
    refresh() {
      return timer;
    },
  } as BunTimer;
  return timer;
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
    return toBunTimer(id);
  } as unknown as typeof globalThis.setInterval;
  globalThis.setTimeout = function (
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) {
    const id = origSetTimeout(cb, ms, ...args);
    return toBunTimer(id);
  } as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = function (id?: BunTimer | number) {
    if (typeof id === "number") {
      try {
        // deno-lint-ignore no-explicit-any
        (Deno as any).unrefTimer(id);
      } catch {}
    }
  } as unknown as typeof globalThis.clearTimeout;
}

export { Archive } from "@lu-zero/bun-compat/archive";
export { Database } from "@lu-zero/bun-compat/sqlite";
