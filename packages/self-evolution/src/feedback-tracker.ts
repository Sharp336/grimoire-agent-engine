/**
 * FeedbackTracker: tracks whether injected episodes were helpful.
 */
import type { EffectivenessStore } from "./storage/types";

export class FeedbackTracker {
	#store: EffectivenessStore;

	constructor(store: EffectivenessStore) {
		this.#store = store;
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
}
