/**
 * EffectivenessAnalyzer: multi-dimensional scoring of episode injection outcomes.
 */
import type { Episode, InjectionOutcome, SessionTrace } from "./types";

const EXPLICIT_CORRECTION_PATTERNS = ["不对", "错了", "不是这样", "不要这样做", "incorrect"];

const EXPLICIT_APPROVAL_PATTERNS = ["好的", "可以", "谢谢", "good", "perfect", "thanks"];

const CORRECTION_PENALTY = -0.8;
const APPROVAL_BONUS = 0.2;
const REDUNDANCY_PENALTY = -0.3;
const REDUNDANCY_THRESHOLD = 0.7;
const ERROR_REPETITION_PENALTY = -0.5;
const EFFICIENCY_BONUS = 0.2;
const SUCCESS_BONUS = 0.3;

export class EffectivenessAnalyzer {
	analyze(trace: SessionTrace, injectedEpisode: Episode): InjectionOutcome {
		let helpfulness = 0;

		const userInputs = trace.entries.filter(e => e.type === "user_input");
		const userText = userInputs.map(e => (e.content ?? "").toLowerCase()).join(" ");

		// 1. Explicit correction
		const hasExplicitCorrection = EXPLICIT_CORRECTION_PATTERNS.some(p => userText.includes(p.toLowerCase()));
		if (hasExplicitCorrection) {
			helpfulness += CORRECTION_PENALTY;
		}

		// 2. Explicit approval
		const hasExplicitApproval = EXPLICIT_APPROVAL_PATTERNS.some(p => userText.includes(p.toLowerCase()));
		if (hasExplicitApproval) {
			helpfulness += APPROVAL_BONUS;
		}

		// 3. Redundancy: keyword overlap between prompts
		const currentTokens = this.#tokenize(trace.userPrompt);
		const injectedTokens = this.#tokenize(injectedEpisode.userPrompt);
		const overlapRatio = this.#jaccardOverlap(currentTokens, injectedTokens);
		const wasRedundant = overlapRatio > REDUNDANCY_THRESHOLD;
		if (wasRedundant) {
			helpfulness += REDUNDANCY_PENALTY;
		}

		// 4. Error avoidance: current trace repeats errors on tools used in injected episode
		const injectedTools = new Set(injectedEpisode.toolsUsed);
		const currentErrorTools = new Set(
			trace.entries
				.filter(e => e.type === "tool_result" && e.isError)
				.map(e => e.toolName)
				.filter((t): t is string => t !== undefined),
		);
		const repeatedErrorTools = [...currentErrorTools].filter(t => injectedTools.has(t));
		const avoidedPreviousErrors = repeatedErrorTools.length === 0;
		if (!avoidedPreviousErrors) {
			helpfulness += ERROR_REPETITION_PENALTY;
		}

		// 5. Tool efficiency
		const isEfficient = trace.toolCallCount <= injectedEpisode.toolCallCount * 1.2;
		const toolEfficiency = isEfficient ? EFFICIENCY_BONUS : 0;
		helpfulness += toolEfficiency;

		// 6. Success bonus
		if (trace.completedSuccessfully && trace.errorCount === 0) {
			helpfulness += SUCCESS_BONUS;
		}

		// Clamp to [-1, 1]
		helpfulness = Math.max(-1, Math.min(1, helpfulness));

		return {
			episodeId: injectedEpisode.id,
			helpfulness,
			hasExplicitCorrection,
			hasExplicitApproval,
			wasRedundant,
			avoidedPreviousErrors,
			toolEfficiency,
		};
	}

	#tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.split(/[^a-z0-9\u4e00-\u9fa5]+/)
			.filter(Boolean);
	}

	#jaccardOverlap(a: string[], b: string[]): number {
		const setA = new Set(a);
		const setB = new Set(b);
		if (setA.size === 0 && setB.size === 0) return 0;
		const intersection = new Set([...setA].filter(x => setB.has(x)));
		const union = new Set([...setA, ...setB]);
		return intersection.size / union.size;
	}
}
