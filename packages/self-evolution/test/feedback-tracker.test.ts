import { describe, expect, test } from "bun:test";
import { FeedbackTracker } from "../src/feedback-tracker";
import type { EffectivenessStore, SkillEffectivenessStore } from "../src/storage/types";

class MockEffectivenessStore implements EffectivenessStore {
	#data = new Map<string, { injected: number; helped: number; failed: number }>();

	async get(episodeId: string) {
		const d = this.#data.get(episodeId);
		if (!d) return undefined;
		return {
			episodeId,
			timesInjected: d.injected,
			timesHelped: d.helped,
			timesFailed: d.failed,
		};
	}

	async recordInjection(episodeId: string): Promise<void> {
		const d = this.#data.get(episodeId) ?? { injected: 0, helped: 0, failed: 0 };
		d.injected++;
		this.#data.set(episodeId, d);
	}

	async recordOutcome(episodeId: string, helped: boolean): Promise<void> {
		const d = this.#data.get(episodeId) ?? { injected: 0, helped: 0, failed: 0 };
		if (helped) d.helped++;
		else d.failed++;
		this.#data.set(episodeId, d);
	}
}
class MockSkillEffectivenessStore implements SkillEffectivenessStore {
	#data = new Map<string, { injected: number; helped: number; failed: number }>();

	async get(skillName: string) {
		const d = this.#data.get(skillName);
		if (!d) return undefined;
		return {
			skillName,
			timesInjected: d.injected,
			timesHelped: d.helped,
			timesFailed: d.failed,
			lastInjectedAt: 0,
		};
	}

	async recordInjection(skillName: string): Promise<void> {
		const d = this.#data.get(skillName) ?? { injected: 0, helped: 0, failed: 0 };
		d.injected++;
		this.#data.set(skillName, d);
	}

	async recordOutcome(skillName: string, succeeded: boolean): Promise<void> {
		const d = this.#data.get(skillName) ?? { injected: 0, helped: 0, failed: 0 };
		if (succeeded) d.helped++;
		else d.failed++;
		this.#data.set(skillName, d);
	}
}

describe("FeedbackTracker", () => {
	test("trackInjection records all episode IDs", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore());
		await tracker.trackInjection(["ep1", "ep2"]);
		const e1 = await store.get("ep1");
		const e2 = await store.get("ep2");
		expect(e1?.timesInjected).toBe(1);
		expect(e2?.timesInjected).toBe(1);
	});

	test("recordOutcome marks episodes as helped on success", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore());
		await tracker.trackInjection(["ep1"]);
		await tracker.recordOutcome(["ep1"], true);
		const e1 = await store.get("ep1");
		expect(e1?.timesHelped).toBe(1);
		expect(e1?.timesFailed).toBe(0);
	});

	test("recordOutcome marks episodes as failed on failure", async () => {
		const store = new MockEffectivenessStore();
		const tracker = new FeedbackTracker(store, new MockSkillEffectivenessStore());
		await tracker.trackInjection(["ep1"]);
		await tracker.recordOutcome(["ep1"], false);
		const e1 = await store.get("ep1");
		expect(e1?.timesHelped).toBe(0);
		expect(e1?.timesFailed).toBe(1);
	});
});
