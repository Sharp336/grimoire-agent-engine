import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "create-only-test-provider";
const WINNER_SECRET = "race-winner-api-key-secret";
const LOSER_SECRET = "race-loser-api-key-secret";
const SEEDED_SECRET = "seeded-api-key-secret";
const WORKER_MODE = process.env.PI_AI_CREATE_ONLY_WORKER === "1";

type PublicResult = {
	inserted: boolean;
	provider: string;
	rows: Array<{ id: number; type: AuthCredential["type"] }>;
};

const waitForFile = async (filePath: string): Promise<void> => {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			await fs.access(filePath);
			return;
		} catch {
			// This integration test coordinates separate Bun processes. Bun's
			// filesystem watcher does not reliably wake under the test runner.
			await Bun.sleep(10);
		}
	}
	throw new Error(`create-only barrier timed out waiting for ${path.basename(filePath)}`);
};

type ContentionChild = Bun.ReadableSubprocess;

const waitForFileWhileChildRuns = async (filePath: string, child: ContentionChild): Promise<void> => {
	const childFailure = child.exited.then(code => {
		throw new Error(`create-only worker exited before barrier (code=${code})`);
	});
	void childFailure.catch(() => undefined);
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			await fs.access(filePath);
			return;
		} catch {
			await Promise.race([childFailure, Bun.sleep(10)]);
		}
	}
	throw new Error(`create-only barrier timed out waiting for ${path.basename(filePath)}`);
};

const readContentionResult = async (child: ContentionChild): Promise<PublicResult> => {
	const code = await child.exited;
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
	]);
	if (code !== 0) throw new Error(`create-only worker failed (code=${code}): ${stderr}`);
	const line = stdout
		.split(/\r?\n/)
		.map(value => value.trim())
		.filter(value => value.length > 0)
		.at(-1);
	if (!line) throw new Error("create-only worker produced no result");
	return JSON.parse(line) as PublicResult;
};

const openStorage = async (dbPath: string): Promise<{ storage: AuthStorage; store: SqliteAuthCredentialStore }> => {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	return { storage: new AuthStorage(store), store };
};

const readRawCredential = (dbPath: string, provider: string): unknown => {
	const observer = new Database(dbPath);
	try {
		return observer
			.query("SELECT credential_type, data, identity_key FROM auth_credentials WHERE provider = ? ORDER BY id ASC")
			.all(provider);
	} finally {
		observer.close();
	}
};

const runContentionWorker = async (): Promise<void> => {
	const dbPath = process.env.PI_AI_CREATE_ONLY_DB;
	const barrierPath = process.env.PI_AI_CREATE_ONLY_BARRIER;
	const workerId = process.env.PI_AI_CREATE_ONLY_ID;
	const key = process.env.PI_AI_CREATE_ONLY_KEY;
	if (!dbPath || !barrierPath || !workerId || !key) throw new Error("create-only worker configuration missing");
	const { storage } = await openStorage(dbPath);
	try {
		await Bun.write(`${barrierPath}.ready.${workerId}`, "");
		await waitForFile(`${barrierPath}.start`);
		const result = storage.insertCredentialsIfProviderAbsent(PROVIDER, [{ type: "api_key", key }]);
		process.stdout.write(JSON.stringify(result));
	} finally {
		storage.close();
	}
};

if (WORKER_MODE) {
	await runContentionWorker();
} else {
	test("openExisting fails closed when the validated pathname is replaced before open", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-open-existing-swap-"));
		const dbPath = path.join(tempDir, "agent.db");
		const originalPath = path.join(tempDir, "validated.db");
		const attackerPath = path.join(tempDir, "attacker.db");
		try {
			const initialized = await openStorage(dbPath);
			await initialized.storage.set("validated-provider", {
				type: "api_key",
				key: "validated-before-swap",
			});
			initialized.storage.close();

			const attacker = await openStorage(attackerPath);
			await attacker.storage.set("attacker-provider", {
				type: "api_key",
				key: "attacker-before-swap",
			});
			const attackerBefore = readRawCredential(attackerPath, "attacker-provider");
			attacker.storage.close();

			const expected = await fs.lstat(dbPath);
			await expect(
				SqliteAuthCredentialStore.openExisting(dbPath, expected, {
					beforeOpen: async () => {
						await fs.rename(dbPath, originalPath);
						await fs.rename(attackerPath, dbPath);
					},
				}),
			).rejects.toBeInstanceOf(ConfigurationError);

			expect(readRawCredential(originalPath, "validated-provider")).toEqual([
				expect.objectContaining({ data: JSON.stringify({ key: "validated-before-swap" }) }),
			]);
			expect(readRawCredential(originalPath, "new-validated-provider")).toEqual([]);
			expect(readRawCredential(dbPath, "attacker-provider")).toEqual(attackerBefore);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	test("openExisting shares the canonical WAL namespace with a live OMP connection", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-open-existing-wal-"));
		const dbPath = path.join(tempDir, "agent.db");
		const live = await openStorage(dbPath);
		try {
			await live.storage.set("live-provider", { type: "api_key", key: "live-secret" });
			const expected = await fs.lstat(dbPath);
			const importer = await SqliteAuthCredentialStore.openExisting(dbPath, expected);
			try {
				expect(
					importer.insertCredentialsIfProviderAbsent("imported-provider", [
						{ type: "api_key", key: "imported-secret" },
					]),
				).toMatchObject({ inserted: true });
				expect(live.store.listAuthCredentials("imported-provider")).toEqual([
					expect.objectContaining({ credential: { type: "api_key", key: "imported-secret" } }),
				]);
			} finally {
				importer.close();
			}
		} finally {
			live.storage.close();
			await removeWithRetries(tempDir);
		}
	});

	test("cross-process create-only contention has one winner and durable state", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-create-only-race-"));
		const dbPath = path.join(tempDir, "agent.db");
		const initialized = await openStorage(dbPath);
		initialized.storage.close();
		const barrierPath = path.join(tempDir, "barrier");
		const environment = {
			...process.env,
			PI_AI_CREATE_ONLY_WORKER: "1",
			PI_AI_CREATE_ONLY_DB: dbPath,
			PI_AI_CREATE_ONLY_BARRIER: barrierPath,
		} as Record<string, string>;
		const children = [
			Bun.spawn([process.execPath, "test", import.meta.filename], {
				cwd: process.cwd(),
				env: { ...environment, PI_AI_CREATE_ONLY_ID: "a", PI_AI_CREATE_ONLY_KEY: WINNER_SECRET },
				stdout: "pipe",
				stderr: "pipe",
			}),
			Bun.spawn([process.execPath, "test", import.meta.filename], {
				cwd: process.cwd(),
				env: { ...environment, PI_AI_CREATE_ONLY_ID: "b", PI_AI_CREATE_ONLY_KEY: LOSER_SECRET },
				stdout: "pipe",
				stderr: "pipe",
			}),
		];
		try {
			await Promise.all([
				waitForFileWhileChildRuns(`${barrierPath}.ready.a`, children[0]!),
				waitForFileWhileChildRuns(`${barrierPath}.ready.b`, children[1]!),
			]);
			await Bun.write(`${barrierPath}.start`, "");
			const results = await Promise.all(children.map(readContentionResult));
			expect(results.filter(result => result.inserted)).toHaveLength(1);
			const winner = await SqliteAuthCredentialStore.open(dbPath);
			try {
				const stored = winner.listAuthCredentials(PROVIDER);
				expect(stored).toHaveLength(1);
				expect([WINNER_SECRET, LOSER_SECRET]).toContain(
					stored[0]?.credential.type === "api_key" ? stored[0].credential.key : "",
				);
				for (const result of results) {
					expect(result.rows).toEqual([{ id: stored[0]!.id, type: "api_key" }]);
					expect(JSON.stringify(result)).not.toContain(WINNER_SECRET);
					expect(JSON.stringify(result)).not.toContain(LOSER_SECRET);
				}
			} finally {
				winner.close();
			}
		} finally {
			for (const child of children) child.kill();
			await Promise.all(children.map(child => child.exited));
			await removeWithRetries(tempDir);
		}
	});

	test("create-only updates caches atomically and preserves all non-active state", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-create-only-semantics-"));
		const dbPath = path.join(tempDir, "agent.db");
		const first = await openStorage(dbPath);
		const second = await openStorage(dbPath);
		try {
			const firstGeneration = first.storage.getGeneration();
			const firstResult = first.storage.insertCredentialsIfProviderAbsent(PROVIDER, [
				{ type: "api_key", key: WINNER_SECRET },
			]);
			const secondGeneration = second.storage.getGeneration();
			const secondResult = second.storage.insertCredentialsIfProviderAbsent(PROVIDER, [
				{ type: "api_key", key: LOSER_SECRET },
			]);
			expect(firstResult.inserted).toBe(true);
			expect(secondResult.inserted).toBe(false);
			expect(first.storage.getGeneration()).toBeGreaterThan(firstGeneration);
			expect(second.storage.getGeneration()).toBeGreaterThan(secondGeneration);
			expect(second.storage.listStoredCredentials(PROVIDER)).toEqual(first.storage.listStoredCredentials(PROVIDER));

			const seededProvider = "seeded-create-only-provider";
			await first.storage.set(seededProvider, { type: "api_key", key: SEEDED_SECRET });
			const seededGeneration = first.storage.getGeneration();
			const seededBefore = readRawCredential(dbPath, seededProvider);
			const seededResult = first.storage.insertCredentialsIfProviderAbsent(seededProvider, [
				{ type: "api_key", key: "must-not-replace-seeded-key" },
			]);
			expect(seededResult.inserted).toBe(false);
			expect(first.storage.getGeneration()).toBe(seededGeneration);
			expect(readRawCredential(dbPath, seededProvider)).toEqual(seededBefore);
			expect(JSON.stringify(seededResult)).not.toContain(SEEDED_SECRET);
			expect(JSON.stringify(seededResult)).not.toContain("must-not-replace-seeded-key");

			const disabledProvider = "disabled-only-create-only-provider";
			await first.storage.set(disabledProvider, { type: "api_key", key: "disabled-api-key" });
			const disabledRow = first.store.listAuthCredentials(disabledProvider)[0]!;
			first.store.deleteAuthCredential(disabledRow.id, "test tombstone");
			const tombstonesBefore = await first.store.listDisabledCredentials(disabledProvider);
			const disabledResult = first.storage.insertCredentialsIfProviderAbsent(disabledProvider, [
				{ type: "api_key", key: "new-active-api-key" },
			]);
			expect(disabledResult.inserted).toBe(true);
			expect(first.store.listAuthCredentials(disabledProvider)).toHaveLength(1);
			expect(await first.store.listDisabledCredentials(disabledProvider)).toEqual(tombstonesBefore);

			const emptyProvider = "empty-create-only-provider";
			const emptyGeneration = first.storage.getGeneration();
			expect(first.storage.insertCredentialsIfProviderAbsent(emptyProvider, [])).toEqual({
				inserted: false,
				provider: emptyProvider,
				rows: [],
			});
			expect(first.storage.getGeneration()).toBe(emptyGeneration);
			expect(first.store.listAuthCredentials(emptyProvider)).toHaveLength(0);

			const oauthProvider = "oauth-dedupe-create-only-provider";
			const oauthRows = first.storage.insertCredentialsIfProviderAbsent(oauthProvider, [
				{
					type: "oauth",
					access: "old-access",
					refresh: "old-refresh",
					expires: Date.now() + 60_000,
					email: "same@example.com",
				},
				{
					type: "oauth",
					access: "new-access",
					refresh: "new-refresh",
					expires: Date.now() + 120_000,
					email: "same@example.com",
				},
			]);
			expect(oauthRows.rows).toHaveLength(1);
			expect(first.store.listAuthCredentials(oauthProvider)[0]?.credential).toMatchObject({ access: "new-access" });

			const malformedProvider = "malformed-create-only-provider";
			const malformed = {
				type: "oauth",
				access: "valid-access",
				refresh: 42,
				expires: Number.POSITIVE_INFINITY,
			} as unknown as AuthCredential;
			expect(() =>
				first.storage.insertCredentialsIfProviderAbsent(malformedProvider, [
					{ type: "api_key", key: "valid-batch-key" },
					malformed,
				]),
			).toThrow();
			expect(first.store.listAuthCredentials(malformedProvider)).toHaveLength(0);

			const unsupported = await openStorage(path.join(tempDir, "unsupported.db"));
			try {
				Object.defineProperty(unsupported.store as AuthCredentialStore, "insertCredentialsIfProviderAbsent", {
					configurable: true,
					value: undefined,
				});
				expect(() =>
					unsupported.storage.insertCredentialsIfProviderAbsent("unsupported-provider", [
						{ type: "api_key", key: "unsupported-key" },
					]),
				).toThrow(ConfigurationError);
			} finally {
				unsupported.storage.close();
			}

			const expectedRows = first.storage.listStoredCredentials(PROVIDER);
			first.storage.close();
			second.storage.close();
			const reopened = await openStorage(dbPath);
			try {
				await reopened.storage.reload();
				expect(reopened.storage.listStoredCredentials(PROVIDER)).toEqual(expectedRows);
			} finally {
				reopened.storage.close();
			}
		} finally {
			first.storage.close();
			second.storage.close();
			await removeWithRetries(tempDir);
		}
	});
}
