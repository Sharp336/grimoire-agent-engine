import { describe, expect, test } from "bun:test";
import { ContextAwareRetriever } from "../src/context-aware-retriever";
import type { EffectivenessStore, EpisodeStore, IntentStore } from "../src/storage/types";
import type { Episode, EpisodeEffectiveness, UserProfile } from "../src/types";

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
	async searchFailedByKeyword(): Promise<Episode[]> {
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
class MockEffectivenessStore implements EffectivenessStore {
	#data = new Map<string, EpisodeEffectiveness>();

	setEffectiveness(episodeId: string, data: EpisodeEffectiveness) {
		this.#data.set(episodeId, data);
	}

	async get(episodeId: string): Promise<EpisodeEffectiveness | undefined> {
		return this.#data.get(episodeId);
	}

	async recordInjection(): Promise<void> {}
	async recordOutcome(): Promise<void> {}
}

function makeEpisode(id: string, prompt: string, toolCallCount: number = 2, overrides: Partial<Episode> = {}): Episode {
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
		...overrides,
	};
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
	return {
		toolFrequency: {},
		toolTransitions: {},
		intentDistribution: {},
		avgToolCallsPerSession: 0,
		avgFilesModifiedPerSession: 0,
		errorRate: 0,
		recoveryRate: 0,
		preferredLanguages: [],
		sessionCount: 0,
		updatedAt: Date.now(),
		...overrides,
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

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, new MockEffectivenessStore());
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

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, new MockEffectivenessStore());
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

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, new MockEffectivenessStore());
		const results = await retriever.retrieve("refactor", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results[0]!.episode.id).toBe("ep2");
	});

	test("profile preferredLanguages boosts matching episodes", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "refactor auth", 2, {
			filesModified: ["src/auth.ts"],
			toolsUsed: ["read", "edit"],
		});
		const ep2 = makeEpisode("ep2", "refactor auth", 2, {
			filesModified: ["src/auth.go"],
			toolsUsed: ["read", "edit"],
		});
		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 80 }]);
		intentStore.setIntents("ep2", [{ intent: "refactoring", confidence: 80 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, new MockEffectivenessStore());
		const profile = makeProfile({ preferredLanguages: ["typescript"] });
		const results = await retriever.retrieve("refactor", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
			profile,
		});

		expect(results.length).toBe(2);
		expect(results[0]!.episode.id).toBe("ep1");
		expect(results[0]!.reason).toContain("language match");
		expect(results[1]!.episode.id).toBe("ep2");
	});

	test("profile toolFrequency boosts matching episodes", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "deploy script", 2, {
			toolsUsed: ["bash", "read"],
		});
		const ep2 = makeEpisode("ep2", "deploy script", 2, {
			toolsUsed: ["find", "read"],
		});
		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "exploration", confidence: 60 }]);
		intentStore.setIntents("ep2", [{ intent: "exploration", confidence: 60 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, new MockEffectivenessStore());
		const profile = makeProfile({
			toolFrequency: { bash: 10, read: 5, find: 1 },
		});
		const results = await retriever.retrieve("deploy", {
			maxEpisodes: 10,
			llmRerank: false,
			profile,
		});

		expect(results.length).toBe(2);
		expect(results[0]!.episode.id).toBe("ep1");
		expect(results[0]!.reason).toContain("tool affinity");
	});

	test("profile intentAffinity boosts top-intent episodes when no currentIntent", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "refactor code");
		const ep2 = makeEpisode("ep2", "fix bug");
		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 80 }]);
		intentStore.setIntents("ep2", [{ intent: "bugfix", confidence: 80 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, new MockEffectivenessStore());
		const profile = makeProfile({
			intentDistribution: { refactoring: 5, bugfix: 1 },
		});
		// No currentIntent — intent match won't fire, but intent affinity should
		const results = await retriever.retrieve("work", {
			maxEpisodes: 10,
			llmRerank: false,
			profile,
		});

		expect(results.length).toBe(2);
		expect(results[0]!.episode.id).toBe("ep1");
		expect(results[0]!.reason).toContain("intent affinity");
	});

	test("profile does not double-count intent match + intent affinity", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();

		const ep1 = makeEpisode("ep1", "refactor code");
		episodeStore.setEpisodes([ep1]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 80 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, new MockEffectivenessStore());
		const profile = makeProfile({
			intentDistribution: { refactoring: 5 },
		});
		const results = await retriever.retrieve("refactor", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
			profile,
		});

		expect(results.length).toBe(1);
		expect(results[0]!.reason).toContain("intent match");
		expect(results[0]!.reason).not.toContain("intent affinity");
	});

	test("effectiveness feedback boosts high-help-rate episodes", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();
		const effectivenessStore = new MockEffectivenessStore();

		const ep1 = makeEpisode("ep1", "refactor code");
		const ep2 = makeEpisode("ep2", "refactor code");
		episodeStore.setEpisodes([ep1, ep2]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 80 }]);
		intentStore.setIntents("ep2", [{ intent: "refactoring", confidence: 80 }]);

		// ep1 was injected 4 times, helped 3 times (75%)
		effectivenessStore.setEffectiveness("ep1", {
			episodeId: "ep1",
			timesInjected: 4,
			timesHelped: 3,
			timesFailed: 0,
		});
		// ep2 was injected 4 times, helped 0 times, failed 3 times
		effectivenessStore.setEffectiveness("ep2", {
			episodeId: "ep2",
			timesInjected: 4,
			timesHelped: 0,
			timesFailed: 3,
		});

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, effectivenessStore);
		const results = await retriever.retrieve("refactor", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results.length).toBe(2);
		expect(results[0]!.episode.id).toBe("ep1");
		expect(results[0]!.reason).toContain("proven helpful");
		expect(results[1]!.episode.id).toBe("ep2");
		expect(results[1]!.reason).toContain("previously unhelpful");
	});

	test("effectiveness feedback ignored when no injection record", async () => {
		const episodeStore = new MockEpisodeStore();
		const intentStore = new MockIntentStore();
		const effectivenessStore = new MockEffectivenessStore();

		const ep1 = makeEpisode("ep1", "refactor code");
		episodeStore.setEpisodes([ep1]);
		intentStore.setIntents("ep1", [{ intent: "refactoring", confidence: 80 }]);

		const retriever = new ContextAwareRetriever(episodeStore, intentStore, effectivenessStore);
		const results = await retriever.retrieve("refactor", {
			maxEpisodes: 10,
			llmRerank: false,
			currentIntent: "refactoring",
		});

		expect(results.length).toBe(1);
		expect(results[0]!.reason).not.toContain("proven helpful");
		expect(results[0]!.reason).not.toContain("previously unhelpful");
	});
});
