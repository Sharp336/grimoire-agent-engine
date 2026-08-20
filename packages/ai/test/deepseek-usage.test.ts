import { describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { deepseekUsageProvider } from "@oh-my-pi/pi-ai/usage/deepseek";

const BALANCE_FIXTURE = {
	is_available: true,
	balance_infos: [
		{
			currency: "USD",
			total_balance: "12.50",
			granted_balance: "2.50",
			topped_up_balance: "10.00",
		},
		{
			currency: "CNY",
			total_balance: "86.40",
			granted_balance: "6.40",
			topped_up_balance: "80.00",
		},
	],
};

function params(baseUrl?: string): UsageFetchParams {
	return {
		provider: "deepseek",
		credential: { type: "api_key", apiKey: "deepseek-test-key" },
		...(baseUrl ? { baseUrl } : {}),
	};
}

function emptyStore(): AuthCredentialStore {
	return {
		close() {},
		listAuthCredentials() {
			return [];
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return [];
		},
		upsertAuthCredentialForProvider() {
			return [];
		},
		deleteAuthCredentialsForProvider() {},
		getCache() {
			return null;
		},
		setCache() {},
		cleanExpiredCache() {},
	};
}

describe("DeepSeek usage provider", () => {
	it("fetches first-party balances with the API key and preserves each currency", async () => {
		let capturedUrl = "";
		let capturedAuthorization = "";
		const fetch: FetchImpl = async (input, init) => {
			capturedUrl = String(input);
			capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json(BALANCE_FIXTURE);
		};

		const report = await deepseekUsageProvider.fetchUsage(params("https://api.deepseek.com/v1"), { fetch });

		expect(capturedUrl).toBe("https://api.deepseek.com/user/balance");
		expect(capturedAuthorization).toBe("Bearer deepseek-test-key");
		expect(report).toMatchObject({
			provider: "deepseek",
			metadata: {
				endpoint: "https://api.deepseek.com/user/balance",
				isAvailable: true,
			},
			limits: [
				{
					id: "deepseek:balance:usd",
					label: "DeepSeek Balance (USD)",
					scope: { provider: "deepseek", shared: true },
					amount: { remaining: 12.5, unit: "usd" },
					status: "ok",
				},
				{
					id: "deepseek:balance:cny",
					label: "DeepSeek Balance (CNY)",
					scope: { provider: "deepseek", shared: true },
					amount: { remaining: 86.4, unit: "unknown" },
					status: "ok",
				},
			],
		});
	});

	it("marks every balance exhausted when DeepSeek says the key is unavailable", async () => {
		const fetch: FetchImpl = async () => Response.json({ ...BALANCE_FIXTURE, is_available: false });

		const report = await deepseekUsageProvider.fetchUsage(params(), { fetch });

		expect(report?.limits.map(limit => limit.status)).toEqual(["exhausted", "exhausted"]);
	});

	it("marks an available zero balance exhausted", async () => {
		const payload = {
			is_available: true,
			balance_infos: [
				{
					currency: "USD",
					total_balance: "0.00",
					granted_balance: "0.00",
					topped_up_balance: "0.00",
				},
			],
		};
		const fetch: FetchImpl = async () => Response.json(payload);

		const report = await deepseekUsageProvider.fetchUsage(params(), { fetch });

		expect(report?.limits[0]?.status).toBe("exhausted");
	});

	it("never contacts a DeepSeek-labelled third-party endpoint", async () => {
		let fetchCalls = 0;
		const fetch: FetchImpl = async () => {
			fetchCalls += 1;
			return Response.json(BALANCE_FIXTURE);
		};

		const report = await deepseekUsageProvider.fetchUsage(params("https://proxy.example/v1"), { fetch });

		expect(report).toBeNull();
		expect(fetchCalls).toBe(0);
	});

	it("rejects malformed balance rows instead of publishing partial account state", async () => {
		const fetch: FetchImpl = async () =>
			Response.json({
				...BALANCE_FIXTURE,
				balance_infos: [...BALANCE_FIXTURE.balance_infos, { currency: "EUR", total_balance: "not-a-number" }],
			});

		expect(await deepseekUsageProvider.fetchUsage(params(), { fetch })).toBeNull();
	});

	it("registers DeepSeek in AuthStorage's default usage resolver", async () => {
		const storage = new AuthStorage(emptyStore());
		await storage.reload();
		try {
			expect(storage.usageProviderFor("deepseek")).toBe(deepseekUsageProvider);
			expect(deepseekUsageProvider.validatesCredentials).toBe(true);
			expect(deepseekUsageProvider.retainLastGoodOnFailure).toBe(false);
		} finally {
			storage.close();
		}
	});
});
