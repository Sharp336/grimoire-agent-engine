import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AuthGatewayAccessError,
	type AuthGatewayAclEffect,
	type AuthGatewayAclKind,
	type AuthGatewayAclRule,
	type AuthGatewayAuditEvent,
	type AuthGatewayAuditOutcome,
	type AuthGatewayIssuedToken,
	type AuthGatewayPool,
	type AuthGatewayPoolMember,
	type AuthGatewayPoolSelection,
	type AuthGatewayPoolStrategy,
	type AuthGatewayPrincipal,
	type AuthGatewayRole,
	type AuthGatewayRouteFamily,
	type AuthGatewayToken,
	type AuthGatewayUsageSummary,
	type AuthGatewayUser,
	normalizeAuthGatewayAclRule,
	normalizeAuthGatewayName,
	normalizeAuthGatewayPoolModel,
	normalizeAuthGatewayPoolStrategy,
	normalizeAuthGatewayRef,
	normalizeAuthGatewayRole,
} from "./access-control";
import { timingSafeEqual } from "./http";

const ACCESS_SCHEMA_VERSION = 1;
const DUMMY_TOKEN_DIGEST = new Uint8Array(32);
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const TOKEN_PREFIX = "omp_gw_";
const TOKEN_PUBLIC_BYTES = 12;
const TOKEN_SECRET_BYTES = 32;

export interface AuthGatewayAccessStore {
	close(): void;
	authenticateToken(rawToken: string): AuthGatewayPrincipal | null;
	createUser(input: {
		name: string;
		description?: string;
		owner?: string;
		role?: AuthGatewayRole;
		tokenLabel?: string;
	}): {
		user: AuthGatewayUser;
		token: AuthGatewayIssuedToken;
	};
	listUsers(): AuthGatewayUser[];
	getUser(ref: number | string): AuthGatewayUser | undefined;
	updateUser(
		ref: number | string,
		patch: {
			description?: string | null;
			owner?: string | null;
			role?: AuthGatewayRole;
			enabled?: boolean;
		},
	): AuthGatewayUser;
	deleteUser(ref: number | string): boolean;
	listUserTokens(userId: number): AuthGatewayToken[];
	addUserToken(userId: number, label?: string): AuthGatewayIssuedToken;
	rotateUserTokens(userId: number, label?: string): AuthGatewayIssuedToken;
	revokeUserToken(userId: number, tokenId: number): boolean;
	listAclRules(userId: number): AuthGatewayAclRule[];
	addAclRule(
		userId: number,
		input: {
			effect: AuthGatewayAclEffect;
			kind: AuthGatewayAclKind;
			pattern: string;
		},
	): { rule: AuthGatewayAclRule; created: boolean };
	deleteAclRule(userId: number, ruleId: number): boolean;
	createPool(input: {
		name: string;
		provider: string;
		model?: string;
		strategy?: AuthGatewayPoolStrategy;
	}): AuthGatewayPool;
	listPools(): AuthGatewayPool[];
	getPool(ref: number | string): AuthGatewayPool | undefined;
	updatePool(ref: number | string, patch: { name?: string; strategy?: AuthGatewayPoolStrategy }): AuthGatewayPool;
	deletePool(ref: number | string): boolean;
	addPoolCredential(poolId: number, credentialId: number): { pool: AuthGatewayPool; created: boolean };
	removePoolCredential(poolId: number, credentialId: number): boolean;
	bindUserPool(userId: number, poolId: number): { created: boolean };
	unbindUserPool(userId: number, poolId: number): boolean;
	listUserPools(userId: number): AuthGatewayPool[];
	resolveUserPoolSelection(userId: number, provider: string, qualifiedModel: string): AuthGatewayPoolSelection | null;
	listPoolUsers(poolId: number): AuthGatewayUser[];
	recordAudit(input: Omit<AuthGatewayAuditEvent, "id">): AuthGatewayAuditEvent;
	listAudit(query?: { userId?: number; limit?: number; before?: number }): {
		events: AuthGatewayAuditEvent[];
		nextBefore: number | null;
	};
	getUserUsage(userId: number, since?: number): AuthGatewayUsageSummary;
	counts(): { users: number; activeTokens: number; pools: number };
}

interface LastInsertRow {
	id: number;
}

interface CountRow {
	count: number;
}

interface UserRow {
	id: number;
	name: string;
	description: string | null;
	owner: string | null;
	role: AuthGatewayRole;
	enabled: number;
	created_at: number;
	updated_at: number;
	last_used_at: number | null;
}

interface TokenRow {
	id: number;
	user_id: number;
	public_id: string;
	token_hash: Uint8Array;
	label: string | null;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

interface TokenPrincipalRow extends TokenRow {
	user_name: string;
	user_role: AuthGatewayRole;
	user_enabled: number;
	user_last_used_at: number | null;
}

interface AclRuleRow {
	id: number;
	user_id: number;
	effect: AuthGatewayAclEffect;
	kind: AuthGatewayAclKind;
	pattern: string;
	created_at: number;
}

interface PoolRow {
	id: number;
	name: string;
	provider: string;
	model: string | null;
	strategy: AuthGatewayPoolStrategy;
	created_at: number;
	updated_at: number;
}

interface PoolWithMemberRow extends PoolRow {
	credential_id: number | null;
	position: number | null;
	member_created_at: number | null;
}

interface PoolSelectionRow {
	pool_id: number;
	provider: string;
	model: string | null;
	strategy: AuthGatewayPoolStrategy;
	credential_id: number | null;
	position: number | null;
}

interface PoolMemberRow {
	credential_id: number;
	position: number;
	created_at: number;
}

interface InsertedPoolCredentialRow {
	credential_id: number;
}

interface AuditRow {
	id: number;
	request_id: string;
	started_at: number;
	completed_at: number;
	user_id: number | null;
	user_name: string | null;
	token_id: number | null;
	method: string;
	path: string;
	route_family: AuthGatewayRouteFamily;
	requested_model: string | null;
	resolved_provider: string | null;
	resolved_model: string | null;
	credential_id: number | null;
	outcome: AuthGatewayAuditOutcome;
	status_code: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_usd: number;
	error_code: string | null;
}

interface UsageTotalRow {
	requests: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	total_tokens: number | null;
	cost_usd: number | null;
}

interface UsageSeriesRow {
	provider: string;
	model: string;
	requests: number;
	total_tokens: number | null;
	cost_usd: number | null;
}

interface BindingScopeRow {
	provider: string;
	model_key: string;
}

export class SqliteAuthGatewayAccessStore implements AuthGatewayAccessStore {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
		this.#initializeSchema();
	}

	static async open(dbPath: string): Promise<SqliteAuthGatewayAccessStore> {
		const dir = path.dirname(dbPath);
		const dirExists = await fs
			.stat(dir)
			.then(stat => stat.isDirectory())
			.catch(() => false);
		if (!dirExists) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}

		const maxAttempts = 4;
		const baseDelayMs = 100;
		let lastBusyError: Error | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			let db: Database | undefined;
			try {
				db = new Database(dbPath);
				try {
					await fs.chmod(dbPath, 0o600);
				} catch {
					// Best effort; chmod is not meaningful on every platform.
				}
				return new SqliteAuthGatewayAccessStore(db);
			} catch (error) {
				db?.close();
				if (!isSqliteBusyError(error)) throw error;
				lastBusyError = error instanceof Error ? error : new Error(String(error));
				if (attempt < maxAttempts - 1) {
					await Bun.sleep(baseDelayMs * 2 ** attempt);
				}
			}
		}
		throw new AuthGatewayAccessError(
			"invalid_request",
			`Failed to open auth gateway database at '${dbPath}' after ${maxAttempts} attempts: ${lastBusyError?.message}`,
		);
	}

	close(): void {
		try {
			Bun.gc(true);
			this.#db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {
			// Closing must remain best-effort for already-failed handles.
		}
		this.#db.close();
		Bun.gc(true);
	}

	authenticateToken(rawToken: string): AuthGatewayPrincipal | null {
		const parsed = parseManagedToken(rawToken);
		const presentedDigest = hashToken(rawToken);
		const row = parsed ? this.#findTokenPrincipal(parsed.publicId) : undefined;
		const storedDigest =
			row?.token_hash instanceof Uint8Array && row.token_hash.length === 32 ? row.token_hash : DUMMY_TOKEN_DIGEST;
		if (!timingSafeEqual(presentedDigest, storedDigest)) return null;
		if (!parsed) return null;

		const freshRow = this.#findTokenPrincipal(parsed.publicId);
		if (!freshRow || freshRow.revoked_at !== null || freshRow.user_enabled !== 1) return null;
		const now = Date.now();
		const cutoff = now - LAST_USED_WRITE_INTERVAL_MS;
		if (
			freshRow.last_used_at !== null &&
			freshRow.last_used_at > cutoff &&
			freshRow.user_last_used_at !== null &&
			freshRow.user_last_used_at > cutoff
		) {
			return mapTokenPrincipal(freshRow);
		}

		let principal: AuthGatewayPrincipal | null = null;
		this.#withImmediateTransaction(() => {
			let activeRow = this.#findTokenPrincipal(parsed.publicId);
			if (!activeRow || activeRow.revoked_at !== null || activeRow.user_enabled !== 1) return;
			if (
				activeRow.last_used_at !== null &&
				activeRow.last_used_at > cutoff &&
				activeRow.user_last_used_at !== null &&
				activeRow.user_last_used_at > cutoff
			) {
				principal = mapTokenPrincipal(activeRow);
				return;
			}
			if (activeRow.last_used_at === null || activeRow.last_used_at <= cutoff) {
				const tokenUpdate = this.#db
					.prepare(
						`UPDATE gateway_user_tokens
						SET last_used_at = ?
						WHERE id = ? AND revoked_at IS NULL
							AND (last_used_at IS NULL OR last_used_at <= ?)`,
					)
					.run(now, activeRow.id, cutoff);
				if (tokenUpdate.changes !== 1) return;
				activeRow = this.#findTokenPrincipal(parsed.publicId);
				if (!activeRow || activeRow.revoked_at !== null || activeRow.user_enabled !== 1) return;
			}
			if (activeRow.user_last_used_at === null || activeRow.user_last_used_at <= cutoff) {
				const userUpdate = this.#db
					.prepare(
						`UPDATE gateway_users
						SET last_used_at = ?, updated_at = ?
						WHERE id = ? AND enabled = 1
							AND (last_used_at IS NULL OR last_used_at <= ?)`,
					)
					.run(now, now, activeRow.user_id, cutoff);
				if (userUpdate.changes !== 1) return;
			}
			const finalRow = this.#findTokenPrincipal(parsed.publicId);
			if (!finalRow || finalRow.revoked_at !== null || finalRow.user_enabled !== 1) return;
			principal = mapTokenPrincipal(finalRow);
		});
		return principal;
	}

	createUser(input: {
		name: string;
		description?: string;
		owner?: string;
		role?: AuthGatewayRole;
		tokenLabel?: string;
	}): { user: AuthGatewayUser; token: AuthGatewayIssuedToken } {
		const name = normalizeAuthGatewayName(input.name, "user name");
		const role = normalizeAuthGatewayRole(input.role);
		const now = Date.now();
		return this.#mapConflict(() =>
			this.#withImmediateTransaction(() => {
				this.#db
					.prepare(
						"INSERT INTO gateway_users(name, description, owner, role, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
					)
					.run(name, input.description ?? null, input.owner ?? null, role, now, now);
				const user = this.#getUserById(this.#lastInsertId());
				if (!user) throw new AuthGatewayAccessError("not_found", "created user was not found");
				const token = this.#insertToken(user.id, input.tokenLabel, now);
				return { user, token };
			}),
		);
	}

	listUsers(): AuthGatewayUser[] {
		const rows = this.#db.prepare("SELECT * FROM gateway_users ORDER BY id ASC").all() as UserRow[];
		return rows.map(mapUser);
	}

	getUser(ref: number | string): AuthGatewayUser | undefined {
		const resolved = normalizeAuthGatewayRef(ref, "user");
		if ("id" in resolved) return this.#getUserById(resolved.id);
		return this.#getUserByName(resolved.name);
	}

	updateUser(
		ref: number | string,
		patch: {
			description?: string | null;
			owner?: string | null;
			role?: AuthGatewayRole;
			enabled?: boolean;
		},
	): AuthGatewayUser {
		const user = this.#requireUser(ref);
		const role = patch.role === undefined ? user.role : normalizeAuthGatewayRole(patch.role);
		const enabled = patch.enabled === undefined ? user.enabled : patch.enabled;
		const now = Date.now();
		this.#db
			.prepare(
				"UPDATE gateway_users SET description = ?, owner = ?, role = ?, enabled = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				patch.description === undefined ? user.description : patch.description,
				patch.owner === undefined ? user.owner : patch.owner,
				role,
				enabled ? 1 : 0,
				now,
				user.id,
			);
		return this.#requireUser(user.id);
	}

	deleteUser(ref: number | string): boolean {
		const user = this.getUser(ref);
		if (!user) return false;
		const result = this.#db.prepare("DELETE FROM gateway_users WHERE id = ?").run(user.id);
		return result.changes > 0;
	}

	listUserTokens(userId: number): AuthGatewayToken[] {
		this.#requireUser(userId);
		const rows = this.#db
			.prepare("SELECT * FROM gateway_user_tokens WHERE user_id = ? ORDER BY id ASC")
			.all(userId) as TokenRow[];
		return rows.map(mapToken);
	}

	addUserToken(userId: number, label?: string): AuthGatewayIssuedToken {
		this.#requireUser(userId);
		return this.#insertToken(userId, label, Date.now());
	}

	rotateUserTokens(userId: number, label?: string): AuthGatewayIssuedToken {
		this.#requireUser(userId);
		const now = Date.now();
		return this.#withImmediateTransaction(() => {
			this.#db
				.prepare("UPDATE gateway_user_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
				.run(now, userId);
			return this.#insertToken(userId, label, now);
		});
	}

	revokeUserToken(userId: number, tokenId: number): boolean {
		this.#requireUser(userId);
		const result = this.#db
			.prepare("UPDATE gateway_user_tokens SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL")
			.run(Date.now(), userId, tokenId);
		return result.changes > 0;
	}

	listAclRules(userId: number): AuthGatewayAclRule[] {
		this.#requireUser(userId);
		const rows = this.#db
			.prepare("SELECT * FROM gateway_acl_rules WHERE user_id = ? ORDER BY id ASC")
			.all(userId) as AclRuleRow[];
		return rows.map(mapAclRule);
	}

	addAclRule(
		userId: number,
		input: {
			effect: AuthGatewayAclEffect;
			kind: AuthGatewayAclKind;
			pattern: string;
		},
	): { rule: AuthGatewayAclRule; created: boolean } {
		this.#requireUser(userId);
		const rule = normalizeAuthGatewayAclRule(input);
		const existing = this.#findAclRule(userId, rule.effect, rule.kind, rule.pattern);
		if (existing) return { rule: existing, created: false };
		this.#db
			.prepare("INSERT INTO gateway_acl_rules(user_id, effect, kind, pattern, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(userId, rule.effect, rule.kind, rule.pattern, Date.now());
		const created = this.#findAclRule(userId, rule.effect, rule.kind, rule.pattern);
		if (!created) throw new AuthGatewayAccessError("not_found", "created ACL rule was not found");
		return { rule: created, created: true };
	}

	deleteAclRule(userId: number, ruleId: number): boolean {
		this.#requireUser(userId);
		const result = this.#db.prepare("DELETE FROM gateway_acl_rules WHERE user_id = ? AND id = ?").run(userId, ruleId);
		return result.changes > 0;
	}

	createPool(input: {
		name: string;
		provider: string;
		model?: string;
		strategy?: AuthGatewayPoolStrategy;
	}): AuthGatewayPool {
		const name = normalizeAuthGatewayName(input.name, "pool name");
		const provider = input.provider.trim();
		if (!provider || provider.includes("*"))
			throw new AuthGatewayAccessError("invalid_request", "provider is required");
		const model = normalizeAuthGatewayPoolModel(provider, input.model);
		const strategy = normalizeAuthGatewayPoolStrategy(input.strategy);
		const now = Date.now();
		return this.#mapConflict(() => {
			this.#db
				.prepare(
					"INSERT INTO gateway_pools(name, provider, model, strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(name, provider, model, strategy, now, now);
			return this.#requirePool(this.#lastInsertId());
		});
	}

	listPools(): AuthGatewayPool[] {
		const rows = this.#db.prepare("SELECT * FROM gateway_pools ORDER BY id ASC").all() as PoolRow[];
		return rows.map(row => this.#mapPool(row));
	}

	getPool(ref: number | string): AuthGatewayPool | undefined {
		const resolved = normalizeAuthGatewayRef(ref, "pool");
		const row = "id" in resolved ? this.#getPoolRowById(resolved.id) : this.#getPoolRowByName(resolved.name);
		return row ? this.#mapPool(row) : undefined;
	}

	updatePool(ref: number | string, patch: { name?: string; strategy?: AuthGatewayPoolStrategy }): AuthGatewayPool {
		const pool = this.#requirePool(ref);
		const name = patch.name === undefined ? pool.name : normalizeAuthGatewayName(patch.name, "pool name");
		const strategy = patch.strategy === undefined ? pool.strategy : normalizeAuthGatewayPoolStrategy(patch.strategy);
		const now = Date.now();
		this.#mapConflict(() => {
			this.#db
				.prepare("UPDATE gateway_pools SET name = ?, strategy = ?, updated_at = ? WHERE id = ?")
				.run(name, strategy, now, pool.id);
		});
		return this.#requirePool(pool.id);
	}

	deletePool(ref: number | string): boolean {
		const pool = this.getPool(ref);
		if (!pool) return false;
		const result = this.#db.prepare("DELETE FROM gateway_pools WHERE id = ?").run(pool.id);
		return result.changes > 0;
	}

	addPoolCredential(poolId: number, credentialId: number): { pool: AuthGatewayPool; created: boolean } {
		this.#requirePool(poolId);
		if (!Number.isInteger(credentialId) || credentialId <= 0) {
			throw new AuthGatewayAccessError("invalid_request", "credential id must be a positive integer");
		}
		const created = this.#withImmediateTransaction(() => {
			const existing = this.#db
				.prepare("SELECT 1 AS count FROM gateway_pool_credentials WHERE pool_id = ? AND credential_id = ?")
				.get(poolId, credentialId) as CountRow | undefined;
			if (existing) return false;

			const maxRow = this.#db
				.prepare("SELECT COUNT(*) AS count FROM gateway_pool_credentials WHERE pool_id = ?")
				.get(poolId) as CountRow | undefined;
			const inserted = this.#db
				.prepare(
					`INSERT INTO gateway_pool_credentials(pool_id, credential_id, position, created_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(pool_id, credential_id) DO NOTHING
					 RETURNING credential_id`,
				)
				.get(poolId, credentialId, maxRow?.count ?? 0, Date.now()) as InsertedPoolCredentialRow | undefined;
			return inserted != null;
		});
		return { pool: this.#requirePool(poolId), created };
	}

	removePoolCredential(poolId: number, credentialId: number): boolean {
		this.#requirePool(poolId);
		return this.#withImmediateTransaction(() => {
			const result = this.#db
				.prepare("DELETE FROM gateway_pool_credentials WHERE pool_id = ? AND credential_id = ?")
				.run(poolId, credentialId);
			if (result.changes === 0) return false;
			const rows = this.#db
				.prepare(
					"SELECT credential_id, position, created_at FROM gateway_pool_credentials WHERE pool_id = ? ORDER BY position ASC, credential_id ASC",
				)
				.all(poolId) as PoolMemberRow[];
			for (let position = 0; position < rows.length; position++) {
				this.#db
					.prepare("UPDATE gateway_pool_credentials SET position = ? WHERE pool_id = ? AND credential_id = ?")
					.run(position, poolId, rows[position]!.credential_id);
			}
			return true;
		});
	}

	bindUserPool(userId: number, poolId: number): { created: boolean } {
		return this.#mapConflict(() =>
			this.#withImmediateTransaction(() => {
				const user = this.#getUserById(userId);
				if (!user) throw new AuthGatewayAccessError("not_found", "user not found");
				if (user.role === "admin") {
					throw new AuthGatewayAccessError("invalid_request", "admin users cannot be bound to gateway pools");
				}
				const pool = this.#getPoolRowById(poolId);
				if (!pool) throw new AuthGatewayAccessError("not_found", "pool not found");
				const existing = this.#db
					.prepare("SELECT provider, model_key FROM gateway_user_pools WHERE user_id = ? AND pool_id = ?")
					.get(userId, poolId) as BindingScopeRow | undefined;
				if (existing) return { created: false };
				this.#db
					.prepare("INSERT INTO gateway_user_pools(user_id, pool_id, provider, model_key) VALUES (?, ?, ?, ?)")
					.run(userId, poolId, pool.provider, pool.model ?? "");
				return { created: true };
			}),
		);
	}

	unbindUserPool(userId: number, poolId: number): boolean {
		this.#requireUser(userId);
		this.#requirePool(poolId);
		const result = this.#db
			.prepare("DELETE FROM gateway_user_pools WHERE user_id = ? AND pool_id = ?")
			.run(userId, poolId);
		return result.changes > 0;
	}

	listUserPools(userId: number): AuthGatewayPool[] {
		this.#requireUser(userId);
		const rows = this.#db
			.prepare(
				`SELECT
					p.*,
					pc.credential_id,
					pc.position,
					pc.created_at AS member_created_at
				FROM gateway_user_pools up
				INNER JOIN gateway_pools p ON p.id = up.pool_id
				LEFT JOIN gateway_pool_credentials pc ON pc.pool_id = p.id
				WHERE up.user_id = ?
				ORDER BY CASE WHEN p.model IS NULL THEN 1 ELSE 0 END, p.id ASC, pc.position ASC, pc.credential_id ASC`,
			)
			.all(userId) as PoolWithMemberRow[];
		return this.#mapPoolsWithMembers(rows);
	}

	resolveUserPoolSelection(userId: number, provider: string, qualifiedModel: string): AuthGatewayPoolSelection | null {
		this.#requireUser(userId);
		const rows = this.#db
			.prepare(
				`WITH selected_binding AS (
					SELECT pool_id
					FROM gateway_user_pools
					WHERE user_id = ?
					  AND provider = ?
					  AND model_key IN (?, '')
					ORDER BY CASE WHEN model_key = ? THEN 0 ELSE 1 END
					LIMIT 1
				)
				SELECT
					p.id AS pool_id,
					p.provider,
					p.model,
					p.strategy,
					pc.credential_id,
					pc.position
				FROM selected_binding b
				INNER JOIN gateway_pools p ON p.id = b.pool_id
				LEFT JOIN gateway_pool_credentials pc ON pc.pool_id = p.id
				ORDER BY pc.position ASC, pc.credential_id ASC`,
			)
			.all(userId, provider, qualifiedModel, qualifiedModel) as PoolSelectionRow[];
		const first = rows[0];
		if (!first) return null;
		const credentialIds: number[] = [];
		for (const row of rows) {
			if (row.credential_id !== null) credentialIds.push(row.credential_id);
		}
		return {
			poolId: first.pool_id,
			provider: first.provider,
			qualifiedModel: first.model,
			strategy: first.strategy,
			credentialIds,
		};
	}

	listPoolUsers(poolId: number): AuthGatewayUser[] {
		this.#requirePool(poolId);
		const rows = this.#db
			.prepare(
				"SELECT u.* FROM gateway_users u INNER JOIN gateway_user_pools up ON up.user_id = u.id WHERE up.pool_id = ? ORDER BY u.id ASC",
			)
			.all(poolId) as UserRow[];
		return rows.map(mapUser);
	}

	recordAudit(input: Omit<AuthGatewayAuditEvent, "id">): AuthGatewayAuditEvent {
		const event = {
			...input,
			path: sanitizeAuditPath(input.path),
			errorCode: sanitizeAuditErrorCode(input.errorCode),
		};
		this.#db
			.prepare(
				`INSERT INTO gateway_audit_events(
					request_id, started_at, completed_at, user_id, user_name, token_id, method, path, route_family,
					requested_model, resolved_provider, resolved_model, credential_id, outcome, status_code,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, error_code
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				event.requestId,
				event.startedAt,
				event.completedAt,
				event.userId,
				event.userName,
				event.tokenId,
				event.method,
				event.path,
				event.routeFamily,
				event.requestedModel,
				event.resolvedProvider,
				event.resolvedModel,
				event.credentialId,
				event.outcome,
				event.statusCode,
				event.inputTokens,
				event.outputTokens,
				event.cacheReadTokens,
				event.cacheWriteTokens,
				event.totalTokens,
				event.costUsd,
				event.errorCode,
			);
		return this.#requireAudit(this.#lastInsertId());
	}

	listAudit(query: { userId?: number; limit?: number; before?: number } = {}): {
		events: AuthGatewayAuditEvent[];
		nextBefore: number | null;
	} {
		const limit = normalizeAuditLimit(query.limit);
		const userId = query.userId;
		const before = query.before;
		let rows: AuditRow[];
		if (userId !== undefined && before !== undefined) {
			rows = this.#db
				.prepare("SELECT * FROM gateway_audit_events WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
				.all(userId, before, limit) as AuditRow[];
		} else if (userId !== undefined) {
			rows = this.#db
				.prepare("SELECT * FROM gateway_audit_events WHERE user_id = ? ORDER BY id DESC LIMIT ?")
				.all(userId, limit) as AuditRow[];
		} else if (before !== undefined) {
			rows = this.#db
				.prepare("SELECT * FROM gateway_audit_events WHERE id < ? ORDER BY id DESC LIMIT ?")
				.all(before, limit) as AuditRow[];
		} else {
			rows = this.#db
				.prepare("SELECT * FROM gateway_audit_events ORDER BY id DESC LIMIT ?")
				.all(limit) as AuditRow[];
		}
		const events = rows.map(mapAuditEvent);
		const last = events[events.length - 1];
		return { events, nextBefore: events.length === limit && last ? last.id : null };
	}

	getUserUsage(userId: number, since = 0): AuthGatewayUsageSummary {
		this.#requireUser(userId);
		const totalRow = this.#db
			.prepare(
				`SELECT COUNT(*) AS requests,
					SUM(input_tokens) AS input_tokens,
					SUM(output_tokens) AS output_tokens,
					SUM(cache_read_tokens) AS cache_read_tokens,
					SUM(cache_write_tokens) AS cache_write_tokens,
					SUM(total_tokens) AS total_tokens,
					SUM(cost_usd) AS cost_usd
				FROM gateway_audit_events
				WHERE user_id = ? AND started_at >= ? AND outcome = 'success' AND route_family IN ('chat', 'messages', 'responses', 'pi-native') AND resolved_provider IS NOT NULL AND resolved_model IS NOT NULL`,
			)
			.get(userId, since) as UsageTotalRow | undefined;
		const seriesRows = this.#db
			.prepare(
				`SELECT resolved_provider AS provider,
					resolved_model AS model,
					COUNT(*) AS requests,
					SUM(total_tokens) AS total_tokens,
					SUM(cost_usd) AS cost_usd
				FROM gateway_audit_events
				WHERE user_id = ? AND started_at >= ? AND outcome = 'success' AND route_family IN ('chat', 'messages', 'responses', 'pi-native') AND resolved_provider IS NOT NULL AND resolved_model IS NOT NULL
				GROUP BY resolved_provider, resolved_model
				ORDER BY resolved_provider ASC, resolved_model ASC`,
			)
			.all(userId, since) as UsageSeriesRow[];
		return {
			userId,
			since,
			generatedAt: Date.now(),
			totals: {
				requests: totalRow?.requests ?? 0,
				inputTokens: totalRow?.input_tokens ?? 0,
				outputTokens: totalRow?.output_tokens ?? 0,
				cacheReadTokens: totalRow?.cache_read_tokens ?? 0,
				cacheWriteTokens: totalRow?.cache_write_tokens ?? 0,
				totalTokens: totalRow?.total_tokens ?? 0,
				costUsd: totalRow?.cost_usd ?? 0,
			},
			byProviderModel: seriesRows.map(row => ({
				provider: row.provider,
				model: row.model,
				requests: row.requests,
				totalTokens: row.total_tokens ?? 0,
				costUsd: row.cost_usd ?? 0,
			})),
		};
	}

	counts(): { users: number; activeTokens: number; pools: number } {
		const users = this.#count("gateway_users");
		const activeTokens = this.#count("gateway_user_tokens", "revoked_at IS NULL");
		const pools = this.#count("gateway_pools");
		return { users, activeTokens, pools };
	}

	#initializeSchema(): void {
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run("PRAGMA journal_mode=WAL");
		this.#db.run("PRAGMA synchronous=NORMAL");
		this.#db.run("PRAGMA foreign_keys=ON");
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_gateway_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO auth_gateway_schema_version(id, version) VALUES (1, ${ACCESS_SCHEMA_VERSION});
			CREATE TABLE IF NOT EXISTS gateway_users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 64 AND substr(name, 1, 1) GLOB '[a-z]' AND name NOT GLOB '*[^a-z0-9_-]*'),
				description TEXT,
				owner TEXT,
				role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
				enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_used_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_gateway_users_name ON gateway_users(name);
			CREATE TABLE IF NOT EXISTS gateway_user_tokens (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
				public_id TEXT NOT NULL UNIQUE,
				token_hash BLOB NOT NULL,
				label TEXT,
				created_at INTEGER NOT NULL,
				last_used_at INTEGER,
				revoked_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_gateway_user_tokens_public_id ON gateway_user_tokens(public_id);
			CREATE TABLE IF NOT EXISTS gateway_acl_rules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
				effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
				kind TEXT NOT NULL CHECK (kind IN ('provider', 'model', 'route')),
				pattern TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE(user_id, effect, kind, pattern)
			);
			CREATE INDEX IF NOT EXISTS idx_gateway_acl_rules_user_kind ON gateway_acl_rules(user_id, kind);
			CREATE TABLE IF NOT EXISTS gateway_pools (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 64 AND substr(name, 1, 1) GLOB '[a-z]' AND name NOT GLOB '*[^a-z0-9_-]*'),
				provider TEXT NOT NULL,
				model TEXT,
				strategy TEXT NOT NULL CHECK (strategy IN ('sticky-session', 'least-used', 'round-robin', 'failover')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS gateway_pool_credentials (
				pool_id INTEGER NOT NULL REFERENCES gateway_pools(id) ON DELETE CASCADE,
				credential_id INTEGER NOT NULL,
				position INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(pool_id, credential_id),
				UNIQUE(pool_id, position)
			);
			CREATE INDEX IF NOT EXISTS idx_gateway_pool_credentials_credential_id ON gateway_pool_credentials(credential_id);
			CREATE TABLE IF NOT EXISTS gateway_user_pools (
				user_id INTEGER NOT NULL REFERENCES gateway_users(id) ON DELETE CASCADE,
				pool_id INTEGER NOT NULL REFERENCES gateway_pools(id) ON DELETE CASCADE,
				provider TEXT NOT NULL,
				model_key TEXT NOT NULL,
				PRIMARY KEY(user_id, pool_id),
				UNIQUE(user_id, provider, model_key)
			);
			CREATE TABLE IF NOT EXISTS gateway_audit_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				request_id TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				completed_at INTEGER NOT NULL,
				user_id INTEGER,
				user_name TEXT,
				token_id INTEGER,
				method TEXT NOT NULL,
				path TEXT NOT NULL,
				route_family TEXT NOT NULL,
				requested_model TEXT,
				resolved_provider TEXT,
				resolved_model TEXT,
				credential_id INTEGER,
				outcome TEXT NOT NULL,
				status_code INTEGER NOT NULL,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				cost_usd REAL NOT NULL,
				error_code TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_gateway_audit_user_time ON gateway_audit_events(user_id, started_at DESC, id DESC);
			CREATE INDEX IF NOT EXISTS idx_gateway_audit_user_id ON gateway_audit_events(user_id, id DESC);
			CREATE INDEX IF NOT EXISTS idx_gateway_audit_provider_model_time ON gateway_audit_events(resolved_provider, resolved_model, started_at DESC);
		`);
	}

	#findTokenPrincipal(publicId: string): TokenPrincipalRow | undefined {
		return this.#db
			.prepare(
				`SELECT t.*, u.name AS user_name, u.role AS user_role, u.enabled AS user_enabled, u.last_used_at AS user_last_used_at
				FROM gateway_user_tokens t
				INNER JOIN gateway_users u ON u.id = t.user_id
				WHERE t.public_id = ?`,
			)
			.get(publicId) as TokenPrincipalRow | undefined;
	}

	#insertToken(userId: number, label: string | undefined, now: number): AuthGatewayIssuedToken {
		for (let attempt = 0; attempt < 8; attempt++) {
			const issued = generateManagedToken();
			try {
				this.#db
					.prepare(
						"INSERT INTO gateway_user_tokens(user_id, public_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
					)
					.run(userId, issued.publicId, hashToken(issued.value), label ?? null, now);
				const row = this.#getTokenById(this.#lastInsertId());
				if (!row) throw new AuthGatewayAccessError("not_found", "created token was not found");
				return { ...mapToken(row), value: issued.value };
			} catch (error) {
				if (attempt < 7 && isSqliteConstraintError(error)) continue;
				throw error;
			}
		}
		throw new AuthGatewayAccessError("conflict", "unable to allocate unique token id");
	}

	#lastInsertId(): number {
		const row = this.#db.prepare("SELECT last_insert_rowid() AS id").get() as LastInsertRow | undefined;
		if (!row) throw new AuthGatewayAccessError("not_found", "last insert id unavailable");
		return Number(row.id);
	}

	#getUserById(id: number): AuthGatewayUser | undefined {
		const row = this.#db.prepare("SELECT * FROM gateway_users WHERE id = ?").get(id) as UserRow | undefined;
		return row ? mapUser(row) : undefined;
	}

	#getUserByName(name: string): AuthGatewayUser | undefined {
		const row = this.#db.prepare("SELECT * FROM gateway_users WHERE name = ? COLLATE NOCASE").get(name) as
			| UserRow
			| undefined;
		return row ? mapUser(row) : undefined;
	}

	#requireUser(ref: number | string): AuthGatewayUser {
		const user = this.getUser(ref);
		if (!user) throw new AuthGatewayAccessError("not_found", "user not found");
		return user;
	}

	#getTokenById(id: number): TokenRow | undefined {
		return this.#db.prepare("SELECT * FROM gateway_user_tokens WHERE id = ?").get(id) as TokenRow | undefined;
	}

	#findAclRule(
		userId: number,
		effect: AuthGatewayAclEffect,
		kind: AuthGatewayAclKind,
		pattern: string,
	): AuthGatewayAclRule | undefined {
		const row = this.#db
			.prepare("SELECT * FROM gateway_acl_rules WHERE user_id = ? AND effect = ? AND kind = ? AND pattern = ?")
			.get(userId, effect, kind, pattern) as AclRuleRow | undefined;
		return row ? mapAclRule(row) : undefined;
	}

	#getPoolRowById(id: number): PoolRow | undefined {
		return this.#db.prepare("SELECT * FROM gateway_pools WHERE id = ?").get(id) as PoolRow | undefined;
	}

	#getPoolRowByName(name: string): PoolRow | undefined {
		return this.#db.prepare("SELECT * FROM gateway_pools WHERE name = ? COLLATE NOCASE").get(name) as
			| PoolRow
			| undefined;
	}

	#requirePool(ref: number | string): AuthGatewayPool {
		const pool = this.getPool(ref);
		if (!pool) throw new AuthGatewayAccessError("not_found", "pool not found");
		return pool;
	}

	#mapPool(row: PoolRow): AuthGatewayPool {
		const members = this.#db
			.prepare(
				"SELECT credential_id, position, created_at FROM gateway_pool_credentials WHERE pool_id = ? ORDER BY position ASC",
			)
			.all(row.id) as PoolMemberRow[];
		return {
			id: row.id,
			name: row.name,
			provider: row.provider,
			model: row.model,
			strategy: row.strategy,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			members: members.map(mapPoolMember),
		};
	}

	#mapPoolsWithMembers(rows: readonly PoolWithMemberRow[]): AuthGatewayPool[] {
		const pools = new Map<number, AuthGatewayPool>();
		for (const row of rows) {
			let pool = pools.get(row.id);
			if (!pool) {
				pool = {
					id: row.id,
					name: row.name,
					provider: row.provider,
					model: row.model,
					strategy: row.strategy,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					members: [],
				};
				pools.set(row.id, pool);
			}
			if (row.credential_id !== null && row.position !== null && row.member_created_at !== null) {
				pool.members.push({
					credentialId: row.credential_id,
					position: row.position,
					createdAt: row.member_created_at,
				});
			}
		}
		return [...pools.values()];
	}

	#requireAudit(id: number): AuthGatewayAuditEvent {
		const row = this.#db.prepare("SELECT * FROM gateway_audit_events WHERE id = ?").get(id) as AuditRow | undefined;
		if (!row) throw new AuthGatewayAccessError("not_found", "audit row not found");
		return mapAuditEvent(row);
	}

	#count(table: string, where?: string): number {
		if (!/^[a-z_]+$/.test(table)) throw new AuthGatewayAccessError("invalid_request", "invalid table name");
		if (where !== undefined && !/^[a-z_ ]+IS NULL$/.test(where)) {
			throw new AuthGatewayAccessError("invalid_request", "invalid count filter");
		}
		const sql = where
			? `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`
			: `SELECT COUNT(*) AS count FROM ${table}`;
		const row = this.#db.prepare(sql).get() as CountRow | undefined;
		return row?.count ?? 0;
	}

	#withImmediateTransaction<T>(fn: () => T): T {
		this.#db.run("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.#db.run("COMMIT");
			return result;
		} catch (error) {
			this.#db.run("ROLLBACK");
			throw error;
		}
	}

	#mapConflict<T>(fn: () => T): T {
		try {
			return fn();
		} catch (error) {
			if (isSqliteConstraintError(error)) {
				throw new AuthGatewayAccessError("conflict", sqliteMessage(error));
			}
			throw error;
		}
	}
}

function mapUser(row: UserRow): AuthGatewayUser {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		owner: row.owner,
		role: row.role,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at,
	};
}

function mapToken(row: TokenRow): AuthGatewayToken {
	return {
		id: row.id,
		userId: row.user_id,
		publicId: row.public_id,
		label: row.label,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
	};
}

function mapTokenPrincipal(row: TokenPrincipalRow): AuthGatewayPrincipal {
	return {
		kind: "managed",
		id: row.user_id,
		userId: row.user_id,
		name: row.user_name,
		role: row.user_role,
		tokenId: row.id,
	};
}

function mapAclRule(row: AclRuleRow): AuthGatewayAclRule {
	return {
		id: row.id,
		userId: row.user_id,
		effect: row.effect,
		kind: row.kind,
		pattern: row.pattern,
		createdAt: row.created_at,
	};
}

function mapPoolMember(row: PoolMemberRow): AuthGatewayPoolMember {
	return {
		credentialId: row.credential_id,
		position: row.position,
		createdAt: row.created_at,
	};
}

function mapAuditEvent(row: AuditRow): AuthGatewayAuditEvent {
	return {
		id: row.id,
		requestId: row.request_id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		userId: row.user_id,
		userName: row.user_name,
		tokenId: row.token_id,
		method: row.method,
		path: row.path,
		routeFamily: row.route_family,
		requestedModel: row.requested_model,
		resolvedProvider: row.resolved_provider,
		resolvedModel: row.resolved_model,
		credentialId: row.credential_id,
		outcome: row.outcome,
		statusCode: row.status_code,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheWriteTokens: row.cache_write_tokens,
		totalTokens: row.total_tokens,
		costUsd: row.cost_usd,
		errorCode: row.error_code,
	};
}

function parseManagedToken(rawToken: string): { publicId: string } | null {
	if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
	const body = rawToken.slice(TOKEN_PREFIX.length);
	const dot = body.indexOf(".");
	if (dot <= 0) return null;
	const publicId = body.slice(0, dot);
	const secret = body.slice(dot + 1);
	if (!/^[A-Za-z0-9_-]{16}$/.test(publicId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
	return { publicId };
}

function generateManagedToken(): { publicId: string; value: string } {
	const publicId = base64urlRandom(TOKEN_PUBLIC_BYTES);
	const secret = base64urlRandom(TOKEN_SECRET_BYTES);
	return { publicId, value: `${TOKEN_PREFIX}${publicId}.${secret}` };
}

function base64urlRandom(size: number): string {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

function hashToken(rawToken: string): Uint8Array {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(rawToken);
	return new Uint8Array(hasher.digest());
}

function sanitizeAuditPath(value: string): string {
	let pathOnly = value;
	try {
		if (/^https?:\/\//i.test(value)) pathOnly = new URL(value).pathname;
	} catch {
		pathOnly = value;
	}
	const query = pathOnly.indexOf("?");
	if (query >= 0) pathOnly = pathOnly.slice(0, query);
	const hash = pathOnly.indexOf("#");
	if (hash >= 0) pathOnly = pathOnly.slice(0, hash);
	return pathOnly || "/";
}

function sanitizeAuditErrorCode(value: string | null): string | null {
	if (value === null) return null;
	const normalized = value.trim();
	if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(normalized)) return null;
	if (/omp_gw_|sk-|secret|token|refresh|access/i.test(normalized)) return null;
	return normalized;
}

function normalizeAuditLimit(limit: number | undefined): number {
	if (limit === undefined) return 100;
	if (!Number.isInteger(limit) || limit <= 0)
		throw new AuthGatewayAccessError("invalid_request", "audit limit must be positive");
	return Math.min(limit, 1000);
}

function isSqliteBusyError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return typeof error.code === "string" && error.code.startsWith("SQLITE_BUSY");
}

function isSqliteConstraintError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT");
}

function sqliteMessage(error: unknown): string {
	if (!error || typeof error !== "object" || !("message" in error)) return "constraint failed";
	return typeof error.message === "string" ? error.message : "constraint failed";
}
