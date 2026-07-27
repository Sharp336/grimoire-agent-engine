import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const PROVIDER_KEY = "anthropic:oauth";
const CODEX_PROVIDER = "openai-codex";
const CODEX_PROVIDER_KEY = "openai-codex:oauth";
const FUTURE_BLOCK_MS = 1_899_999_999_000;
const EXPIRED_BLOCK_MS = 1;
const LEGACY_TIMESTAMP = 1_700_000_000;

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function readAuthSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function tableExists(dbPath: string, tableName: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName) as { present?: number } | undefined;
		return row?.present === 1;
	} finally {
		db.close();
	}
}

function readCredentialBlockRows(dbPath: string): Array<{
	credential_id: number;
	provider_key: string;
	block_scope: string;
	blocked_until_ms: number;
	updated_at: number;
}> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks ORDER BY credential_id, provider_key, block_scope",
			)
			.all() as Array<{
			credential_id: number;
			provider_key: string;
			block_scope: string;
			blocked_until_ms: number;
			updated_at: number;
		}>;
	} finally {
		db.close();
	}
}

describe("AuthStorage credential block persistence", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-blocks-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("honors scoped and unscoped blocks written by a previous AuthStorage instance", async () => {
		const firstStore = await SqliteAuthCredentialStore.open(dbPath);
		firstStore.saveOAuth(PROVIDER, oauthCredential("1"));
		firstStore.saveOAuth(PROVIDER, oauthCredential("2"));
		firstStore.saveOAuth(PROVIDER, oauthCredential("3"));
		const rows = firstStore.listAuthCredentials(PROVIDER);
		const firstStorage = new AuthStorage(firstStore);
		await firstStorage.reload();
		try {
			firstStorage.upsertCredentialBlock({
				credentialId: rows[0]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			firstStorage.upsertCredentialBlock({
				credentialId: rows[1]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		} finally {
			firstStorage.close();
		}

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedStorage = new AuthStorage(reopenedStore);
		await reopenedStorage.reload();
		try {
			const fableKey = await reopenedStorage.getApiKey(PROVIDER, "session-3", { modelId: "claude-fable-5" });
			expect(fableKey).toBe("access-3");
		} finally {
			reopenedStorage.close();
		}
	});

	it("keeps the later expiry when a shorter block is upserted for the same key", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			const longerBlock = FUTURE_BLOCK_MS + 60_000;
			storage.upsertCredentialBlock({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: longerBlock,
			});
			storage.upsertCredentialBlock({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});

			// `updatedAtMs` is the row's DB write time (issue #4980: same-deadline
			// refreshes must be observable), so only its presence is asserted.
			expect(storage.listCredentialBlocks([row.id])).toEqual([
				{
					credentialId: row.id,
					providerKey: PROVIDER_KEY,
					blockScope: "tier:fable",
					blockedUntilMs: longerBlock,
					updatedAtMs: expect.any(Number),
				},
			]);
		} finally {
			storage.close();
		}
	});

	it("drops expired rows from reads and clears persisted blocks through the public delete wrapper", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			storage.upsertCredentialBlock({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			storage.upsertCredentialBlock({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: EXPIRED_BLOCK_MS,
			});

			expect(storage.listCredentialBlocks([row.id])).toEqual([
				{
					credentialId: row.id,
					providerKey: PROVIDER_KEY,
					blockScope: "tier:fable",
					blockedUntilMs: FUTURE_BLOCK_MS,
					updatedAtMs: expect.any(Number),
				},
			]);
			const generationBeforeScopedDelete = storage.getGeneration();
			storage.deleteCredentialBlock(row.id, PROVIDER_KEY, "tier:fable");
			expect(storage.listCredentialBlocks([row.id])).toEqual([]);
			expect(storage.getGeneration()).toBe(generationBeforeScopedDelete + 1);
			storage.upsertCredentialBlock({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});

			const generationBeforeDelete = storage.getGeneration();
			storage.deleteCredentialBlocks(row.id);
			expect(storage.listCredentialBlocks([row.id])).toEqual([]);
			expect(storage.getGeneration()).toBe(generationBeforeDelete + 1);
		} finally {
			storage.close();
		}
	});

	it("keeps a block attached to the same credential row after a sibling is disabled", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("1"));
		store.saveOAuth(PROVIDER, oauthCredential("2"));
		store.saveOAuth(PROVIDER, oauthCredential("3"));
		const rows = store.listAuthCredentials(PROVIDER);
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			storage.upsertCredentialBlock({
				credentialId: rows[1]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		} finally {
			storage.close();
		}

		const disablingStore = await SqliteAuthCredentialStore.open(dbPath);
		disablingStore.deleteAuthCredential(rows[0]!.id, "disabled for test");
		disablingStore.close();

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedStorage = new AuthStorage(reopenedStore);
		await reopenedStorage.reload();
		try {
			const key = await reopenedStorage.getApiKey(PROVIDER, "a");
			expect(key).toBe("access-3");
		} finally {
			reopenedStorage.close();
		}
	});

	it("normalizes legacy Codex shared blocks on every database open without changing schema", async () => {
		const setupStore = await SqliteAuthCredentialStore.open(dbPath);
		setupStore.saveOAuth(CODEX_PROVIDER, oauthCredential("codex"));
		setupStore.saveOAuth(PROVIDER, oauthCredential("anthropic"));
		const [codexRow] = setupStore.listAuthCredentials(CODEX_PROVIDER);
		const [anthropicRow] = setupStore.listAuthCredentials(PROVIDER);
		setupStore.close();
		if (!codexRow || !anthropicRow) throw new Error("expected credential rows");

		const sharedExpiryMs = FUTURE_BLOCK_MS + 60_000;
		const chatExpiryMs = FUTURE_BLOCK_MS + 120_000;
		const sparkExpiryMs = FUTURE_BLOCK_MS;
		const sharedUpdatedAt = LEGACY_TIMESTAMP;
		const chatUpdatedAt = LEGACY_TIMESTAMP - 100;
		const sparkUpdatedAt = LEGACY_TIMESTAMP + 100;
		const db = new Database(dbPath);
		try {
			const insert = db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			insert.run(codexRow.id, CODEX_PROVIDER_KEY, "shared", sharedExpiryMs, sharedUpdatedAt);
			insert.run(codexRow.id, CODEX_PROVIDER_KEY, "chat", chatExpiryMs, chatUpdatedAt);
			insert.run(codexRow.id, CODEX_PROVIDER_KEY, "spark", sparkExpiryMs, sparkUpdatedAt);
			insert.run(anthropicRow.id, PROVIDER_KEY, "shared", FUTURE_BLOCK_MS, LEGACY_TIMESTAMP);
			insert.finalize();
		} finally {
			db.close();
		}

		const expectedRows = [
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "chat",
				blocked_until_ms: chatExpiryMs,
				updated_at: sharedUpdatedAt,
			},
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "spark",
				blocked_until_ms: sharedExpiryMs,
				updated_at: sparkUpdatedAt,
			},
			{
				credential_id: anthropicRow.id,
				provider_key: PROVIDER_KEY,
				block_scope: "shared",
				blocked_until_ms: FUTURE_BLOCK_MS,
				updated_at: LEGACY_TIMESTAMP,
			},
		];

		const firstReopen = await SqliteAuthCredentialStore.open(dbPath);
		firstReopen.close();
		expect(readCredentialBlockRows(dbPath)).toEqual(expectedRows);
		expect(readAuthSchemaVersion(dbPath)).toBe(6);

		const secondReopen = await SqliteAuthCredentialStore.open(dbPath);
		secondReopen.close();
		expect(readCredentialBlockRows(dbPath)).toEqual(expectedRows);
		expect(readAuthSchemaVersion(dbPath)).toBe(6);
	});

	it("normalizes a legacy Codex shared block written after startup before returning a scoped read", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(CODEX_PROVIDER, oauthCredential("late"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;
		const db = new Database(dbPath);
		try {
			db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run(row.id, CODEX_PROVIDER_KEY, "shared", blockedUntilMs, LEGACY_TIMESTAMP);
		} finally {
			db.close();
		}

		expect(store.getCredentialBlock(row.id, CODEX_PROVIDER_KEY, "chat")).toBe(blockedUntilMs);
		expect(readCredentialBlockRows(dbPath)).toEqual([
			{
				credential_id: row.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "chat",
				blocked_until_ms: blockedUntilMs,
				updated_at: LEGACY_TIMESTAMP,
			},
			{
				credential_id: row.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "spark",
				blocked_until_ms: blockedUntilMs,
				updated_at: LEGACY_TIMESTAMP,
			},
		]);
		store.close();
	});

	it("normalizes a late legacy Codex shared block before calculating its scoped reconciliation time", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(CODEX_PROVIDER, oauthCredential("late-reconcile"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const insertedAtMs = Date.now();
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;
		const db = new Database(dbPath);
		try {
			db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run(row.id, CODEX_PROVIDER_KEY, "shared", blockedUntilMs, Math.floor(insertedAtMs / 1000));
		} finally {
			db.close();
		}

		const reconcileAfterMs = store.getCredentialBlockReconcileAfter(row.id, CODEX_PROVIDER_KEY, "chat");
		expect(reconcileAfterMs).toBeGreaterThan(insertedAtMs);
		expect(reconcileAfterMs).toBeLessThan(blockedUntilMs);
		expect(readCredentialBlockRows(dbPath).map(block => block.block_scope)).toEqual(["chat", "spark"]);
		store.close();
	});

	it("keeps steady-state Codex block reads read-only while another connection owns the writer lock", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(CODEX_PROVIDER, oauthCredential("read-only"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "chat",
			blockedUntilMs,
		});

		const writer = new Database(dbPath);
		let writerLocked = false;
		try {
			writer.run("BEGIN IMMEDIATE");
			writerLocked = true;

			expect(store.getCredentialBlock(row.id, CODEX_PROVIDER_KEY, "chat")).toBe(blockedUntilMs);
			const reconcileAfterMs = store.getCredentialBlockReconcileAfter(row.id, CODEX_PROVIDER_KEY, "chat");
			expect(reconcileAfterMs).toBeGreaterThan(Date.now());
			expect(reconcileAfterMs).toBeLessThan(blockedUntilMs);
		} finally {
			if (writerLocked) writer.run("ROLLBACK");
			writer.close();
			store.close();
		}
	});

	it("persists a Codex shared upsert as separate chat and Spark blocks", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(CODEX_PROVIDER, oauthCredential("upsert"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;

		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "shared",
			blockedUntilMs,
		});
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "shared",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});

		expect(store.listCredentialBlocks([row.id])).toEqual([
			{
				credentialId: row.id,
				providerKey: CODEX_PROVIDER_KEY,
				blockScope: "chat",
				blockedUntilMs,
				updatedAtMs: expect.any(Number),
			},
			{
				credentialId: row.id,
				providerKey: CODEX_PROVIDER_KEY,
				blockScope: "spark",
				blockedUntilMs,
				updatedAtMs: expect.any(Number),
			},
		]);
		expect(readCredentialBlockRows(dbPath).some(block => block.block_scope === "shared")).toBe(false);
		store.close();
	});

	it("backfills refresh leases for a v5 auth database", async () => {
		const legacyDb = new Database(dbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 5);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const expiresAtMs = Date.now() + 3_600_000;
			expect(migratedStore.tryAcquireCredentialRefreshLease(1, "test-owner", expiresAtMs)).toBe(true);
			expect(migratedStore.getCredentialRefreshLeaseExpiresAt(1)).toBe(expiresAtMs);
			expect(readAuthSchemaVersion(dbPath)).toBe(6);
		} finally {
			migratedStore.close();
		}
	});

	it("migrates a v4 auth database to current version 6 without dropping credential rows", async () => {
		const legacyDb = new Database(dbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 4);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				PROVIDER,
				"oauth",
				JSON.stringify({
					access: "legacy-access",
					refresh: "legacy-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "legacy-account",
					email: "legacy@example.com",
				}),
				null,
				"email:legacy@example.com",
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const rows = migratedStore.listAuthCredentials(PROVIDER);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.credential).toMatchObject({ type: "oauth", access: "legacy-access" });
			expect(readAuthSchemaVersion(dbPath)).toBe(6);
			expect(tableExists(dbPath, "auth_credential_blocks")).toBe(true);
		} finally {
			migratedStore.close();
		}
	});
});
