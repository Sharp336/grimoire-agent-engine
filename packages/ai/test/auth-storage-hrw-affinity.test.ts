import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;
const SESSIONS = Array.from({ length: 128 }, (_value, index) => `hrw-session-${index}`);

async function selectBySession(storage: AuthStorage, provider: string): Promise<Map<string, string>> {
	const selected = new Map<string, string>();
	for (const sessionId of SESSIONS) {
		const apiKey = await storage.getApiKey(provider, sessionId);
		if (!apiKey) throw new Error(`expected an API key for ${sessionId}`);
		selected.set(sessionId, apiKey);
	}
	return selected;
}

async function assertLiveMutationAffinity(storage: AuthStorage, provider: string): Promise<void> {
	const existing: AuthCredential[] = [
		{ type: "api_key", key: "key-a", source: "login" },
		{ type: "api_key", key: "key-b", source: "login" },
		{ type: "api_key", key: "key-c", source: "login" },
	];
	const added: AuthCredential = { type: "api_key", key: "key-added", source: "login" };

	await storage.set(provider, existing);
	const before = await selectBySession(storage, provider);

	await storage.set(provider, [...existing, added]);
	const afterAddition = await selectBySession(storage, provider);
	const movedSessions = SESSIONS.filter(sessionId => before.get(sessionId) !== afterAddition.get(sessionId));
	const stableSessions = SESSIONS.filter(sessionId => before.get(sessionId) === afterAddition.get(sessionId));

	expect(movedSessions.length).toBeGreaterThan(0);
	expect(stableSessions.length).toBeGreaterThan(0);
	for (const sessionId of movedSessions) {
		expect(afterAddition.get(sessionId)).toBe(added.key);
	}

	const addedRow = storage
		.listStoredCredentials(provider)
		.find(row => row.credential.type === "api_key" && row.credential.key === added.key);
	if (!addedRow) throw new Error("expected the added credential to have a stored row");
	expect(await storage.removeCredential(provider, addedRow.id)).toBe(true);

	const afterRemoval = await selectBySession(storage, provider);
	for (const sessionId of stableSessions) {
		expect(afterRemoval.get(sessionId)).toBe(before.get(sessionId));
	}
	for (const sessionId of movedSessions) {
		expect(afterRemoval.get(sessionId)).toBe(before.get(sessionId));
	}
}

describe("AuthStorage HRW credential affinity", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByKey = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "zai",
		async fetchUsage(params) {
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;
			return usageByKey.get(apiKey) ?? null;
		},
		supports: params => params.provider === "zai" && params.credential.type === "api_key",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-hrw-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
		});
		usageByKey.clear();
	});

	afterEach(async () => {
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	test("preserves unranked sessions across live pool mutations", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await assertLiveMutationAffinity(authStorage, "unit-hrw-unranked");
	});

	test("preserves unaffected sessions when a filtered pool shifts stored positions", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-hrw-index-shift";
		await authStorage.set(provider, [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "non-login-interleave" },
			{ type: "api_key", key: "key-b", source: "login" },
			{ type: "api_key", key: "key-c", source: "login" },
		]);

		const before = await selectBySession(authStorage, provider);
		const removedSessions = SESSIONS.filter(sessionId => before.get(sessionId) === "key-b");
		const stableSessions = SESSIONS.filter(sessionId => before.get(sessionId) !== "key-b");
		expect(removedSessions.length).toBeGreaterThan(0);
		expect(stableSessions.length).toBeGreaterThan(0);
		expect([...before.values()]).not.toContain("non-login-interleave");

		const removedRow = authStorage
			.listStoredCredentials(provider)
			.find(row => row.credential.type === "api_key" && row.credential.key === "key-b");
		if (!removedRow) throw new Error("expected the middle login credential to have a stored row");
		expect(await authStorage.removeCredential(provider, removedRow.id)).toBe(true);

		const after = await selectBySession(authStorage, provider);
		for (const sessionId of stableSessions) {
			expect(after.get(sessionId)).toBe(before.get(sessionId));
		}
		for (const sessionId of removedSessions) {
			const selected = after.get(sessionId);
			if (!selected) throw new Error(`expected an API key for ${sessionId}`);
			expect(["key-a", "key-c"]).toContain(selected);
		}
	});

	test("preserves equal-ranked zai sessions across live pool mutations", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await assertLiveMutationAffinity(authStorage, "zai");
	});

	test("round-robins without sessionId in its existing order", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
			{ type: "api_key", key: "key-c", source: "login" },
		]);

		const keys: string[] = [];
		for (let index = 0; index < 6; index += 1) {
			const key = await authStorage.getApiKey("zai");
			if (key) keys.push(key);
		}

		expect(keys).toEqual(["key-a", "key-b", "key-c", "key-a", "key-b", "key-c"]);
	});
	test("round-robins empty sessionId as sessionless across equal-ranked candidates", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
			{ type: "api_key", key: "key-c", source: "login" },
		]);

		const keys: string[] = [];
		for (let index = 0; index < 6; index += 1) {
			const key = await authStorage.getApiKey("zai", "");
			if (key) keys.push(key);
		}

		expect(keys.length).toBe(6);
		expect(new Set(keys).size).toBe(3);
		for (let index = 0; index < keys.length; index += 1) {
			expect(keys[index]).toBe(keys[index % 3]);
		}
	});

	test("never reorders across differing rank tiers", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		await storage.set("zai", [
			{ type: "api_key", key: "key-exhausted", source: "login" },
			{ type: "api_key", key: "key-fresh", source: "login" },
		]);
		usageByKey.set("key-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: {
						id: "5h",
						label: "5 Hour",
						durationMs: 5 * HOUR_MS,
						resetsAt: Date.now() + HOUR_MS,
					},
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});
		usageByKey.set("key-fresh", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: {
						id: "5h",
						label: "5 Hour",
						durationMs: 5 * HOUR_MS,
						resetsAt: Date.now() + 2 * HOUR_MS,
					},
					amount: {
						unit: "requests",
						used: 20,
						limit: 100,
						remaining: 80,
						usedFraction: 0.2,
						remainingFraction: 0.8,
					},
					status: "ok",
				},
			],
		});

		for (let index = 0; index < 20; index += 1) {
			expect(await storage.getApiKey("zai", `tier-test-${index}`)).toBe("key-fresh");
		}
	});
});
