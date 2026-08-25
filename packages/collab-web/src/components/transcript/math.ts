import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import {
	type MathSpan,
	mathBlockStartIndex,
	mathStartIndex,
	tokenizeMathBlock,
	tokenizeMathSpan,
} from "@oh-my-pi/pi-utils/math-delimiters";
import { renderToString } from "katex";

// Bound explicit TeX dimensions to about 260 px at the transcript's 13 px base size.
const MAX_KATEX_SIZE_EM = 20;

interface MathToken extends Tokens.Generic {
	type: "math";
	text: string;
	display: boolean;
}

function toMarkedToken(span: MathSpan): MathToken | Tokens.Text {
	if (!span.complete) return { type: "text", raw: span.raw, text: span.raw };
	return { type: "math", raw: span.raw, text: span.text, display: span.display };
}

function isMathToken(token: Tokens.Generic): token is MathToken {
	return token.type === "math" && typeof token.text === "string" && typeof token.display === "boolean";
}

function renderMath(token: Tokens.Generic): string | false {
	if (!isMathToken(token)) return false;
	return renderToString(token.text, {
		displayMode: token.display,
		maxSize: MAX_KATEX_SIZE_EM,
		throwOnError: false,
		trust: false,
	});
}

/** Tokenizes and renders inline and display math in collab transcript Markdown. */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			start: mathBlockStartIndex,
			tokenizer(source) {
				const span = tokenizeMathBlock(source);
				return span ? toMarkedToken(span) : undefined;
			},
			renderer: renderMath,
		},
		{
			name: "math",
			level: "inline",
			start: mathStartIndex,
			tokenizer(source) {
				const span = tokenizeMathSpan(source);
				return span ? toMarkedToken(span) : undefined;
			},
			renderer: renderMath,
		},
	],
};
