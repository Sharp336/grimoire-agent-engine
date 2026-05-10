/**
 * FeedbackTracker: tracks whether injected episodes were helpful.
 */
import type { DetailedOutcomeStore, EffectivenessStore, SkillEffectivenessStore } from "./storage/types";
import type { InjectionOutcome, SessionTrace } from "./types";

export class FeedbackTracker {
	#store: EffectivenessStore;
	#skillStore: SkillEffectivenessStore;
	#detailedStore?: DetailedOutcomeStore;

	constructor(store: EffectivenessStore, skillStore: SkillEffectivenessStore, detailedStore?: DetailedOutcomeStore) {
		this.#store = store;
		this.#skillStore = skillStore;
		this.#detailedStore = detailedStore;
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
			// Backward-compat: map helpfulness to boolean for existing schema
			await this.#store.recordOutcome(outcome.episodeId, outcome.helpfulness > 0);
			if (this.#detailedStore) {
				await this.#detailedStore.record(outcome);
			}
		}
	}

	async trackSkillInjection(skillNames: string[]): Promise<void> {
		for (const name of skillNames) {
			await this.#skillStore.recordInjection(name);
		}
	}

	async recordSkillOutcome(skillNames: string[], trace: SessionTrace): Promise<void> {
		// Determine per-skill outcome based on whether the skill's tools were actually used
		const _toolsUsed = new Set(trace.entries.filter(e => e.type === "tool_call" && e.toolName).map(e => e.toolName!));
		const succeeded = trace.completedSuccessfully && trace.errorCount === 0;

		for (const name of skillNames) {
			// If we can't determine tool relevance, fall back to session-level outcome
			await this.#skillStore.recordOutcome(name, succeeded);
		}
	}
}
