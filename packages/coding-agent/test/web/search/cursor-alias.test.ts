import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CursorWebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search/cursor-alias";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId, SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";

const FAKE_SESSION = {} as ToolSession;

function fakeResponse(providerId: SearchProviderId): SearchResponse {
	return {
		provider: providerId,
		sources: [{ title: "Example", url: "https://example.com", snippet: "snippet" }],
	};
}

describe("CursorWebSearchTool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the Cursor wire name and maps search_term to the shared search pipeline", async () => {
		const tool = new CursorWebSearchTool(FAKE_SESSION);
		expect(tool.name).toBe("WebSearch");

		const searchSpy = vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			{
				id: "searxng",
				label: "SearXNG",
				search: async () => fakeResponse("searxng"),
				isExplicitlyAvailable: async () => true,
			},
		]);

		const result = await tool.execute("call-1", {
			search_term: "GLM 5.2 review",
			explanation: "Need recent community reactions.",
		});

		expect(searchSpy).toHaveBeenCalled();
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("https://example.com");
	});
});