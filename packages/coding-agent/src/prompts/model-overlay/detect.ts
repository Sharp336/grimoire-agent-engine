export type ModelOverlayFamily = "gpt-5" | "claude-opus" | "kimi-k2";

const GPT5_FAMILY_PATTERN = /(?:^|[/@._-])gpt-5(?:$|[/@._:-]|[._-]\d)/;
const CLAUDE_OPUS_FAMILY_PATTERN = /(?:^|[/@._-])(?:claude-)?opus-4(?:$|[/@._:-]|[._-]\d)/;
const KIMI_K2_FAMILY_PATTERN = /(?:^|[/@._-])kimi-k2(?:(?:[._-]|p)\d+)?(?:$|[/@._:-])/;

export function detectModelOverlayFamily(model: string | undefined): ModelOverlayFamily | undefined {
	if (model === undefined || model.trim() === "") {
		return undefined;
	}

	const normalized = model.toLowerCase().replace(/\s+/g, "-");
	if (GPT5_FAMILY_PATTERN.test(normalized)) {
		return "gpt-5";
	}
	if (CLAUDE_OPUS_FAMILY_PATTERN.test(normalized)) {
		return "claude-opus";
	}
	if (KIMI_K2_FAMILY_PATTERN.test(normalized)) {
		return "kimi-k2";
	}

	return undefined;
}
