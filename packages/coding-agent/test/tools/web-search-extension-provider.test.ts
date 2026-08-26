import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { type SearchParams, SearchProviderRegistry } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withLocalAuthStorage<T>(run: (authStorage: AuthStorage) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-extension-auth-"));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		return await run(authStorage);
	} finally {
		authStorage.close();
		await removeWithRetries(dir);
	}
}

describe("extension web-search execution", () => {
	it("runs a registered extension provider through the built-in web_search pipeline", async () => {
		const registry = new SearchProviderRegistry();
		let received: SearchParams | undefined;
		registry.register(
			{
				id: "fixture-search",
				label: "Fixture Search",
				description: "Fixture extension search provider",
				isAvailable: () => true,
				search: params => {
					received = params;
					return Promise.resolve({
						provider: "fixture-search",
						sources: [
							{
								title: "Fixture result",
								url: "https://example.com/result",
								snippet: "Extension provider result",
							},
						],
					});
				},
			},
			"fixture-extension",
		);

		try {
			await withLocalAuthStorage(async authStorage => {
				const result = await runSearchQuery(
					{ query: "site:example.com extension search", provider: "fixture-search", limit: 3 },
					{ authStorage, providerRegistry: registry, sessionId: "fixture-session" },
				);

				expect(result.details.response.provider).toBe("fixture-search");
				expect(result.content[0]?.text).toContain("Fixture result");
				expect(received?.query).toBe("site:example.com extension search");
				expect(received?.parsedQuery?.sites).toEqual(["example.com"]);
				expect(received?.limit).toBe(3);
				expect(received?.sessionId).toBe("fixture-session");
				expect(received?.authStorage).toBe(authStorage);
			});
		} finally {
			registry.dispose();
		}
	});
});
