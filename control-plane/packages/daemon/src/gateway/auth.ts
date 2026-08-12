/**
 * Device pairing and bearer-token auth.
 *
 * Pairing is two-step on purpose. A client that could name its own scopes would
 * turn pairing into a self-service privilege grant, which is the whole attack:
 * anything that can reach `POST /v1/pair` could then reach everything else. So
 * the HTTP half records an intent and grants nothing. Only `approvePairing`,
 * invoked by the operator out of band, writes a device row and mints a token,
 * and the scopes it writes are the operator's, never the client's.
 *
 * Tokens are 32 random bytes and only their SHA-256 hash is ever kept, so
 * neither the store nor a heap dump yields anything presentable.
 *
 * That hash lives in `auth_tokens`, not in this process. A pairing is a durable
 * fact about a device, and a daemon restart is not an operator decision to
 * withdraw it. Holding the hashes in memory logged every paired phone out on
 * every restart, silently and with nothing in the audit log, while the phone
 * went on presenting a credential it had every reason to believe in. A
 * credential now ends exactly one way: someone revokes or rotates it.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Actor, AuthTokenRecord, Device, Store } from "@ompd/core";

/** Short enough to read aloud over a phone call, long enough not to be guessed. */
const PAIRING_CODE_DIGITS = 6;
const TOKEN_BYTES = 32;
const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;

/**
 * Cap on unapproved pairings held in memory. `POST /v1/pair` is unauthenticated,
 * so without a ceiling it is an unbounded allocation for anyone who can reach
 * the port.
 */
const MAX_PENDING_PAIRINGS = 64;

/**
 * How stale `last_used_at` may get before a request pays to refresh it.
 *
 * Every authenticated call presents a token, so writing the timestamp on each
 * one turns every read into a WAL write and makes opening the console a dozen
 * transactions. The column exists so an operator can see which credentials are
 * still in use before revoking one; a minute of resolution answers that
 * question exactly as well as a millisecond does, at a fraction of the cost.
 */
const TOUCH_INTERVAL_MS = 60_000;

export interface PairingRequest {
  name: string;
  publicKey: string;
}

export interface PendingPairing extends PairingRequest {
  code: string;
  createdAt: string;
  expiresAtMs: number;
}

export interface DeviceAuthOptions {
  store: Store;
  /** How long an unapproved pairing stays claimable. */
  pairingTtlMs?: number;
  /** Minimum gap between `last_used_at` writes for one token. */
  touchIntervalMs?: number;
  /** Clock seam, so a test can prove the throttle without waiting a minute. */
  now?: () => number;
}

/** What a rotation withdrew and what it issued in its place. */
export interface RotationResult {
  deviceId: string;
  /** The replacement. Returned once; only its hash is kept. */
  token: string;
  /** Opaque id of the new row, safe to log. */
  tokenId: string;
  /** How many live credentials the rotation withdrew. */
  revoked: number;
}

/** Thrown when a pairing code is unknown, already used, or expired. */
export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

/** Thrown when too many pairings are already awaiting an operator. */
export class PairingBacklogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingBacklogError";
  }
}

export class DeviceAuth {
  #store: Store;
  #pairingTtlMs: number;
  #touchIntervalMs: number;
  #now: () => number;

  /** Pairing code -> pending request. Cleared on approval or expiry. */
  #pending = new Map<string, PendingPairing>();

  /**
   * Token id -> when its `last_used_at` was last written.
   *
   * The only in-memory auth state left, and it is deliberately lossy: an empty
   * map after a restart means the next request per token pays for one write.
   * Nothing authenticates out of here, so a cold start authenticates exactly
   * as well as a warm one.
   */
  #touchedAtMs = new Map<string, number>();

  constructor(opts: DeviceAuthOptions) {
    this.#store = opts.store;
    this.#pairingTtlMs = opts.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.#touchIntervalMs = opts.touchIntervalMs ?? TOUCH_INTERVAL_MS;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Record a pairing intent and return the code the operator will quote.
   *
   * Grants nothing: no device row, no scopes, no token. Until an operator calls
   * `approvePairing`, the code is the only thing that exists and it authorises
   * no request.
   */
  beginPairing(req: PairingRequest): string {
    this.#expirePairings();
    if (this.#pending.size >= MAX_PENDING_PAIRINGS) {
      throw new PairingBacklogError("too many pairings awaiting approval");
    }

    let code = "";
    do {
      code = String(randomInt(0, 10 ** PAIRING_CODE_DIGITS)).padStart(PAIRING_CODE_DIGITS, "0");
    } while (this.#pending.has(code));

    this.#pending.set(code, {
      name: req.name,
      publicKey: req.publicKey,
      code,
      createdAt: new Date().toISOString(),
      expiresAtMs: Date.now() + this.#pairingTtlMs,
    });
    return code;
  }

  /**
   * Operator action: write the device row and mint its one token.
   *
   * The scopes recorded are the ones passed here. What the client asked for at
   * `beginPairing` was never captured, precisely so it cannot influence this.
   */
  approvePairing(code: string, scopes: string[]): string {
    this.#expirePairings();
    const pending = this.#pending.get(code);
    if (!pending) throw new PairingError("unknown or expired pairing code");
    // Single use. A code that survived approval would be a second, quieter way
    // to mint a token for the same device.
    this.#pending.delete(code);

    const device: Device = {
      id: `dev_${randomBytes(8).toString("hex")}`,
      name: pending.name,
      publicKey: pending.publicKey,
      scopes: [...scopes],
      createdAt: new Date().toISOString(),
    };
    this.#store.addDevice(device);

    const token = this.#mint(device.id, pending.name).token;

    // No token id in the detail. `redact` scrubs any key whose name looks like
    // a credential, `tokenId` included, so recording one would persist
    // "[redacted]" and read as though something had been suppressed. The
    // `auth_tokens` table is where credentials are enumerated; this line is
    // the record that the act happened.
    this.#store.audit({
      action: "device.pair",
      actorDeviceId: device.id,
      outcome: "ok",
      detail: { name: device.name, scopes: device.scopes },
    });
    return token;
  }

  /**
   * Mint a token for a device row that already exists.
   *
   * Used for the local operator device, whose authority comes from filesystem
   * access rather than from pairing, and for the replacement half of a
   * rotation. Revoked devices are refused, so revocation is not undone by a
   * restart or by an operator reaching for the wrong command.
   */
  issueToken(deviceId: string, label?: string): string {
    const device = this.#requireLiveDevice(deviceId);
    return this.#mint(device.id, label ?? device.name).token;
  }

  /**
   * Withdraw a credential and issue its replacement.
   *
   * `presentedToken` names exactly which row to withdraw, which is what a
   * device rotating its own credential means: revoke this one, here is the
   * next. An operator rotating some other device holds no token of that
   * device's to name, so every live credential that device holds goes
   * instead. Leaving a sibling token alive there would leave whatever leaked
   * still working, which is the one outcome rotation exists to prevent.
   */
  rotateToken(deviceId: string, presentedToken?: string, label?: string): RotationResult {
    const device = this.#requireLiveDevice(deviceId);
    const presented =
      presentedToken === undefined ? null : this.#store.findAuthTokenByHash(hashToken(presentedToken));

    let revoked: number;
    if (presented !== null && presented.deviceId === device.id && presented.revokedAt === undefined) {
      this.#store.revokeAuthToken(presented.id);
      this.#touchedAtMs.delete(presented.id);
      revoked = 1;
    } else {
      revoked = this.#store.revokeAuthTokensForDevice(device.id);
      for (const row of this.#store.listAuthTokens(device.id)) this.#touchedAtMs.delete(row.id);
    }

    const minted = this.#mint(device.id, label ?? device.name);

    this.#store.audit({
      action: "device.pair",
      actorDeviceId: device.id,
      outcome: "ok",
      detail: { origin: "rotation", revoked },
    });

    return { deviceId: device.id, token: minted.token, tokenId: minted.record.id, revoked };
  }

  /**
   * Resolve a presented bearer token to an actor.
   *
   * Four ways to be refused, all of them a plain null: the token was never
   * issued, its row has been revoked, its device is gone, or its device has
   * been revoked. Scopes come from the device row, never from the token, so
   * narrowing a device narrows every credential it holds without reissuing
   * anything.
   *
   * The store is the source of truth on every call. There is no resolution
   * cache: the lookup is one indexed read of a local file, while a cache would
   * need invalidating on every revoke, rotate, and device change to avoid
   * honouring a credential an operator had already withdrawn. The cost worth
   * avoiding here is the write, and that is what the touch throttle is for.
   */
  resolveActor(token: string): Actor | null {
    const row = this.#store.findAuthTokenByHash(hashToken(token));
    if (!row || row.revokedAt !== undefined) return null;

    const device = this.#store.getDevice(row.deviceId);
    if (!device || device.revokedAt) return null;

    this.#touch(row);
    return { deviceId: device.id, scopes: device.scopes };
  }

  /**
   * Whether this exact token is still a live credential for that device,
   * without recording a use.
   *
   * The daemon asks this of `<home>/token` at startup. A plain restart must
   * leave that file byte-identical, and a check that stamped `last_used_at`
   * would make "the operator started the daemon" indistinguishable from "the
   * operator's credential was presented".
   */
  hasLiveToken(deviceId: string, token: string): boolean {
    const row = this.#store.findAuthTokenByHash(hashToken(token));
    if (!row || row.revokedAt !== undefined) return false;
    if (row.deviceId !== deviceId) return false;
    const device = this.#store.getDevice(deviceId);
    return device !== null && device.revokedAt === undefined;
  }

  /** Revoke a device. The store withdraws its tokens in the same transaction. */
  revoke(deviceId: string): void {
    this.#store.revokeDevice(deviceId);
    for (const row of this.#store.listAuthTokens(deviceId)) this.#touchedAtMs.delete(row.id);
    this.#store.audit({
      action: "device.revoke",
      actorDeviceId: deviceId,
      outcome: "ok",
      detail: {},
    });
  }

  /** Pending pairing codes, for an operator listing what is waiting. */
  pendingPairings(): PendingPairing[] {
    this.#expirePairings();
    return [...this.#pending.values()];
  }

  #requireLiveDevice(deviceId: string): Device {
    const device = this.#store.getDevice(deviceId);
    if (!device) throw new PairingError(`unknown device ${deviceId}`);
    if (device.revokedAt) throw new PairingError(`device ${deviceId} is revoked`);
    return device;
  }

  /** Random token in, persisted hash out. The raw value is returned once. */
  #mint(deviceId: string, label?: string): { token: string; record: AuthTokenRecord } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const input = {
      id: `tok_${randomBytes(8).toString("hex")}`,
      deviceId,
      tokenHash: hashToken(token),
      ...(label === undefined ? {} : { label }),
    };
    return { token, record: this.#store.addAuthToken(input) };
  }

  #touch(row: AuthTokenRecord): void {
    const now = this.#now();
    const last = this.#touchedAtMs.get(row.id);
    if (last !== undefined && now - last < this.#touchIntervalMs) return;
    this.#touchedAtMs.set(row.id, now);
    this.#store.touchAuthToken(row.id);
  }

  /** Drop pairings nobody approved in time. */
  #expirePairings(): void {
    const now = Date.now();
    for (const [code, pending] of this.#pending) {
      if (pending.expiresAtMs <= now) this.#pending.delete(code);
    }
  }
}

/** The one place a raw token becomes the value that gets written. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
