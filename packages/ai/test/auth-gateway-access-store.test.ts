import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthGatewayAccessError,
	type AuthGatewayAuditEvent,
	evaluateAuthGatewayAccess,
	evaluateAuthGatewayRouteAccess,
	resolveAuthGatewayPoolSelection,
	SqliteAuthGatewayAccessStore,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { removeWithRetries } from "../../utils/src/temp";

interface CountRow {
	count: number;
}

interface VersionRow {
	version: number;
}

function readSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_gateway_schema_version WHERE id = 1").get() as
			| VersionRow
			| undefined;
		return row?.version ?? null;
	} finally {
		db.close();
	}
}

function countRows(dbPath: string, table: string): number {
	if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name ${table}`);
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow | undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function indexExists(dbPath: string, indexName: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT 1 AS count FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) as
			| CountRow
			| undefined;
		return row != null;
	} finally {
		db.close();
	}
}

function assertAccessError(error: unknown, code: "invalid_request" | "not_found" | "conflict"): void {
	expect(error).toBeInstanceOf(AuthGatewayAccessError);
	if (error instanceof AuthGatewayAccessError) {
		expect(error.code).toBe(code);
	}
}

function eventInput(patch: Partial<Omit<AuthGatewayAuditEvent, "id">> = {}): Omit<AuthGatewayAuditEvent, "id"> {
	return {
		requestId: `req-${Math.random()}`,
		startedAt: 1_700_000_000_000,
		completedAt: 1_700_000_000_123,
		userId: null,
		userName: null,
		tokenId: null,
		method: "POST",
		path: "/v1/chat/completions",
		routeFamily: "chat",
		requestedModel: null,
		resolvedProvider: null,
		resolvedModel: null,
		credentialId: null,
		outcome: "success",
		statusCode: 200,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		errorCode: null,
		...patch,
	};
}

describe("SqliteAuthGatewayAccessStore", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthGatewayAccessStore;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gateway-access-"));
		dbPath = path.join(tempDir, "auth-gateway.db");
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
	});

	afterEach(async () => {
		setSystemTime();
		vi.useRealTimers();
		store?.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("creates users with stable ids and one-time managed tokens that authenticate after reopen", async () => {
		const alice = store.createUser({ name: "alice", description: "primary", owner: "team-a", tokenLabel: "laptop" });
		const bob = store.createUser({ name: "bob" });

		expect(alice.user.id).not.toBe(bob.user.id);
		expect(alice.user.name).toBe("alice");
		expect(alice.token.userId).toBe(alice.user.id);
		expect(alice.token.value).toMatch(/^omp_gw_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
		expect(bob.token.value).toMatch(/^omp_gw_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
		expect(alice.token.value).not.toBe(bob.token.value);
		expect(readSchemaVersion(dbPath)).toBe(1);
		expect(store.counts()).toEqual({ users: 2, activeTokens: 2, pools: 0 });

		const listedAlice = store.listUsers().find(user => user.id === alice.user.id);
		expect(JSON.stringify(listedAlice)).not.toContain(alice.token.value);
		expect(JSON.stringify(store.getUser("alice"))).not.toContain(alice.token.value);
		expect(JSON.stringify(store.listUserTokens(alice.user.id))).not.toContain(alice.token.value);

		const principal = store.authenticateToken(alice.token.value);
		expect(principal).toMatchObject({ kind: "managed", userId: alice.user.id, name: "alice", role: "user" });
		expect(store.getUser(alice.user.id)?.lastUsedAt).toBeNumber();
		expect(store.listUserTokens(alice.user.id)[0]?.lastUsedAt).toBeNumber();

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		expect(store.getUser("999999")).toBeUndefined();
		expect(store.getUser(String(alice.user.id))?.id).toBe(alice.user.id);
	});

	test("throttles managed-token last-used writes for sixty seconds", () => {
		vi.useFakeTimers();
		const firstNow = 1_700_000_000_000;
		setSystemTime(firstNow);
		const alice = store.createUser({ name: "alice" });

		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		const firstUserLastUsedAt = store.getUser(alice.user.id)?.lastUsedAt;
		const firstTokenLastUsedAt = store.listUserTokens(alice.user.id)[0]?.lastUsedAt;
		expect(firstUserLastUsedAt).toBe(firstNow);
		expect(firstTokenLastUsedAt).toBe(firstNow);

		setSystemTime(firstNow + 30_000);
		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		expect(store.getUser(alice.user.id)?.lastUsedAt).toBe(firstUserLastUsedAt);
		expect(store.listUserTokens(alice.user.id)[0]?.lastUsedAt).toBe(firstTokenLastUsedAt);

		const refreshedNow = firstNow + 60_001;
		setSystemTime(refreshedNow);
		expect(store.authenticateToken(alice.token.value)).toMatchObject({
			userId: alice.user.id,
			tokenId: alice.token.id,
		});
		expect(store.getUser(alice.user.id)?.lastUsedAt).toBe(refreshedNow);
		expect(store.listUserTokens(alice.user.id)[0]?.lastUsedAt).toBe(refreshedNow);
	});

	test("rejects revoked tokens and disabled users inside the last-used throttle window", () => {
		vi.useFakeTimers();
		const firstNow = 1_700_000_000_000;
		setSystemTime(firstNow);
		const revoked = store.createUser({ name: "revoked" });
		const disabled = store.createUser({ name: "disabled" });

		expect(store.authenticateToken(revoked.token.value)?.userId).toBe(revoked.user.id);
		expect(store.authenticateToken(disabled.token.value)?.userId).toBe(disabled.user.id);

		setSystemTime(firstNow + 30_000);
		expect(store.revokeUserToken(revoked.user.id, revoked.token.id)).toBe(true);
		expect(store.authenticateToken(revoked.token.value)).toBeNull();

		store.updateUser(disabled.user.id, { enabled: false });
		expect(store.authenticateToken(disabled.token.value)).toBeNull();
	});

	test("recreates the additive audit cursor index when reopening a v1 database", async () => {
		expect(indexExists(dbPath, "idx_gateway_audit_user_id")).toBe(true);
		store.close();
		expect(readSchemaVersion(dbPath)).toBe(1);
		const db = new Database(dbPath);
		try {
			db.run("DROP INDEX IF EXISTS idx_gateway_audit_user_id");
		} finally {
			db.close();
		}
		expect(indexExists(dbPath, "idx_gateway_audit_user_id")).toBe(false);
		expect(readSchemaVersion(dbPath)).toBe(1);
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		expect(indexExists(dbPath, "idx_gateway_audit_user_id")).toBe(true);
		expect(readSchemaVersion(dbPath)).toBe(1);
	});

	test("isolates token add revoke rotate disable and delete per user", () => {
		const alice = store.createUser({ name: "alice" });
		const bob = store.createUser({ name: "bob" });
		const aliceSecond = store.addUserToken(alice.user.id, "phone");

		expect(aliceSecond.value).toMatch(/^omp_gw_/);
		expect(store.authenticateToken(alice.token.value)?.userId).toBe(alice.user.id);
		expect(store.authenticateToken(aliceSecond.value)?.userId).toBe(alice.user.id);
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		expect(store.revokeUserToken(alice.user.id, alice.token.id)).toBe(true);
		expect(store.authenticateToken(alice.token.value)).toBeNull();
		expect(store.authenticateToken(aliceSecond.value)?.userId).toBe(alice.user.id);
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		const rotated = store.rotateUserTokens(alice.user.id, "rotated");
		expect(rotated.value).toMatch(/^omp_gw_/);
		expect(store.authenticateToken(aliceSecond.value)).toBeNull();
		expect(store.authenticateToken(rotated.value)?.userId).toBe(alice.user.id);
		expect(store.listUserTokens(alice.user.id).filter(token => token.revokedAt === null)).toHaveLength(1);
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		store.updateUser(alice.user.id, { enabled: false });
		expect(store.authenticateToken(rotated.value)).toBeNull();
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);

		expect(store.deleteUser(alice.user.id)).toBe(true);
		expect(store.authenticateToken(rotated.value)).toBeNull();
		expect(store.authenticateToken(bob.token.value)?.userId).toBe(bob.user.id);
		expect(countRows(dbPath, "gateway_user_tokens")).toBe(1);
	});

	test("does not authenticate tokens revoked during the last-used write", () => {
		const alice = store.createUser({ name: "alice" });
		const triggerDb = new Database(dbPath);
		try {
			triggerDb.run(`
				CREATE TRIGGER revoke_during_auth
				BEFORE UPDATE OF last_used_at ON gateway_user_tokens
				WHEN OLD.revoked_at IS NULL
				BEGIN
					UPDATE gateway_user_tokens SET revoked_at = 123 WHERE id = OLD.id;
				END
			`);
			expect(store.authenticateToken(alice.token.value)).toBeNull();
			const [token] = store.listUserTokens(alice.user.id);
			expect(token?.revokedAt).toBe(123);
			expect(store.getUser(alice.user.id)?.lastUsedAt).toBeNull();
		} finally {
			triggerDb.run("DROP TRIGGER IF EXISTS revoke_during_auth");
			triggerDb.close();
		}
	});

	test("validates names case-insensitively and rejects invalid refs and disabled credentials", () => {
		const alice = store.createUser({ name: "Alice" });
		expect(alice.user.name).toBe("alice");
		expect(() => store.createUser({ name: "ALICE" })).toThrow(AuthGatewayAccessError);
		try {
			store.createUser({ name: "ALICE" });
		} catch (error) {
			assertAccessError(error, "conflict");
		}

		for (const name of ["", "1alice", "_alice", "alice!", "a".repeat(65)]) {
			try {
				store.createUser({ name });
			} catch (error) {
				assertAccessError(error, "invalid_request");
			}
		}

		const db = new Database(dbPath);
		try {
			expect(() =>
				db
					.prepare(
						"INSERT INTO gateway_users(name, role, enabled, created_at, updated_at) VALUES (?, 'user', 1, 1, 1)",
					)
					.run("bad!"),
			).toThrow();
			expect(() =>
				db
					.prepare(
						"INSERT INTO gateway_pools(name, provider, strategy, created_at, updated_at) VALUES (?, 'anthropic', 'failover', 1, 1)",
					)
					.run("1bad"),
			).toThrow();
		} finally {
			db.close();
		}

		store.updateUser("alice", { enabled: false });
		expect(store.authenticateToken(alice.token.value)).toBeNull();
		expect(() => store.updateUser("missing", { enabled: true })).toThrow(AuthGatewayAccessError);
	});

	test("evaluates ACL deny precedence default deny route gates and admin bypass", () => {
		const alice = store.createUser({ name: "alice" });
		const principal = store.authenticateToken(alice.token.value);
		expect(principal).not.toBeNull();
		if (!principal) throw new Error("expected managed principal");

		expect(
			evaluateAuthGatewayAccess(principal, [], {
				route: "chat",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude",
			}),
		).toEqual({
			allowed: false,
			reason: "no_matching_allow",
		});
		expect(evaluateAuthGatewayRouteAccess(principal, [], "models", false)).toEqual({ allowed: true });
		expect(evaluateAuthGatewayRouteAccess(principal, [], "usage", true)).toEqual({
			allowed: false,
			reason: "route_denied",
		});

		store.addAclRule(alice.user.id, { effect: "allow", kind: "route", pattern: "chat" });
		store.addAclRule(alice.user.id, { effect: "allow", kind: "provider", pattern: "anthropic" });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "chat",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude-sonnet",
			}),
		).toEqual({ allowed: true });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "messages",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude-sonnet",
			}),
		).toEqual({ allowed: false, reason: "route_denied" });

		store.addAclRule(alice.user.id, { effect: "deny", kind: "model", pattern: "anthropic/claude-sonnet" });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "chat",
				provider: "anthropic",
				qualifiedModel: "anthropic/claude-sonnet",
			}),
		).toEqual({ allowed: false, reason: "model_denied" });

		store.addAclRule(alice.user.id, { effect: "allow", kind: "model", pattern: "openai/gpt-4o" });
		expect(
			evaluateAuthGatewayAccess(principal, store.listAclRules(alice.user.id), {
				route: "chat",
				provider: "openai",
				qualifiedModel: "openai/gpt-4o",
			}),
		).toEqual({ allowed: true });

		const admin = store.createUser({ name: "admin", role: "admin" });
		const adminPrincipal = store.authenticateToken(admin.token.value);
		expect(adminPrincipal).not.toBeNull();
		if (!adminPrincipal) throw new Error("expected admin principal");
		expect(
			evaluateAuthGatewayAccess(adminPrincipal, store.listAclRules(alice.user.id), {
				route: "usage",
				provider: "hidden",
				qualifiedModel: "hidden/model",
			}),
		).toEqual({ allowed: true });

		expect(() =>
			store.addAclRule(alice.user.id, { effect: "allow", kind: "model", pattern: "anthropic/claude*" }),
		).toThrow(AuthGatewayAccessError);
		expect(() => store.addAclRule(alice.user.id, { effect: "allow", kind: "route", pattern: "management" })).toThrow(
			AuthGatewayAccessError,
		);
	});

	test("binds deterministic provider and model pools with ordered members across reopen", async () => {
		const alice = store.createUser({ name: "alice" });
		const providerPool = store.createPool({
			name: "anthropic-default",
			provider: "anthropic",
			strategy: "round-robin",
		});
		const modelPool = store.createPool({
			name: "sonnet",
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			strategy: "failover",
		});

		store.addPoolCredential(providerPool.id, 20);
		store.addPoolCredential(providerPool.id, 10);
		store.addPoolCredential(providerPool.id, 20);
		store.addPoolCredential(modelPool.id, 30);
		expect(store.getPool(providerPool.id)?.members.map(member => member.credentialId)).toEqual([20, 10]);
		expect(store.bindUserPool(alice.user.id, providerPool.id)).toEqual({ created: true });
		expect(store.bindUserPool(alice.user.id, providerPool.id)).toEqual({ created: false });
		expect(store.bindUserPool(alice.user.id, modelPool.id)).toEqual({ created: true });
		expect(() =>
			store.bindUserPool(alice.user.id, store.createPool({ name: "anthropic-other", provider: "anthropic" }).id),
		).toThrow(AuthGatewayAccessError);

		const pools = store.listUserPools(alice.user.id);
		expect(resolveAuthGatewayPoolSelection(pools, "anthropic", "anthropic/claude-3-haiku")?.credentialIds).toEqual([
			20, 10,
		]);
		expect(resolveAuthGatewayPoolSelection(pools, "anthropic", "anthropic/claude-3-5-sonnet")?.credentialIds).toEqual(
			[30],
		);
		expect(resolveAuthGatewayPoolSelection(pools, "openai", "openai/gpt-4o")).toBeNull();

		expect(store.removePoolCredential(providerPool.id, 20)).toBe(true);
		expect(store.getPool(providerPool.id)?.members).toMatchObject([{ credentialId: 10, position: 0 }]);
		expect(() => store.updatePool(providerPool.id, { name: "sonnet" })).toThrow(AuthGatewayAccessError);

		const admin = store.createUser({ name: "admin", role: "admin" });
		expect(() => store.bindUserPool(admin.user.id, providerPool.id)).toThrow(AuthGatewayAccessError);
		store.updateUser(alice.user.id, { role: "admin" });
		expect(store.listUserPools(alice.user.id)).toHaveLength(2);
		store.updateUser(alice.user.id, { role: "user" });
		expect(store.listUserPools(alice.user.id)).toHaveLength(2);

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		expect(store.getPool("anthropic-default")?.members.map(member => member.credentialId)).toEqual([10]);
		expect(
			resolveAuthGatewayPoolSelection(store.listUserPools(alice.user.id), "anthropic", "anthropic/claude-3-5-sonnet")
				?.poolId,
		).toBe(modelPool.id);
	});

	test("resolves the winning user pool selection with ordered members", () => {
		const alice = store.createUser({ name: "selection" });
		const providerPool = store.createPool({
			name: "anthropic-wide",
			provider: "anthropic",
			strategy: "round-robin",
		});
		const exactPool = store.createPool({
			name: "anthropic-sonnet",
			provider: "anthropic",
			model: "claude-3-5-sonnet",
			strategy: "failover",
		});
		const emptyExactPool = store.createPool({
			name: "openai-gpt4o",
			provider: "openai",
			model: "gpt-4o",
			strategy: "least-used",
		});

		store.addPoolCredential(providerPool.id, 20);
		store.addPoolCredential(providerPool.id, 10);
		store.addPoolCredential(exactPool.id, 30);
		store.addPoolCredential(exactPool.id, 25);
		store.bindUserPool(alice.user.id, providerPool.id);
		store.bindUserPool(alice.user.id, exactPool.id);
		store.bindUserPool(alice.user.id, emptyExactPool.id);

		expect(store.resolveUserPoolSelection(alice.user.id, "anthropic", "anthropic/claude-3-5-sonnet")).toEqual({
			poolId: exactPool.id,
			provider: "anthropic",
			qualifiedModel: "anthropic/claude-3-5-sonnet",
			strategy: "failover",
			credentialIds: [30, 25],
		});
		expect(store.resolveUserPoolSelection(alice.user.id, "anthropic", "anthropic/claude-3-haiku")).toEqual({
			poolId: providerPool.id,
			provider: "anthropic",
			qualifiedModel: null,
			strategy: "round-robin",
			credentialIds: [20, 10],
		});
		expect(store.resolveUserPoolSelection(alice.user.id, "openai", "openai/gpt-4o")).toEqual({
			poolId: emptyExactPool.id,
			provider: "openai",
			qualifiedModel: "openai/gpt-4o",
			strategy: "least-used",
			credentialIds: [],
		});
		expect(store.resolveUserPoolSelection(alice.user.id, "mock", "mock/model-a")).toBeNull();
	});

	test("treats a duplicate pool-member insert at the SQLite boundary as idempotent", async () => {
		const pool = store.createPool({ name: "primary", provider: "anthropic" });
		const triggerDb = new Database(dbPath);
		try {
			triggerDb.run(`
				CREATE TRIGGER simulate_pool_member_race
				BEFORE INSERT ON gateway_pool_credentials
				WHEN NEW.credential_id = 42 AND NEW.created_at >= 0
				BEGIN
					INSERT INTO gateway_pool_credentials(pool_id, credential_id, position, created_at)
					VALUES (NEW.pool_id, NEW.credential_id, NEW.position, -1);
				END
			`);
		} finally {
			triggerDb.close();
		}

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		try {
			const result = store.addPoolCredential(pool.id, 42);

			expect(result.created).toBe(false);
			expect(result.pool.members.map(member => member.credentialId)).toEqual([42]);
			expect(store.getPool(pool.id)?.members).toMatchObject([{ credentialId: 42, position: 0 }]);
		} finally {
			store.close();
			const cleanupDb = new Database(dbPath);
			try {
				cleanupDb.run("DROP TRIGGER IF EXISTS simulate_pool_member_race");
			} finally {
				cleanupDb.close();
			}
			store = await SqliteAuthGatewayAccessStore.open(dbPath);
		}
	});

	test("concurrent duplicate scope binds create one row and one conflict", async () => {
		const alice = store.createUser({ name: "alice" });
		const firstPool = store.createPool({ name: "primary", provider: "anthropic" });
		const secondPool = store.createPool({ name: "secondary", provider: "anthropic" });
		const secondStore = await SqliteAuthGatewayAccessStore.open(dbPath);
		try {
			const attempts = await Promise.allSettled([
				Promise.resolve().then(() => store.bindUserPool(alice.user.id, firstPool.id)),
				Promise.resolve().then(() => secondStore.bindUserPool(alice.user.id, secondPool.id)),
			]);
			const fulfilled = attempts.filter(result => result.status === "fulfilled");
			const rejected = attempts.filter(result => result.status === "rejected");
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			const reason = rejected[0]?.status === "rejected" ? rejected[0].reason : undefined;
			assertAccessError(reason, "conflict");
			expect(store.listUserPools(alice.user.id)).toHaveLength(1);
		} finally {
			secondStore.close();
		}
	});

	test("persists redacted audit rows and usage aggregates across reopen", async () => {
		const rawGatewayToken = "omp_gw_abcdefghijklmnop.secretsecretsecretsecretsecretsecretsecret1";
		const providerApiKey = "sk-provider-secret";
		const oauthAccess = "oauth-access-secret";
		const oauthRefresh = "oauth-refresh-secret";
		const alice = store.createUser({ name: "alice" });
		const bob = store.createUser({ name: "bob" });

		store.recordAudit(
			eventInput({
				requestId: "req-success-1",
				userId: alice.user.id,
				userName: alice.user.name,
				tokenId: alice.token.id,
				path: `/v1/chat/completions?token=${rawGatewayToken}#${providerApiKey}`,
				requestedModel: "anthropic/claude",
				resolvedProvider: "anthropic",
				resolvedModel: "claude",
				credentialId: 123,
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 3,
				cacheWriteTokens: 2,
				totalTokens: 20,
				costUsd: 0.25,
				errorCode: `${oauthAccess}-${oauthRefresh}`,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-success-2",
				userId: alice.user.id,
				userName: alice.user.name,
				requestedModel: "anthropic/haiku",
				resolvedProvider: "anthropic",
				resolvedModel: "haiku",
				credentialId: 124,
				inputTokens: 1,
				outputTokens: 2,
				totalTokens: 3,
				costUsd: 0.5,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-models-list",
				userId: alice.user.id,
				userName: alice.user.name,
				routeFamily: "models",
				requestedModel: "anthropic/list",
				resolvedProvider: "anthropic",
				resolvedModel: "list",
				totalTokens: 100,
				costUsd: 10,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-denied",
				userId: alice.user.id,
				userName: alice.user.name,
				outcome: "denied_by_acl",
				statusCode: 403,
				resolvedProvider: "anthropic",
				resolvedModel: "hidden",
				totalTokens: 999,
				costUsd: 99,
			}),
		);
		store.recordAudit(
			eventInput({
				requestId: "req-bob",
				userId: bob.user.id,
				userName: bob.user.name,
				resolvedProvider: "openai",
				resolvedModel: "gpt-4o",
				totalTokens: 7,
				costUsd: 0.07,
			}),
		);

		store.close();
		store = await SqliteAuthGatewayAccessStore.open(dbPath);
		const globalPage = store.listAudit({ limit: 3 });
		expect(globalPage.events.map(event => event.requestId)).toEqual(["req-bob", "req-denied", "req-models-list"]);
		expect(globalPage.nextBefore).toBeNumber();
		const globalNextPage = store.listAudit({ limit: 3, before: globalPage.nextBefore ?? undefined });
		expect(globalNextPage.events.map(event => event.requestId)).toEqual(["req-success-2", "req-success-1"]);
		expect(globalNextPage.events.every(event => event.id < (globalPage.nextBefore ?? 0))).toBe(true);
		expect(globalNextPage.nextBefore).toBeNull();

		const page = store.listAudit({ userId: alice.user.id, limit: 3 });
		expect(page.events).toHaveLength(3);
		expect(page.events.map(event => event.requestId)).toEqual(["req-denied", "req-models-list", "req-success-2"]);
		expect(page.nextBefore).toBeNumber();
		expect(page.events[0]?.id).toBeGreaterThan(page.events[1]?.id ?? 0);
		const nextPage = store.listAudit({ userId: alice.user.id, limit: 3, before: page.nextBefore ?? undefined });
		expect(nextPage.events.map(event => event.requestId)).toEqual(["req-success-1"]);
		expect(nextPage.events.every(event => event.id < (page.nextBefore ?? 0))).toBe(true);
		expect(nextPage.nextBefore).toBeNull();

		const serializedAudit = JSON.stringify(store.listAudit({ limit: 100 }));
		expect(serializedAudit).not.toContain(rawGatewayToken);
		expect(serializedAudit).not.toContain(providerApiKey);
		expect(serializedAudit).not.toContain(oauthAccess);
		expect(serializedAudit).not.toContain(oauthRefresh);
		expect(store.listAudit({ limit: 100 }).events.find(event => event.requestId === "req-success-1")?.path).toBe(
			"/v1/chat/completions",
		);
		expect(
			store.listAudit({ limit: 100 }).events.find(event => event.requestId === "req-success-1")?.errorCode,
		).toBeNull();

		const usage = store.getUserUsage(alice.user.id);
		expect(usage.userId).toBe(alice.user.id);
		expect(usage.since).toBe(0);
		expect(usage.totals).toEqual({
			requests: 2,
			inputTokens: 11,
			outputTokens: 7,
			cacheReadTokens: 3,
			cacheWriteTokens: 2,
			totalTokens: 23,
			costUsd: 0.75,
		});
		expect(usage.byProviderModel).toEqual([
			{ provider: "anthropic", model: "claude", requests: 1, totalTokens: 20, costUsd: 0.25 },
			{ provider: "anthropic", model: "haiku", requests: 1, totalTokens: 3, costUsd: 0.5 },
		]);
	});
});
