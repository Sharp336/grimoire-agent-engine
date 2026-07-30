import { estimateTextTokens } from "@oh-my-pi/pi-ai/utils/output-budget";
import { countTokens as countTokensNat } from "@oh-my-pi/pi-natives";

const accurate = process.env.PI_TOKENIZER_ACCURATE === "1" && Bun.env.NODE_ENV !== "test";

export function countTokens(text: string | string[]): number {
	if (accurate) {
		return countTokensNat(text);
	} else if (Array.isArray(text)) {
		return text.reduce((sum, t) => sum + estimateTextTokens(t), 0);
	} else {
		return estimateTextTokens(text);
	}
}

export function countTokensConservatively(text: string | string[]): number {
	if (accurate) {
		return countTokensNat(text);
	} else if (Array.isArray(text)) {
		return text.reduce((sum, value) => sum + Buffer.byteLength(value, "utf-8"), 0);
	} else {
		return Buffer.byteLength(text, "utf-8");
	}
}
