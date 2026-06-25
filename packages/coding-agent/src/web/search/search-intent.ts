import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

const WEB_SEARCH_INTENT_EN =
	/\b(?:web\s*search(?:es|ing)?|search\s+the\s+web|look\s+up\s+online|search\s+online)\b/i;

const WEB_SEARCH_INTENT_VIA = /(?:through|via)\s+web\s+search/i;

const WEB_SEARCH_INTENT_KO =
	/(?:웹\s*서치|웹서치|웹\s*검색|인터넷\s+(?:에서\s+)?검색|웹서치\s*(?:로|통해|해서))/;

const WEB_SEARCH_REQUEST_KO =
	/(?:검색해(?:줘|주세요|서|)|리서치(?:해(?:줘|주세요|서|))?|최신\s*(?:정보|뉴스|리뷰|자료))/;

const WEB_SEARCH_FOR_RE = /\bweb\s+search\s+for\b/i;

/** Whether the user explicitly asked for a live web search. */
export function containsWebSearchIntent(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;

	return (
		WEB_SEARCH_INTENT_EN.test(trimmed) ||
		WEB_SEARCH_INTENT_VIA.test(trimmed) ||
		WEB_SEARCH_INTENT_KO.test(trimmed) ||
		WEB_SEARCH_REQUEST_KO.test(trimmed) ||
		WEB_SEARCH_FOR_RE.test(trimmed)
	);
}

export function extractUserPromptText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

export function findLastUserPromptText(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = extractUserPromptText(messages[index]!);
		if (text !== undefined) return text;
	}
	return undefined;
}