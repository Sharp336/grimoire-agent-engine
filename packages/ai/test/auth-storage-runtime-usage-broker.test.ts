import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";

function report(provider: string, id: string): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		limits: [
			{
				id,
				label: id,
				scope: { provider },
				amount: { used: 2, limit: 10, remaining: 8, unit: "credits" },
			},
		],
	};
}

class BrokerHookStore extends SqliteAuthCredentialStore {
	async fetchUsageReports(): Promise<UsageReport[]> {
		return [report("broker-provider", "broker-limit")];
	}
}

describe("AuthStorage runtime usage with broker store hook", () => {
	it("merges extension runtime reports with broker reports", async () => {
		const store = new BrokerHookStore(new Database(":memory:"));
		const storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
		});
		await storage.reload();
		await storage.set("fixture-usage", {
			type: "oauth",
			access: "fixture-access",
			refresh: "fixture-refresh",
			expires: Date.now() + 60_000,
		});
		storage.setRuntimeUsageProvider("fixture-usage", {
			id: "fixture-usage",
			fetchUsage: async () => report("fixture-usage", "runtime-limit"),
		});

		try {
			const reports = await storage.fetchUsageReports();

			expect(reports?.map(candidate => candidate.provider).sort()).toEqual(["broker-provider", "fixture-usage"]);
		} finally {
			storage.close();
		}
	});
});
