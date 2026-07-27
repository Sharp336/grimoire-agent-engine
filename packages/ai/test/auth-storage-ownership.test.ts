import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage, type SnapshotResponse, writeAuthBrokerSnapshotCache } from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const LOCAL_ENV = {
	OMP_AUTH_BROKER_URL: undefined,
	OMP_AUTH_BROKER_TOKEN: undefined,
	OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: undefined,
} as const;

const ROW = {
	id: 1,
	provider: "test-provider",
	credential: { type: "api_key", key: "test-key", source: "login" },
	disabledCause: null,
} satisfies StoredAuthCredential;

function makeStore(onClose: () => void = () => {}): AuthCredentialStore {
	return {
		close: onClose,
		cleanExpiredCache() {},
		listAuthCredentials: () => [ROW],
	} as unknown as AuthCredentialStore;
}

async function withTempDir(run: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-ownership-"));
	try {
		await run(tempDir);
	} finally {
		await removeWithRetries(tempDir);
	}
}

function snapshot(generatedAt: number): SnapshotResponse {
	return {
		generation: 1,
		generatedAt,
		serverNowMs: generatedAt,
		refresher: {
			enabled: false,
			intervalMs: 60_000,
			skewMs: 300_000,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [
			{
				id: ROW.id,
				provider: ROW.provider,
				credential: ROW.credential,
				identityKey: null,
				rotatesInMs: null,
			},
		],
	};
}

describe("AuthStorage store ownership", () => {
	test("borrowed close is idempotent and does not close the store", () => {
		const close = vi.fn();
		const storage = new AuthStorage(makeStore(close), { storeOwnership: "borrowed" });

		storage.close();
		storage.close();

		expect(close).toHaveBeenCalledTimes(0);
	});

	test("stores are owned by default and close exactly once", () => {
		const close = vi.fn();
		const storage = new AuthStorage(makeStore(close));

		storage.close();
		storage.close();

		expect(close).toHaveBeenCalledTimes(1);
	});

	test("create unconditionally owns the store it opens", async () => {
		const close = vi.fn();
		const store = makeStore(close);
		const open = vi
			.spyOn(SqliteAuthCredentialStore, "open")
			.mockResolvedValue(store as unknown as SqliteAuthCredentialStore);
		try {
			const storage = await AuthStorage.create("unused-agent.db", { storeOwnership: "borrowed" });
			storage.close();
			storage.close();
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			open.mockRestore();
		}
	});
});

describe("discoverAuthStorage local store factory", () => {
	test("remote discovery never invokes the local factory", async () => {
		await withTempDir(async tempDir => {
			const url = "https://broker.test.invalid";
			const token = "test-token";
			const cachePath = path.join(tempDir, "snapshot.enc");
			await writeAuthBrokerSnapshotCache({
				path: cachePath,
				url,
				token,
				snapshot: snapshot(Date.now()),
			});
			const factory = vi.fn(async () => makeStore());
			const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
			let storage: AuthStorage | undefined;
			try {
				await withEnv(
					{
						...LOCAL_ENV,
						OMP_AUTH_BROKER_URL: url,
						OMP_AUTH_BROKER_TOKEN: token,
						OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: "60000",
					},
					async () => {
						storage = await discoverAuthStorage({
							agentDir: tempDir,
							cachePath,
							localStoreFactory: factory,
							sourceLabel: "custom broker source",
						});
					},
				);
				expect(factory).toHaveBeenCalledTimes(0);
				expect(storage?.describeCredentialSource(ROW.provider)).toContain("custom broker source");
			} finally {
				storage?.close();
				fetch.mockRestore();
			}
		});
	});

	test("local discovery invokes the factory once and borrows its store", async () => {
		await withTempDir(async tempDir => {
			const close = vi.fn();
			const factory = vi.fn(async () => makeStore(close));
			await withEnv(LOCAL_ENV, async () => {
				const storage = await discoverAuthStorage({ agentDir: tempDir, localStoreFactory: factory });
				expect(factory).toHaveBeenCalledTimes(1);
				expect(storage.describeCredentialSource(ROW.provider)).toContain(`local ${getAgentDbPath(tempDir)}`);
				storage.close();
				storage.close();
				expect(close).toHaveBeenCalledTimes(0);
			});
		});
	});
});
