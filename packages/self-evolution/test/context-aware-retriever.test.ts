import { describe, expect, test } from "bun:test";
import { ContextAwareRetriever } from "../src/context-aware-retriever";
import type { EpisodeStore, IntentStore } from "../src/storage/types";
import type { Episode } from "../src/types";

class MockEpisodeStore implements EpisodeStore {
	#episodes: Episode[] = [];

	setEpisodes(episodes: Episode[]) {
		this.#episodes = episodes;
	}

	async insert(): Promise<void> {}
	async listRecent(limit: number): Promise<Episode[]> {
		return this.#episodes.slice(0, limit);
	}
	async searchByKeyword(): Promise<Episode[]> {
		return [];
	}
	async deleteOld(): Promise<number> {
		return 0;
	}
	async count(): Promise<number> {
		return this.#episodes.length;
	}
}

class MockIntentStore implements IntentStore {
	#intents = new Map<string, { intent: string; confidence: number }[]>();

	setIntents(episodeId: string, intents: { intent: string; confidence: number }[]) {
		this.#intents.set(episodeId, intents);
	}

	async insert(): Promise<void> {}
	async getByEpisode(episodeId: string) {
		const data = this.#intents.get(episodeId) ?? [];
		return data.map(d => ({ episodeId, intent: d.intent as any, confidence: d.confidence, source: "rule" as const }));
	}
	async getByIntent(intent: string, limit: number) {
		const results: any[] = [];
		for (const [epId, intents] of this.#intents) {
			const match = intents.find(i => i.intent === intent);
			if (match)
				results.push({ episodeId: epId, intent: match.intent, confidence: match.confidence, source: "rule" });
		}
		return results.slice(0, limit);
	}
}

function makeEpisode(id: string, prompt: string, toolCallCount: number = 2): Episode {
	return {
		id,
		sessionId: "s1",
		cwd: "/tmp",
		userPrompt: prompt,
		timestamp: Date.now(),
		durationMs: 1000,
		toolCallCount,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		summary: `Task: ${prompt} | Tools: read, edit | Outcome: completed successfully`,
		toolsUsed: ["read", "edit"],
		filesModified: [],
	};
}

describe("ContextAwareRetriever", () => {
	test("filters by intent when current intent is provided", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "refactor the auth module");
		const ep2 = makeEpisode("ep2", "fix the login bug");
		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 85 }]);
		intentStore.setIntents("ep2", [{ intent: "bugfix", confidence: 90 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore);
		const results = await retriever.retrieve("refactor something", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results.length).toBe(1);
		expect(results[0]!.episode.id).toBe("ep1");
	});

	test("falls back to all episodes when no intent filter matches", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "do something");
		episodeStore.setEpisodes([ep1]);
		intentStore.setIntents("ep1", [{ intent: "exploration", confidence: 60 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore);
		const results = await retriever.retrieve("test", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results.length).toBeGreaterThan(0);
	});

	test("ranks successful episodes higher", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "refactor code");
		ep1.completedSuccessfully = false;
		ep1.errorCount = 1;

		const ep2 = makeEpisode("ep2", "refactor code better");
		ep2.completedSuccessfully = true;

		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 80 }]);
		intentStore.setIntents("ep2", [{ intent: "refactoring", confidence: 80 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore);
		const results = await retriever.retrieve("refactor", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results[0]!.episode.id).toBe("ep2");
	});
});
