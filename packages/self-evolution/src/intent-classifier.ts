/**
 * IntentClassifier: hybrid rule-based + LLM fallback intent classification.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import classifyIntentTemplate from "./prompts/classify-intent.md" with { type: "text" };
import type { IntentCategory, IntentResult, SessionTrace } from "./types";
import { callBackgroundLlm } from "./utils/llm";

const INTENT_KEYWORDS: Record<IntentCategory, string[]> = {
	refactoring: ["refactor", "rename", "extract", "restructure", "clean up", "clean-up", "simplify"],
	bugfix: ["fix", "bug", "broken", "error", "crash", "repair", "resolve issue", "debug"],
	"feature-add": ["add", "implement", "create", "introduce", "build", "new feature"],
	testing: ["test", "spec", "assertion", "coverage", "unit test", "e2e"],
	documentation: ["doc", "readme", "comment", "document", "explain", "guide"],
	configuration: ["config", "ci", "cd", "setup", "tooling", "eslint", "prettier", "webpack"],
	exploration: ["explore", "understand", "investigate", "look at", "check", "review"],
	optimization: ["optimize", "performance", "speed", "fast", "cache", "memory", "efficient"],
	integration: ["connect", "integrate", "api", "endpoint", "hook", "adapter", "bridge"],
};

const INTENT_TOOL_SIGNALS: Record<IntentCategory, string[]> = {
	refactoring: ["ast_edit"],
	bugfix: [],
	"feature-add": ["write"],
	testing: [],
	documentation: [],
	configuration: [],
	exploration: [],
	optimization: [],
	integration: [],
};

const CONFIDENCE_THRESHOLD = 70;
const _GAP_THRESHOLD = 15;

export class IntentClassifier {
	ruleClassify(trace: SessionTrace): IntentResult {
		const prompt = trace.userPrompt.toLowerCase();
		const scores: Record<string, number> = {};

		for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
			let score = 0;

			for (const kw of keywords) {
				if (prompt.includes(kw)) score += 45;
			}
			score = Math.min(45, score);

			const toolSignals = INTENT_TOOL_SIGNALS[intent as IntentCategory];
			if (toolSignals.length > 0) {
				const toolsUsed = new Set(
					trace.entries.filter(e => e.type === "tool_call" && e.toolName).map(e => e.toolName!),
				);
				for (const tool of toolSignals) {
					if (toolsUsed.has(tool)) score += 25;
				}
				score = Math.min(70, score);
			}

			if (intent === "bugfix") {
				if (trace.errorCount > 0) score += 30;
				if (trace.hadRecovery) score += 10;
				score = Math.min(70, score);
			}

			if (intent === "feature-add" && score > 0 && trace.completedSuccessfully) {
				score += 10;
			}

			scores[intent] = score;
		}

		const entries = Object.entries(scores);
		entries.sort((a, b) => b[1] - a[1]);
		const [bestIntent, bestScore] = entries[0]!;

		if (bestScore === 0) {
			return {
				intent: "exploration",
				confidence: 10,
				source: "rule",
				allScores: scores as Record<IntentCategory, number>,
			};
		}

		return {
			intent: bestIntent as IntentCategory,
			confidence: bestScore,
			source: "rule",
			allScores: scores as Record<IntentCategory, number>,
		};
	}

	async classify(trace: SessionTrace, model?: Model): Promise<IntentResult> {
		const ruleResult = this.ruleClassify(trace);
		if (ruleResult.confidence >= CONFIDENCE_THRESHOLD) {
			return { ...ruleResult, source: "rule" };
		}
		if (!model) {
			return { ...ruleResult, source: "rule" };
		}
		const llmResult = await this.#llmClassify(trace, model, ruleResult.allScores);
		if (llmResult) {
			return llmResult;
		}
		return { ...ruleResult, source: "rule" };
	}

	async #llmClassify(
		trace: SessionTrace,
		model: Model,
		ruleScores: Record<IntentCategory, number>,
	): Promise<IntentResult | undefined> {
		const toolsUsed = trace.entries
			.filter(e => e.type === "tool_call" && e.toolName)
			.map(e => e.toolName)
			.join(", ");

		const userPrompt = `Task: "${trace.userPrompt}"\nTools used: ${toolsUsed || "none"}\nErrors: ${trace.errorCount}\nRecovered: ${trace.hadRecovery ? "yes" : "no"}\nCompleted: ${trace.completedSuccessfully ? "yes" : "no"}`;

		const response = await callBackgroundLlm(model, classifyIntentTemplate, userPrompt);
		if (!response) return undefined;

		try {
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			const json = jsonMatch ? jsonMatch[0] : response;
			const parsed = JSON.parse(json) as { intent?: string; confidence?: number };

			const intent = parsed.intent as IntentCategory;
			if (!intent || !INTENT_KEYWORDS[intent]) return undefined;

			return {
				intent,
				confidence: Math.min(100, Math.max(0, parsed.confidence ?? 50)),
				source: "llm",
				allScores: { ...ruleScores, [intent]: parsed.confidence ?? 50 },
			};
		} catch {
			return undefined;
		}
	}
}
