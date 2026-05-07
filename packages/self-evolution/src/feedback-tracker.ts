/**
 * FeedbackTracker: tracks whether injected episodes were helpful.
 */
import type { EffectivenessStore, SkillEffectivenessStore } from "./storage/types";
import type { InjectionOutcome } from "./types";

export class FeedbackTracker {
	#store: EffectivenessStore;
	#skillStore: SkillEffectivenessStore;
	#detailedOutcomes = new Map<string, InjectionOutcome>();

	constructor(store: EffectivenessStore, skillStore: SkillEffectivenessStore) {
		this.#store = store;
		this.#skillStore = skillStore;
	}

	async trackInjection(episodeIds: string[]): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordInjection(id);
		}
	}

	/** @deprecated Use recordDetailedOutcome for multi-dimensional scoring */
	async recordOutcome(episodeIds: string[], succeeded: boolean): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordOutcome(id, succeeded);
		}
	}

	async recordDetailedOutcome(outcomes: InjectionOutcome[]): Promise<void> {
		for (const outcome of outcomes) {
			this.#detailedOutcomes.set(outcome.episodeId, outcome);
			// Backward-compat: map helpfulness to boolean for existing schema
			await this.#store.recordOutcome(outcome.episodeId, outcome.helpfulness > 0);
		}
	}

	getDetailedOutcome(episodeId: string): InjectionOutcome | undefined {
		return this.#detailedOutcomes.get(episodeId);
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
