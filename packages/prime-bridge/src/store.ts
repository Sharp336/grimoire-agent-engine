import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import type { BridgeMessage, BridgeReceipt, ExternalPeer, PrimeDaemonCursor } from "@oh-my-pi/prime-bridge-protocol";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_INBOX_CLAIM_LEASE_MS = 30_000;
const DEFAULT_CLAIM_LIMIT = 100;
export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_QUERY_LIMIT = 1_000;
export const MAX_AUDIT_ROWS = 1_000;
export const MAX_CONSUMED_INBOX_ROWS = 1_000;
export const MAX_COMPLETED_OUTBOX_ROWS = 1_000;
export const MAX_ORPHAN_RECEIPT_ROWS = 1_000;
/** OMP peer registrations expire after five minutes without a refresh. */
export const OMP_PEER_TTL_MS = 5 * 60_000;
/** Keep at most one hundred durable OMP peer registrations. */
export const MAX_OMP_PEERS = 100;
/** Retain terminal idempotency keys for one day after their rows are pruned. */
export const IDEMPOTENCY_TOMBSTONE_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const REDACTED = "[REDACTED]";

export interface ClaimPendingMessagesOptions {
	limit?: number;
	leaseMs?: number;
	now?: number;
}
export interface ClaimedPendingMessage {
	message: BridgeMessage;
	claimToken: string;
	claimedUntilMs: number;
}
export interface ClaimInboxMessageOptions {
	leaseMs?: number;
	now?: number;
}
export interface ClaimedInboxMessage {
	message: BridgeMessage;
	claimToken: string;
	claimedUntilMs: number;
}
export interface AuditEntry {
	action: string;
	preview: unknown;
	direction?: "inbound" | "outbound";
	tokenIdentifier?: string;
	originHarness?: "omp" | "prime";
	originSessionId?: string;
	createdAt?: string;
}
export interface AuditQueryOptions {
	limit?: number;
}

export interface InboxQueryOptions {
	peek?: boolean;
	targetId?: string;
	from?: string;
	limit?: number;
	maxBytes?: number;
}

export interface OmpPeerRegistration extends ExternalPeer {
	lastSeenAt?: string;
}

type InboxRow = {
	rowid: number;
	message_json: string;
	claim_token: string | null;
	claimed_until_ms: number | null;
};

export interface PrimeCommandRecord {
	commandId: string;
	envelopeJson: string;
	responseJson: string | null;
	createdAt: string;
}

type MetadataRow = { value: string };
type CursorRow = { cursor_json: string };
type CommandRow = {
	command_id: string;
	envelope_json: string;
	response_json: string | null;
	created_at: string;
};

function redactBearerValues(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") {
		return value
			.replace(/\bBearer\s+[^\s,;}\]]+/gi, "Bearer [REDACTED]")
			.replace(
				/\b(authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret)\s*[:=]\s*["']?[^,\s}"']+/gi,
				"$1=[REDACTED]",
			);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const result = value.map(item => redactBearerValues(item, seen));
		seen.delete(value);
		return result;
	}
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	if (seen.has(record)) return "[Circular]";
	seen.add(record);
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		result[key] = /(?:authorization|token|access.?token|refresh.?token|bearer.?token|api.?key|secret)/i.test(key)
			? REDACTED
			: redactBearerValues(item);
	}
	seen.delete(record);
	return result;
}
function chmodIfPresent(filePath: string, mode: number): void {
	try {
		fs.chmodSync(filePath, mode);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

export class BridgeStore {
	#db: Database;
	#databasePath: string;
	static open(databasePath: string): BridgeStore {
		return new BridgeStore(databasePath);
	}

	constructor(databasePath: string) {
		this.#databasePath = databasePath;
		this.#db = new Database(databasePath, { create: true });
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#initializeSchema();
		this.#enforceDatabaseFileModes();
	}

	getOrCreateClientId(): string {
		return this.#transition(() => {
			const existing = this.#db
				.prepare("SELECT value FROM metadata WHERE key = 'client_id'")
				.get() as MetadataRow | null;
			if (existing) return existing.value;
			const clientId = crypto.randomUUID();
			this.#db.prepare("INSERT INTO metadata (key, value) VALUES ('client_id', ?)").run(clientId);
			return clientId;
		});
	}

	getCursor(activeSessionId: string): PrimeDaemonCursor | null {
		const row = this.#db
			.prepare("SELECT cursor_json FROM prime_cursors WHERE active_session_id = ?")
			.get(activeSessionId) as CursorRow | null;
		return row ? (JSON.parse(row.cursor_json) as PrimeDaemonCursor) : null;
	}

	setCursor(activeSessionId: string, cursor: PrimeDaemonCursor): void {
		this.#transition(() => {
			this.#db
				.prepare(
					"INSERT INTO prime_cursors (active_session_id, generation, sequence, cursor_json) VALUES (?, ?, ?, ?) " +
						"ON CONFLICT(active_session_id) DO UPDATE SET generation = excluded.generation, sequence = excluded.sequence, cursor_json = excluded.cursor_json",
				)
				.run(activeSessionId, cursor.generation, cursor.sequence, JSON.stringify(cursor));
		});
	}

	registerOmpPeer(peer: ExternalPeer, now = Date.now()): void {
		if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("peer registration time must be non-negative");
		if (peer.id.length === 0 || peer.displayName.length === 0 || peer.status.length === 0)
			throw new Error("OMP peer registration fields must be non-empty");
		this.#transition(() => {
			this.#pruneExpiredOmpPeers(now);
			this.#db
				.prepare(
					"INSERT INTO omp_peers (peer_id, display_name, status, last_seen_ms) VALUES (?, ?, ?, ?) " +
						"ON CONFLICT(peer_id) DO UPDATE SET display_name = excluded.display_name, status = excluded.status, last_seen_ms = excluded.last_seen_ms",
				)
				.run(peer.id, peer.displayName, peer.status, now);
			this.#db
				.prepare(
					"DELETE FROM omp_peers WHERE rowid IN " +
						"(SELECT rowid FROM omp_peers ORDER BY last_seen_ms DESC, rowid DESC LIMIT -1 OFFSET ?)",
				)
				.run(MAX_OMP_PEERS);
		});
	}

	listOmpPeers(now = Date.now()): ExternalPeer[] {
		if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("peer list time must be non-negative");
		return this.#transition(() => {
			this.#pruneExpiredOmpPeers(now);
			const rows = this.#db
				.prepare(
					"SELECT peer_id, display_name, status, last_seen_ms FROM omp_peers ORDER BY last_seen_ms DESC, rowid DESC",
				)
				.all() as Array<{ peer_id: string; display_name: string; status: string; last_seen_ms: number }>;
			return rows.map(row => ({
				id: row.peer_id,
				displayName: row.display_name,
				status: row.status,
				lastSeenAt: new Date(row.last_seen_ms).toISOString(),
			}));
		});
	}

	unregisterOmpPeer(peerId: string): void {
		this.#transition(() => {
			this.#db.prepare("DELETE FROM omp_peers WHERE peer_id = ?").run(peerId);
		});
	}

	/**
	 * The legacy selector remains available for existing callers. New bridge
	 * routes must use takeFirstInboxForTarget so one OMP session cannot consume
	 * another session's messages.
	 */
	takeFirstInboxForTarget(targetId: string, from?: string): BridgeMessage | null {
		if (targetId.length === 0) throw new Error("inbox targetId is required");
		return this.#takeFirstInbox({ targetId, from });
	}

	#takeFirstInbox(options: { targetId?: string; from?: string }): BridgeMessage | null {
		return this.#transition(() => {
			const row = this.#db
				.prepare(
					"SELECT rowid, message_json FROM inbox " +
						"WHERE consumed_at IS NULL AND (? IS NULL OR json_extract(message_json, '$.targetId') = ?) " +
						"AND (? IS NULL OR json_extract(message_json, '$.originSessionId') = ?) " +
						"ORDER BY rowid ASC LIMIT 1",
				)
				.get(
					options.targetId ?? null,
					options.targetId ?? null,
					options.from ?? null,
					options.from ?? null,
				) as InboxRow | null;
			if (!row) return null;
			this.#db
				.prepare("UPDATE inbox SET consumed_at = ? WHERE rowid = ? AND consumed_at IS NULL")
				.run(new Date().toISOString(), row.rowid);
			this.#pruneConsumedInbox();
			this.#pruneOrphanReceipts();
			return JSON.parse(row.message_json) as BridgeMessage;
		});
	}

	claimInboxForTarget(
		targetId: string,
		from?: string,
		options: ClaimInboxMessageOptions = {},
	): ClaimedInboxMessage | null {
		if (targetId.length === 0) throw new Error("inbox targetId is required");
		const leaseMs = options.leaseMs ?? DEFAULT_INBOX_CLAIM_LEASE_MS;
		const now = options.now ?? Date.now();
		if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
			throw new RangeError("inbox claim lease must be a positive integer");
		if (!Number.isSafeInteger(now) || now < 0)
			throw new RangeError("inbox claim time must be a non-negative integer");
		if (now > Number.MAX_SAFE_INTEGER - leaseMs)
			throw new RangeError("inbox claim time and lease exceed safe integer bounds");
		return this.#transition(() => {
			const row = this.#db
				.prepare(
					"SELECT rowid, message_json FROM inbox " +
						"WHERE consumed_at IS NULL AND (? IS NULL OR json_extract(message_json, '$.targetId') = ?) " +
						"AND (? IS NULL OR json_extract(message_json, '$.originSessionId') = ?) " +
						"AND (claim_token IS NULL OR claimed_until_ms IS NULL OR claimed_until_ms <= ?) " +
						"ORDER BY rowid ASC LIMIT 1",
				)
				.get(targetId, targetId, from ?? null, from ?? null, now) as InboxRow | null;
			if (row === null) return null;
			const claimToken = crypto.randomUUID();
			const claimedUntilMs = now + leaseMs;
			const updated = this.#db
				.prepare(
					"UPDATE inbox SET claim_token = ?, claimed_until_ms = ? " +
						"WHERE rowid = ? AND consumed_at IS NULL AND " +
						"(claim_token IS NULL OR claimed_until_ms IS NULL OR claimed_until_ms <= ?)",
				)
				.run(claimToken, claimedUntilMs, row.rowid, now);
			if (updated.changes !== 1) return null;
			return {
				message: JSON.parse(row.message_json) as BridgeMessage,
				claimToken,
				claimedUntilMs,
			};
		});
	}

	ackInboxClaim(claimToken: string): boolean {
		if (claimToken.length === 0) return false;
		return this.#transition(() => {
			const now = Date.now();
			const updated = this.#db
				.prepare(
					"UPDATE inbox SET consumed_at = ?, claim_token = NULL, claimed_until_ms = NULL " +
						"WHERE consumed_at IS NULL AND claim_token = ? AND claimed_until_ms > ?",
				)
				.run(new Date(now).toISOString(), claimToken, now);
			if (updated.changes !== 1) return false;
			this.#pruneConsumedInbox();
			this.#pruneOrphanReceipts();
			return true;
		});
	}

	releaseInboxClaim(claimToken: string): boolean {
		if (claimToken.length === 0) return false;
		return this.#transition(
			() =>
				this.#db
					.prepare(
						"UPDATE inbox SET claim_token = NULL, claimed_until_ms = NULL " +
							"WHERE consumed_at IS NULL AND claim_token = ?",
					)
					.run(claimToken).changes === 1,
		);
	}
	enqueueMessage(message: BridgeMessage): boolean {
		return this.#transition(() => {
			this.#pruneIdempotencyTombstones(Date.now());
			const duplicate = this.#db
				.prepare(
					"SELECT EXISTS(SELECT 1 FROM outbox WHERE idempotency_key = ? OR mesh_message_id = ?) OR " +
						"EXISTS(SELECT 1 FROM inbox WHERE idempotency_key = ? OR mesh_message_id = ?) OR " +
						"EXISTS(SELECT 1 FROM idempotency_tombstones WHERE idempotency_key = ? OR mesh_message_id = ?) AS present",
				)
				.get(
					message.idempotencyKey,
					message.meshMessageId,
					message.idempotencyKey,
					message.meshMessageId,
					message.idempotencyKey,
					message.meshMessageId,
				) as {
				present: number;
			};
			if (duplicate.present === 1) return false;
			const result = this.#db
				.prepare(
					"INSERT INTO outbox (mesh_message_id, idempotency_key, message_json, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(message.meshMessageId, message.idempotencyKey, JSON.stringify(message), message.createdAt);
			return result.changes === 1;
		});
	}

	claimPendingMessages(options: ClaimPendingMessagesOptions = {}): ClaimedPendingMessage[] {
		const limit = options.limit ?? DEFAULT_CLAIM_LIMIT;
		const leaseMs = options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
		const now = options.now ?? Date.now();
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("claim limit must be a positive integer");
		if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError("claim lease must be a positive integer");
		if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("claim time must be a non-negative integer");
		if (now > Number.MAX_SAFE_INTEGER - leaseMs) {
			throw new RangeError("claim time and lease exceed safe integer bounds");
		}

		return this.#transition(() => {
			const rows = this.#db
				.prepare(
					"SELECT id, message_json FROM outbox " +
						"WHERE status = 'pending' OR (status = 'claimed' AND claimed_until_ms <= ?) " +
						"ORDER BY id ASC LIMIT ?",
				)
				.all(now, limit) as Array<{ id: number; message_json: string }>;
			const claimedUntilMs = now + leaseMs;
			const claim = this.#db.prepare(
				"UPDATE outbox SET status = 'claimed', claim_token = ?, claimed_until_ms = ? " +
					"WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND claimed_until_ms <= ?))",
			);
			const claimed: ClaimedPendingMessage[] = [];
			for (const row of rows) {
				const claimToken = crypto.randomUUID();
				if (claim.run(claimToken, claimedUntilMs, row.id, now).changes !== 1) continue;
				claimed.push({
					message: JSON.parse(row.message_json) as BridgeMessage,
					claimToken,
					claimedUntilMs,
				});
			}
			return claimed;
		});
	}

	nextClaimAt(now = Date.now()): number | null {
		if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("claim time must be a non-negative integer");
		const row = this.#db
			.prepare(
				"SELECT MIN(CASE WHEN status = 'pending' THEN ? ELSE claimed_until_ms END) AS next_claim_at " +
					"FROM outbox WHERE status = 'pending' OR (status = 'claimed' AND claimed_until_ms > ?)",
			)
			.get(now, now) as { next_claim_at: number | null };
		return row.next_claim_at;
	}

	recordReceipt(receipt: BridgeReceipt, claimToken?: string): boolean {
		return this.#transition(() => {
			const now = Date.now();
			const outboxRow = this.#db
				.prepare("SELECT id, idempotency_key, status FROM outbox WHERE mesh_message_id = ?")
				.get(receipt.meshMessageId) as { id: number; idempotency_key: string; status: string } | null;
			if (outboxRow !== null) {
				const updated =
					claimToken === undefined
						? this.#db
								.prepare(
									"UPDATE outbox SET status = 'complete', claim_token = NULL, claimed_until_ms = NULL " +
										"WHERE id = ? AND status IN ('pending', 'claimed')",
								)
								.run(outboxRow.id)
						: this.#db
								.prepare(
									"UPDATE outbox SET status = 'complete', claim_token = NULL, claimed_until_ms = NULL " +
										"WHERE id = ? AND status = 'claimed' AND claim_token = ?",
								)
								.run(outboxRow.id, claimToken);
				if (updated.changes !== 1) return false;
				this.#pruneIdempotencyTombstones(now);
				this.#db
					.prepare(
						"INSERT INTO idempotency_tombstones (idempotency_key, mesh_message_id, terminal_at, expires_at_ms) " +
							"VALUES (?, ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET mesh_message_id = excluded.mesh_message_id, " +
							"terminal_at = excluded.terminal_at, expires_at_ms = excluded.expires_at_ms",
					)
					.run(
						outboxRow.idempotency_key,
						receipt.meshMessageId,
						new Date(now).toISOString(),
						now + IDEMPOTENCY_TOMBSTONE_REPLAY_WINDOW_MS,
					);
				this.#db
					.prepare(
						"INSERT INTO receipts (mesh_message_id, status, receipt_json, recorded_at) VALUES (?, ?, ?, ?) " +
							"ON CONFLICT(mesh_message_id, status) DO UPDATE SET receipt_json = excluded.receipt_json, recorded_at = excluded.recorded_at",
					)
					.run(receipt.meshMessageId, receipt.status, JSON.stringify(receipt), new Date(now).toISOString());
				this.#pruneCompletedOutbox();
				this.#pruneOrphanReceipts();
				return true;
			}

			const inboxRow = this.#db
				.prepare("SELECT idempotency_key FROM inbox WHERE mesh_message_id = ?")
				.get(receipt.meshMessageId) as { idempotency_key: string } | null;
			if (inboxRow === null) return false;
			this.#pruneIdempotencyTombstones(now);
			this.#db
				.prepare(
					"INSERT INTO idempotency_tombstones (idempotency_key, mesh_message_id, terminal_at, expires_at_ms) " +
						"VALUES (?, ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET mesh_message_id = excluded.mesh_message_id, " +
						"terminal_at = excluded.terminal_at, expires_at_ms = excluded.expires_at_ms",
				)
				.run(
					inboxRow.idempotency_key,
					receipt.meshMessageId,
					new Date(now).toISOString(),
					now + IDEMPOTENCY_TOMBSTONE_REPLAY_WINDOW_MS,
				);
			this.#db
				.prepare(
					"INSERT INTO receipts (mesh_message_id, status, receipt_json, recorded_at) VALUES (?, ?, ?, ?) " +
						"ON CONFLICT(mesh_message_id, status) DO UPDATE SET receipt_json = excluded.receipt_json, recorded_at = excluded.recorded_at",
				)
				.run(receipt.meshMessageId, receipt.status, JSON.stringify(receipt), new Date(now).toISOString());
			this.#pruneOrphanReceipts();
			return true;
		});
	}

	recordDeliveryFailure(meshMessageId: string, claimToken: string): boolean {
		return this.#transition(
			() =>
				this.#db
					.prepare(
						"UPDATE outbox SET status = 'pending', claim_token = NULL, claimed_until_ms = NULL " +
							"WHERE mesh_message_id = ? AND status = 'claimed' AND claim_token = ?",
					)
					.run(meshMessageId, claimToken).changes === 1,
		);
	}

	putInbox(message: BridgeMessage): boolean {
		return this.#transition(() => {
			this.#pruneIdempotencyTombstones(Date.now());
			const duplicate = this.#db
				.prepare(
					"SELECT EXISTS(SELECT 1 FROM outbox WHERE idempotency_key = ? OR mesh_message_id = ?) OR " +
						"EXISTS(SELECT 1 FROM inbox WHERE idempotency_key = ? OR mesh_message_id = ?) OR " +
						"EXISTS(SELECT 1 FROM idempotency_tombstones WHERE idempotency_key = ? OR mesh_message_id = ?) AS present",
				)
				.get(
					message.idempotencyKey,
					message.meshMessageId,
					message.idempotencyKey,
					message.meshMessageId,
					message.idempotencyKey,
					message.meshMessageId,
				) as {
				present: number;
			};
			if (duplicate.present === 1) return false;
			const result = this.#db
				.prepare(
					"INSERT INTO inbox (mesh_message_id, idempotency_key, message_json, received_at) VALUES (?, ?, ?, ?)",
				)
				.run(message.meshMessageId, message.idempotencyKey, JSON.stringify(message), new Date().toISOString());
			return result.changes === 1;
		});
	}
	listInbox(options: InboxQueryOptions = {}): BridgeMessage[] {
		const limit = options.limit ?? 100;
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("inbox limit must be a positive integer");
		if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1))
			throw new RangeError("inbox maxBytes must be a positive integer");
		return this.#transition(() => {
			const destructive = options.peek === false;
			const now = Date.now();
			const claimEligibility = "(claim_token IS NULL OR claimed_until_ms IS NULL OR claimed_until_ms <= ?)";
			const rows = this.#db
				.prepare(
					"SELECT rowid, message_json FROM inbox " +
						"WHERE consumed_at IS NULL AND (? IS NULL OR json_extract(message_json, '$.targetId') = ?) " +
						"AND (? IS NULL OR json_extract(message_json, '$.originSessionId') = ?) " +
						(destructive ? `AND ${claimEligibility} ` : "") +
						"ORDER BY rowid ASC LIMIT ?",
				)
				.all(
					options.targetId ?? null,
					options.targetId ?? null,
					options.from ?? null,
					options.from ?? null,
					...(destructive ? [now] : []),
					limit,
				) as InboxRow[];
			const selected: InboxRow[] = [];
			let totalBytes = 1;
			for (const row of rows) {
				const bytes = new TextEncoder().encode(row.message_json).byteLength;
				const framedBytes = bytes + (selected.length === 0 ? 1 : 2);
				if (options.maxBytes !== undefined && totalBytes + framedBytes > options.maxBytes) break;
				selected.push(row);
				totalBytes += framedBytes;
			}
			if (destructive && selected.length > 0) {
				const consume = this.#db.prepare(
					"UPDATE inbox SET consumed_at = ?, claim_token = NULL, claimed_until_ms = NULL " +
						"WHERE rowid = ? AND consumed_at IS NULL AND " +
						claimEligibility,
				);
				const consumedAt = new Date().toISOString();
				for (const row of selected) consume.run(consumedAt, row.rowid, now);
				this.#pruneConsumedInbox();
				this.#pruneOrphanReceipts();
			}
			return selected.map(row => JSON.parse(row.message_json) as BridgeMessage);
		});
	}

	takeFirstInbox(from?: string): BridgeMessage | null {
		return this.#takeFirstInbox({ from });
	}

	findMessageByIdempotencyKey(idempotencyKey: string): BridgeMessage | null {
		const row = this.#db
			.prepare(
				"SELECT message_json FROM outbox WHERE idempotency_key = ? " +
					"UNION ALL SELECT message_json FROM inbox WHERE idempotency_key = ? LIMIT 1",
			)
			.get(idempotencyKey, idempotencyKey) as { message_json: string } | null;
		return row ? (JSON.parse(row.message_json) as BridgeMessage) : null;
	}

	getLatestReceipt(meshMessageId: string): BridgeReceipt | null {
		const row = this.#db
			.prepare("SELECT receipt_json FROM receipts WHERE mesh_message_id = ? ORDER BY recorded_at DESC LIMIT 1")
			.get(meshMessageId) as { receipt_json: string } | null;
		return row ? (JSON.parse(row.receipt_json) as BridgeReceipt) : null;
	}

	getReceiptForIdempotencyKey(idempotencyKey: string): BridgeReceipt | null {
		const row = this.#db
			.prepare(
				"SELECT r.receipt_json FROM receipts r " +
					"JOIN (SELECT mesh_message_id FROM outbox WHERE idempotency_key = ? " +
					"UNION ALL SELECT mesh_message_id FROM inbox WHERE idempotency_key = ?) m " +
					"ON m.mesh_message_id = r.mesh_message_id ORDER BY r.recorded_at DESC LIMIT 1",
			)
			.get(idempotencyKey, idempotencyKey) as { receipt_json: string } | null;
		return row ? (JSON.parse(row.receipt_json) as BridgeReceipt) : null;
	}
	listAudit(options: AuditQueryOptions = {}): AuditEntry[] {
		const requestedLimit = options.limit ?? DEFAULT_AUDIT_LIMIT;
		if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
			throw new RangeError("audit limit must be a positive integer");
		const limit = Math.min(requestedLimit, MAX_AUDIT_QUERY_LIMIT);
		const rows = this.#db
			.prepare(
				"SELECT id, action, preview_json, direction, token_identifier, origin_harness, origin_session_id, created_at FROM " +
					"(SELECT id, action, preview_json, direction, token_identifier, origin_harness, origin_session_id, created_at FROM audit ORDER BY id DESC LIMIT ?) " +
					"ORDER BY id ASC",
			)
			.all(limit) as Array<{
			id: number;
			action: string;
			preview_json: string;
			direction: "inbound" | "outbound" | null;
			token_identifier: string | null;
			origin_harness: "omp" | "prime" | null;
			origin_session_id: string | null;
			created_at: string;
		}>;
		return rows.map(row => ({
			action: row.action,
			preview: redactBearerValues(JSON.parse(row.preview_json) as unknown),
			...(row.direction === null ? {} : { direction: row.direction }),
			...(row.token_identifier === null ? {} : { tokenIdentifier: row.token_identifier }),
			...(row.origin_harness === null ? {} : { originHarness: row.origin_harness }),
			...(row.origin_session_id === null ? {} : { originSessionId: row.origin_session_id }),
			createdAt: row.created_at,
		}));
	}

	dedupe(idempotencyKey: string): boolean {
		this.#pruneIdempotencyTombstones(Date.now());
		const row = this.#db
			.prepare(
				"SELECT EXISTS(SELECT 1 FROM outbox WHERE idempotency_key = ?) OR " +
					"EXISTS(SELECT 1 FROM inbox WHERE idempotency_key = ?) OR " +
					"EXISTS(SELECT 1 FROM idempotency_tombstones WHERE idempotency_key = ?) AS present",
			)
			.get(idempotencyKey, idempotencyKey, idempotencyKey) as { present: number };
		return row.present === 1;
	}

	appendAudit(entry: AuditEntry): void {
		this.#transition(() => {
			const preview = redactBearerValues(entry.preview);
			this.#db
				.prepare(
					"INSERT INTO audit (action, preview_json, direction, token_identifier, origin_harness, origin_session_id, created_at) " +
						"VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					entry.action,
					JSON.stringify(preview),
					entry.direction ?? null,
					entry.tokenIdentifier ?? null,
					entry.originHarness ?? null,
					entry.originSessionId ?? null,
					entry.createdAt ?? new Date().toISOString(),
				);
			this.#pruneAudit();
		});
	}

	persistCommand(commandId: string, envelopeJson: string, createdAt = new Date().toISOString()): PrimeCommandRecord {
		return this.#transition(() => {
			const existing = this.#db
				.prepare(
					"SELECT command_id, envelope_json, response_json, created_at FROM prime_commands WHERE command_id = ?",
				)
				.get(commandId) as CommandRow | null;
			if (existing) {
				if (existing.envelope_json !== envelopeJson) {
					throw new Error("command ID already exists with a different envelope");
				}
				return this.#commandRecord(existing);
			}

			this.#db
				.prepare(
					"INSERT INTO prime_commands (command_id, envelope_json, response_json, created_at) VALUES (?, ?, NULL, ?)",
				)
				.run(commandId, envelopeJson, createdAt);
			return { commandId, envelopeJson, responseJson: null, createdAt };
		});
	}

	listPendingCommands(): PrimeCommandRecord[] {
		const rows = this.#db
			.prepare(
				"SELECT command_id, envelope_json, response_json, created_at FROM prime_commands " +
					"ORDER BY created_at ASC, rowid ASC",
			)
			.all() as CommandRow[];
		return rows.map(row => this.#commandRecord(row));
	}

	recordCommandResponse(commandId: string, responseJson: string): PrimeCommandRecord {
		return this.#transition(() => {
			const existing = this.#db
				.prepare(
					"SELECT command_id, envelope_json, response_json, created_at FROM prime_commands WHERE command_id = ?",
				)
				.get(commandId) as CommandRow | null;
			if (!existing) throw new Error(`cannot record response for unknown command ${commandId}`);
			if (existing.response_json !== null && existing.response_json !== responseJson) {
				throw new Error("command ID already has a different response");
			}
			if (existing.response_json === null) {
				this.#db
					.prepare("UPDATE prime_commands SET response_json = ? WHERE command_id = ?")
					.run(responseJson, commandId);
				return { ...this.#commandRecord(existing), responseJson };
			}
			return this.#commandRecord(existing);
		});
	}

	completeCommand(commandId: string): void {
		this.#transition(() => {
			const existing = this.#db
				.prepare("SELECT response_json FROM prime_commands WHERE command_id = ?")
				.get(commandId) as { response_json: string | null } | null;
			if (!existing) return;
			if (existing.response_json === null) {
				throw new Error("cannot complete command before recording response");
			}
			this.#db.prepare("DELETE FROM prime_commands WHERE command_id = ?").run(commandId);
		});
	}

	close(): void {
		this.#db.close();
	}

	#initializeSchema(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY NOT NULL,
				value TEXT NOT NULL
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS prime_cursors (
				active_session_id TEXT PRIMARY KEY NOT NULL,
				generation TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				cursor_json TEXT NOT NULL
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS omp_peers (
				peer_id TEXT PRIMARY KEY NOT NULL,
				display_name TEXT NOT NULL,
				status TEXT NOT NULL,
				last_seen_ms INTEGER NOT NULL
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				mesh_message_id TEXT NOT NULL UNIQUE,
				idempotency_key TEXT NOT NULL UNIQUE,
				message_json TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'complete')),
				claim_token TEXT,
				claimed_until_ms INTEGER,
				created_at TEXT NOT NULL
			)
		`);
		this.#db.run("CREATE INDEX IF NOT EXISTS outbox_claims ON outbox (status, claimed_until_ms, id)");
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS inbox (
				mesh_message_id TEXT PRIMARY KEY NOT NULL,
				idempotency_key TEXT NOT NULL UNIQUE,
				message_json TEXT NOT NULL,
				received_at TEXT NOT NULL,
				consumed_at TEXT,
				claim_token TEXT,
				claimed_until_ms INTEGER
			)
		`);
		const inboxColumns = this.#db.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>;
		if (!inboxColumns.some(column => column.name === "consumed_at"))
			this.#db.run("ALTER TABLE inbox ADD COLUMN consumed_at TEXT");
		if (!inboxColumns.some(column => column.name === "claim_token"))
			this.#db.run("ALTER TABLE inbox ADD COLUMN claim_token TEXT");
		if (!inboxColumns.some(column => column.name === "claimed_until_ms"))
			this.#db.run("ALTER TABLE inbox ADD COLUMN claimed_until_ms INTEGER");
		this.#db.run("CREATE INDEX IF NOT EXISTS inbox_claims ON inbox (claim_token, claimed_until_ms)");
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS receipts (
				mesh_message_id TEXT NOT NULL,
				status TEXT NOT NULL,
				receipt_json TEXT NOT NULL,
				recorded_at TEXT NOT NULL,
				PRIMARY KEY (mesh_message_id, status)
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS idempotency_tombstones (
				idempotency_key TEXT PRIMARY KEY NOT NULL,
				mesh_message_id TEXT NOT NULL UNIQUE,
				terminal_at TEXT NOT NULL,
				expires_at_ms INTEGER NOT NULL
			)
		`);
		this.#db.run(
			"CREATE INDEX IF NOT EXISTS idempotency_tombstones_expiry ON idempotency_tombstones (expires_at_ms)",
		);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				action TEXT NOT NULL,
				preview_json TEXT NOT NULL,
				direction TEXT,
				token_identifier TEXT,
				origin_harness TEXT,
				origin_session_id TEXT,
				created_at TEXT NOT NULL
			)
		`);
		const auditColumns = this.#db.prepare("PRAGMA table_info(audit)").all() as Array<{ name: string }>;
		for (const [name, type] of [
			["direction", "TEXT"],
			["token_identifier", "TEXT"],
			["origin_harness", "TEXT"],
			["origin_session_id", "TEXT"],
		] as const) {
			if (!auditColumns.some(column => column.name === name))
				this.#db.run(`ALTER TABLE audit ADD COLUMN ${name} ${type}`);
		}
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS prime_commands (
				command_id TEXT PRIMARY KEY NOT NULL,
				envelope_json TEXT NOT NULL,
				response_json TEXT,
				created_at TEXT NOT NULL
			)
		`);
	}
	#pruneAudit(): void {
		this.#db
			.prepare("DELETE FROM audit WHERE id IN " + "(SELECT id FROM audit ORDER BY id DESC LIMIT -1 OFFSET ?)")
			.run(MAX_AUDIT_ROWS);
	}
	#pruneIdempotencyTombstones(now: number): void {
		this.#db.prepare("DELETE FROM idempotency_tombstones WHERE expires_at_ms <= ?").run(now);
	}

	#pruneExpiredOmpPeers(now: number): void {
		this.#db.prepare("DELETE FROM omp_peers WHERE last_seen_ms <= ?").run(now - OMP_PEER_TTL_MS);
	}
	#pruneConsumedInbox(): void {
		this.#db
			.prepare(
				"DELETE FROM inbox WHERE rowid IN " +
					"(SELECT rowid FROM inbox WHERE consumed_at IS NOT NULL ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
			)
			.run(MAX_CONSUMED_INBOX_ROWS);
	}

	#pruneCompletedOutbox(): void {
		this.#db
			.prepare(
				"DELETE FROM outbox WHERE id IN " +
					"(SELECT id FROM outbox WHERE status = 'complete' ORDER BY id DESC LIMIT -1 OFFSET ?)",
			)
			.run(MAX_COMPLETED_OUTBOX_ROWS);
	}

	#pruneOrphanReceipts(): void {
		this.#db
			.prepare(
				"DELETE FROM receipts WHERE rowid IN " +
					"(SELECT r.rowid FROM receipts r " +
					"WHERE NOT EXISTS (SELECT 1 FROM outbox o WHERE o.mesh_message_id = r.mesh_message_id) " +
					"AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.mesh_message_id = r.mesh_message_id) " +
					"ORDER BY r.recorded_at DESC, r.rowid DESC LIMIT -1 OFFSET ?)",
			)
			.run(MAX_ORPHAN_RECEIPT_ROWS);
	}

	#enforceDatabaseFileModes(): void {
		chmodIfPresent(this.#databasePath, 0o600);
		chmodIfPresent(`${this.#databasePath}-wal`, 0o600);
		chmodIfPresent(`${this.#databasePath}-shm`, 0o600);
	}

	#commandRecord(row: CommandRow): PrimeCommandRecord {
		return {
			commandId: row.command_id,
			envelopeJson: row.envelope_json,
			responseJson: row.response_json,
			createdAt: row.created_at,
		};
	}

	#transition<T>(operation: () => T): T {
		let result: T;
		try {
			result = this.#db.transaction(operation).immediate();
		} finally {
			this.#enforceDatabaseFileModes();
		}
		return result;
	}
}
