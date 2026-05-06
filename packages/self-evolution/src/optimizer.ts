/**
 * RuleBasedPromptOptimizer: GEPA-style prompt optimization for skills.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import optimizePromptTemplate from "./prompts/optimize-prompt.md" with { type: "text" };
import type { EvolvedSkill } from "./types";
import { callBackgroundLlm } from "./utils/llm";

export class RuleBasedPromptOptimizer {
	/**
	 * Optimize a skill's approach text. Returns the optimized text, or the original if optimization fails.
	 */
	async optimize(skill: EvolvedSkill, model?: Model): Promise<string> {
		const userPrompt = `Skill: ${skill.name}\nDescription: ${skill.description}\nTask pattern: ${skill.taskPattern}\nCurrent approach:\n${skill.approach}\n\nTools used: ${skill.tools.join(", ")}\nPitfalls: ${skill.pitfalls.join("; ")}\nUsage count: ${skill.usageCount}\nSuccess count: ${skill.successCount}\n\nPlease optimize the approach text.`;

		const result = await callBackgroundLlm(model, optimizePromptTemplate, userPrompt);
		if (!result || result.length < 20) {
			return skill.approach;
		}
		return result.slice(0, 1200); // cap length
	}
}
