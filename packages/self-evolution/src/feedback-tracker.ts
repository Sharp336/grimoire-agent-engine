/**
 * FeedbackTracker: tracks whether injected episodes were helpful.
 */
import type { EffectivenessStore, SkillEffectivenessStore } from "./storage/types";

export class FeedbackTracker {
	#store: EffectivenessStore;
	#skillStore: SkillEffectivenessStore;

	constructor(store: EffectivenessStore, skillStore: SkillEffectivenessStore) {
		this.#store = store;
		this.#skillStore = skillStore;
	}

	async trackInjection(episodeIds: string[]): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordInjection(id);
		}
	}

	async recordOutcome(episodeIds: string[], succeeded: boolean): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordOutcome(id, succeeded);
		}
	}
	async trackSkillInjection(skillNames: string[]): Promise<void> {
		for (const name of skillNames) {
			await this.#skillStore.recordInjection(name);
		}
	}

	async recordSkillOutcome(skillNames: string[], succeeded: boolean): Promise<void> {
		for (const name of skillNames) {
			await this.#skillStore.recordOutcome(name, succeeded);
		}
	}
}
