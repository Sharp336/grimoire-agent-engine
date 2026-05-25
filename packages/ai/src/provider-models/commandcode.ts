/**
 * Static Command Code model catalog.
 *
 * Command Code exposes its model catalog through its CLI/provider metadata
 * rather than a model-list endpoint. This catalog is synchronized from the
 * MIT-licensed provider source at github.com/ninehills/pi-commandcode-provider
 * (models.json, revision 960d0d1f2388d039c8e8cd8f610723c2425ca92b).
 */
import type { ModelManagerOptions } from "../model-manager";
import type { Model } from "../types";

const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const COST_BY_MODEL: Record<string, Model<"commandcode">["cost"]> = {
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
	"claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
	"gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	"gpt-5.3-codex": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
	"moonshotai/Kimi-K2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	"moonshotai/Kimi-K2.5": { input: 0.6, output: 3, cacheRead: 0, cacheWrite: 0 },
	"zai-org/GLM-5": { input: 0.95, output: 3.15, cacheRead: 0, cacheWrite: 0 },
	"MiniMaxAI/MiniMax-M2.5": { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
};

function model(
	id: string,
	name: string,
	reasoning: boolean,
	contextWindow: number,
	maxTokens: number,
): Model<"commandcode"> {
	return {
		id,
		name: `${name} (Command Code)`,
		api: "commandcode",
		provider: "commandcode",
		baseUrl: COMMAND_CODE_BASE_URL,
		reasoning,
		input: ["text"],
		cost: COST_BY_MODEL[id] ?? { ...ZERO_COST },
		contextWindow,
		maxTokens,
	};
}

export const COMMAND_CODE_MODELS: readonly Model<"commandcode">[] = [
	model("claude-sonnet-4-6", "Claude Sonnet 4.6", true, 1_000_000, 64_000),
	model("claude-opus-4-7", "Claude Opus 4.7", true, 1_000_000, 64_000),
	model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", false, 200_000, 64_000),
	model("gpt-5.5", "GPT-5.5", true, 256_000, 128_000),
	model("gpt-5.4", "GPT-5.4", true, 400_000, 128_000),
	// OMP models Codex context as input capacity; the advertised 400K includes its 128K output budget.
	model("gpt-5.3-codex", "GPT-5.3 Codex", true, 272_000, 128_000),
	model("gpt-5.4-mini", "GPT-5.4 Mini", true, 400_000, 128_000),
	model("moonshotai/Kimi-K2.6", "Kimi K2.6", false, 256_000, 65_536),
	model("moonshotai/Kimi-K2.5", "Kimi K2.5", false, 256_000, 65_536),
	model("zai-org/GLM-5.1", "GLM-5.1", false, 200_000, 65_536),
	model("zai-org/GLM-5", "GLM-5", false, 200_000, 65_536),
	model("MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", false, 1_048_576, 65_536),
	model("MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", false, 200_000, 65_536),
	// The upstream catalog advertises 384K output for DeepSeek, but Command Code's
	// gateway currently rejects params.max_tokens above 200K.
	model("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", true, 1_000_000, 200_000),
	model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", true, 1_000_000, 200_000),
	model("Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", true, 1_000_000, 65_536),
	model("Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", true, 1_000_000, 65_536),
	model("Qwen/Qwen3.7-Max", "Qwen 3.7 Max", true, 1_000_000, 65_536),
	model("stepfun/Step-3.5-Flash", "Step 3.5 Flash", true, 1_000_000, 65_536),
	model("google/gemini-3.5-flash", "Gemini 3.5 Flash", true, 1_000_000, 65_536),
	model("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", true, 1_000_000, 65_536),
];

export interface CommandCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function commandCodeModelManagerOptions(
	_config: CommandCodeModelManagerConfig = {},
): ModelManagerOptions<"commandcode"> {
	return {
		providerId: "commandcode",
		staticModels: COMMAND_CODE_MODELS,
	};
}
