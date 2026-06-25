import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	containsWebSearchIntent,
	extractUserPromptText,
	findLastUserPromptText,
} from "@oh-my-pi/pi-coding-agent/web/search/search-intent";

describe("containsWebSearchIntent", () => {
	it("detects explicit English web search requests", () => {
		expect(containsWebSearchIntent("web search for glm 5.2 review")).toBe(true);
		expect(containsWebSearchIntent("Please search the web for release notes")).toBe(true);
		expect(containsWebSearchIntent("research via web search")).toBe(true);
	});

	it("detects Korean web search requests", () => {
		expect(containsWebSearchIntent("웹서치로 GLM 5.2 리뷰 찾아줘")).toBe(true);
		expect(containsWebSearchIntent("최신 리뷰 검색해줘")).toBe(true);
	});

	it("ignores unrelated prompts", () => {
		expect(containsWebSearchIntent("grep the repo for web_search")).toBe(false);
		expect(containsWebSearchIntent("fix the resume hero section")).toBe(false);
		expect(containsWebSearchIntent("hi")).toBe(false);
	});
});

describe("findLastUserPromptText", () => {
	it("returns the latest user message text", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "mock", provider: "mock", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "web search for glm 5.2 review" }], timestamp: 3 },
		];

		expect(extractUserPromptText(messages[0]!)).toBe("first");
		expect(findLastUserPromptText(messages)).toBe("web search for glm 5.2 review");
	});
});