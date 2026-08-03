import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	REMOTE_REFRESH_SENTINEL,
	SqliteAuthCredentialStore,
	validateCredentialPayload,
} from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const FAR_EXPIRY = Date.now() + 60 * 60_000;

function oauthPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		access: "access-token",
		refresh: "refresh-token",
		expires: FAR_EXPIRY,
		...overrides,
	};
}

describe("validateCredentialPayload OAuth shape", () => {
	test("accepts a valid empty-refresh OAuth payload", () => {
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ refresh: "" })))).toBe(true);
	});

	test("accepts the remote refresh sentinel and long-lived finite expiry", () => {
		expect(
			validateCredentialPayload(
				"oauth",
				JSON.stringify(
					oauthPayload({
						refresh: REMOTE_REFRESH_SENTINEL,
						expires: Number.MAX_SAFE_INTEGER,
					}),
				),
			),
		).toBe(true);
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ expires: 0 })))).toBe(true);
	});

	test("rejects malformed OAuth fields", () => {
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ access: {} })))).toBe(false);
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ access: "" })))).toBe(false);
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ refresh: null })))).toBe(false);
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ refresh: 1 })))).toBe(false);
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ expires: "soon" })))).toBe(false);
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ expires: Number.NaN })))).toBe(false);
		expect(
			validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ expires: Number.POSITIVE_INFINITY }))),
		).toBe(false);
		expect(
			validateCredentialPayload(
				"oauth",
				JSON.stringify({
					access: "access-token",
					refresh: "refresh-token",
				}),
			),
		).toBe(false);
	});
});

describe("deserializeCredential agrees with validateCredentialPayload", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-credential-payload-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function insertRawOAuth(data: Record<string, unknown>): void {
		const db = new Database(dbPath);
		try {
			db.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)", [
				"anthropic",
				"oauth",
				JSON.stringify(data),
			]);
		} finally {
			db.close();
		}
	}

	test("rejects malformed OAuth rows at read time", () => {
		if (!store) throw new Error("test setup failed");
		insertRawOAuth(oauthPayload({ access: {} }));
		expect(store.listAuthCredentials("anthropic")).toEqual([]);
		expect(store.getOAuth("anthropic")).toBeNull();
		expect(validateCredentialPayload("oauth", JSON.stringify(oauthPayload({ access: {} })))).toBe(false);
	});

	test("accepts a valid empty-refresh OAuth row at read time", () => {
		if (!store) throw new Error("test setup failed");
		const payload = oauthPayload({ refresh: "" });
		insertRawOAuth(payload);
		expect(validateCredentialPayload("oauth", JSON.stringify(payload))).toBe(true);
		const rows = store.listAuthCredentials("anthropic");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "",
			expires: FAR_EXPIRY,
		});
		expect(store.getOAuth("anthropic")).toMatchObject({
			access: "access-token",
			refresh: "",
			expires: FAR_EXPIRY,
		});
	});
});
