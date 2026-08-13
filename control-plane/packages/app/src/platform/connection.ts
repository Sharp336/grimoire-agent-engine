/**
 * Where the daemon is and what this device is allowed to do there.
 *
 * Ported from the PWA's `config.ts`, with the browser taken out of it. The
 * original read `window.location`, `window.localStorage`, and the query string
 * directly; none of those exist on a phone, and two of them do not exist on a
 * Mac app either. What survives is the shape of the thing: a URL, a scoped
 * token, and the scopes the pairing granted.
 *
 * Storage is asynchronous here where the PWA's was synchronous. That is not a
 * style choice: every cross-platform store there is (IndexedDB on web, SQLite
 * on Android, a plist on Apple platforms) is asynchronous underneath, and a
 * synchronous facade over one is a lie that shows up as an empty screen on the
 * first launch after an install.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_DAEMON_PORT } from "@ompd/core/contracts";

const STORAGE_KEY = "ompd.connection";

export interface Connection {
  /** Socket endpoint without the token, e.g. `ws://127.0.0.1:7777/v1/socket`. */
  url: string;
  token: string;
  /**
   * Scopes the daemon granted at pairing. Empty means the pairing did not say,
   * in which case the UI stays optimistic and lets the daemon correct it: an
   * `error` frame carrying a scope code downgrades the approval controls.
   */
  scopes: string[];
}

export async function loadConnection(): Promise<Connection | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    return coerce(JSON.parse(raw));
  } catch {
    // A store holding something that is not this shape is a store holding
    // nothing, and the pairing screen is the correct answer to that.
    return null;
  }
}

export async function saveConnection(connection: Connection): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

export async function clearConnection(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/**
 * Exported because a token arriving from outside the app (a pairing deep link,
 * a pasted URL) is untrusted input in exactly the same way a stored blob is,
 * and both go through one door.
 */
export function coerce(value: unknown): Connection | null {
  if (typeof value !== "object" || value === null) return null;
  const url: unknown = Reflect.get(value, "url");
  const token: unknown = Reflect.get(value, "token");
  const scopes: unknown = Reflect.get(value, "scopes");
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  const parsedScopes = Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string") : [];
  return { url, token, scopes: parsedScopes };
}

/**
 * The daemon binds loopback, so there is no address a phone can guess. This is
 * the one a desktop or a tunnel on the same machine will answer on, offered as
 * a starting point in the field rather than as a default that silently works.
 *
 * Built from the shared port rather than typed again: this constant said 7717
 * while the daemon bound 7777, so the first pairing anyone attempted failed on
 * a suggestion the app itself supplied.
 */
export const SUGGESTED_SOCKET_URL = `ws://127.0.0.1:${DEFAULT_DAEMON_PORT}/v1/socket`;
