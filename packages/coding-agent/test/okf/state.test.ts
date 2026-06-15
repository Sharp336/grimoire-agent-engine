import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { OkfSessionState } from "../../src/okf/state";
import type { OkfSearchResult, OkfStore } from "../../src/okf/store/types";

class FakeOkfStore implements OkfStore {
	readonly searchQueries: string[] = [];

	async upsert(): Promise<void> {}

	async get(): Promise<undefined> {
		return undefined;
	}

	async delete(): Promise<void> {}

	async list(): Promise<[]> {
		return [];
	}

	async search(query: string): Promise<OkfSearchResult[]> {
		this.searchQueries.push(query);
		return [
			{
				id: "architecture/auth",
				type: "Architecture",
				title: "Auth",
				description: "Auth flow overview",
				tags: ["auth"],
				score: 0,
			},
		];
	}

	async count(): Promise<number> {
		return 0;
	}

	async close(): Promise<void> {}
}

describe("okf/state OkfSessionState", () => {
	it("injects auto-recall only for the first user turn", async () => {
		const settings = Settings.isolated();
		settings.set("okf.autoRecall", true);
		settings.set("okf.recallMaxTokens", 800);
		const store = new FakeOkfStore();
		const state = new OkfSessionState({ sessionId: "session", settings, cwd: process.cwd(), store });

		const first = await state.beforeAgentStartPrompt("debug the auth login flow");
		const second = await state.beforeAgentStartPrompt("now inspect billing webhooks");
		const developerInstructions = await state.buildDeveloperInstructions();

		expect(first).toContain("Auth flow overview");
		expect(second).toBeUndefined();
		expect(store.searchQueries).toHaveLength(1);
		expect(developerInstructions).not.toContain("Auth flow overview");
	});
});
