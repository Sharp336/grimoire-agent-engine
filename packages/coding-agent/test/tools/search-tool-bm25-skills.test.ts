import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "../../src/config/settings";
import type { RenderResultOptions } from "../../src/extensibility/custom-tools/types";
import { getThemeByName, initTheme, type Theme } from "../../src/modes/theme/theme";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
} from "../../src/tool-discovery/tool-index";
import type { ToolSession } from "../../src/tools/index";
import { SearchToolBm25Tool, searchToolBm25Renderer } from "../../src/tools/search-tool-bm25";

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const t = await getThemeByName("dark");
	if (!t) throw new Error("Missing dark theme");
	uiTheme = t;
});

const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

function renderText(component: Component): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

// ─── Session type with generic discovery triple ───────────────────────────────

type GenericDiscoverySession = ToolSession & {
	isToolDiscoveryEnabled: () => boolean;
	isSkillDiscoveryEnabled: () => boolean;
	getDiscoverableTools: (filter?: { source?: DiscoverableTool["source"] }) => DiscoverableTool[];
	getDiscoverableToolSearchIndex?: () => DiscoverableToolSearchIndex;
	getSelectedDiscoveredToolNames: () => string[];
	activateDiscoveredTools: (toolNames: string[]) => Promise<string[]>;
	getSelected: () => string[];
};

function createGenericSession(
	tools: DiscoverableTool[],
	skillDiscoveryEnabled: boolean,
	toolDiscoveryEnabled: boolean,
	overrides: Partial<GenericDiscoverySession> = {},
): GenericDiscoverySession {
	const selected: string[] = [];
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"tools.discoveryMode": toolDiscoveryEnabled ? "all" : "off",
			"skills.redactDescriptions": skillDiscoveryEnabled,
		}),
		isToolDiscoveryEnabled: () => toolDiscoveryEnabled,
		isSkillDiscoveryEnabled: () => skillDiscoveryEnabled,
		getDiscoverableTools: () => tools,
		getSelectedDiscoveredToolNames: () => [...selected],
		activateDiscoveredTools: async (toolNames: string[]) => {
			for (const name of toolNames) {
				if (!selected.includes(name)) {
					selected.push(name);
				}
			}
			return toolNames;
		},
		getSelected: () => [...selected],
		...overrides,
	};
}

/** Helper to create a discoverable skill tool entry (deferred/redacted). */
function skillTool(name: string, summary: string): DiscoverableTool {
	return {
		name,
		label: name,
		summary,
		source: "skill",
		schemaKeys: [],
	};
}

/** Helper to create a discoverable MCP tool. */
function mcpTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	summary: string,
	schemaKeys: string[],
): DiscoverableTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		summary,
		source: "mcp",
		serverName,
		mcpToolName,
		schemaKeys,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SearchToolBm25Tool — skill discovery", () => {
	it("skill entries are searchable and returned in details.skills", async () => {
		const tools: DiscoverableTool[] = [
			skillTool("deploy-pipeline", "Deploy the application using the CI/CD pipeline"),
			skillTool("run-tests", "Execute the project test suite"),
			mcpTool("mcp__github_create_issue", "github", "create_issue", "Create a GitHub issue", ["owner", "repo"]),
		];
		const session = createGenericSession(tools, true, false);
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-1", { query: "deploy pipeline" });

		// Skill must appear in details.skills
		expect(result.details?.skills).toBeDefined();
		const skillNames = result.details!.skills!.map(s => s.name);
		expect(skillNames).toContain("deploy-pipeline");

		// Each skill entry must have the expected shape
		const deploySkill = result.details!.skills!.find(s => s.name === "deploy-pipeline")!;
		expect(deploySkill.read).toBe("skill://deploy-pipeline");
		expect(typeof deploySkill.score).toBe("number");
		expect(deploySkill.description).toBe("Deploy the application using the CI/CD pipeline");
	});

	it("skills are NOT passed to activateDiscoveredTools", async () => {
		const activateSpy = mock(async (toolNames: string[]) => toolNames);
		const tools: DiscoverableTool[] = [
			skillTool("run-tests", "Execute the project test suite"),
			mcpTool("mcp__github_create_issue", "github", "create_issue", "Create a GitHub issue", ["owner", "repo"]),
		];
		const selected: string[] = [];
		const session = createGenericSession(tools, true, true, {
			activateDiscoveredTools: activateSpy,
			getSelectedDiscoveredToolNames: () => [...selected],
		});
		const tool = new SearchToolBm25Tool(session);

		await tool.execute("call-2", { query: "run tests" });

		// activateDiscoveredTools must not have been called with any skill name
		const allActivatedNames = activateSpy.mock.calls.flatMap(call => call[0] as string[]);
		expect(allActivatedNames).not.toContain("run-tests");
		// Skills must not appear in activated_tools in the result
		const result = await tool.execute("call-3", { query: "run tests suite" });
		expect(result.details?.activated_tools).not.toContain("run-tests");
	});

	it("createIf returns a tool when isSkillDiscoveryEnabled=true and discoveryMode=off", () => {
		const tools: DiscoverableTool[] = [skillTool("deploy-pipeline", "Deploy app")];
		const session = createGenericSession(tools, true, false);

		// discoveryMode is "off", mcp.discoveryMode is not set — only skill discovery is active
		const result = SearchToolBm25Tool.createIf(session);
		expect(result).not.toBeNull();
		expect(result).toBeInstanceOf(SearchToolBm25Tool);
	});

	it("createIf returns null when both discoveryMode and isSkillDiscoveryEnabled are off", () => {
		const tools: DiscoverableTool[] = [skillTool("deploy-pipeline", "Deploy app")];
		const session = createGenericSession(tools, false, false);

		const result = SearchToolBm25Tool.createIf(session);
		expect(result).toBeNull();
	});

	it("skill-only result: details.tools is empty, skills has match, renderer shows skills section", async () => {
		const tools: DiscoverableTool[] = [
			skillTool("deploy-pipeline", "Deploy the application using the CI/CD pipeline"),
		];
		// skill-only session: no regular tools discoverable
		const session = createGenericSession(tools, true, false);
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-skills-only", { query: "deploy pipeline" });

		// tools array must be empty (skill not leaked into tools)
		expect(result.details?.tools).toHaveLength(0);
		// skills array must have the match
		expect(result.details?.skills?.length).toBeGreaterThan(0);
		expect(result.details?.skills?.[0]?.name).toBe("deploy-pipeline");
		// activated_tools must be empty (skills never activated)
		expect(result.details?.activated_tools).toHaveLength(0);

		// Renderer must show skills section and NOT report "No matching tools found"
		const component = searchToolBm25Renderer.renderResult(result, renderOptions, uiTheme);
		const text = renderText(component);
		expect(text).not.toContain("No matching tools found");
		expect(text).toContain("deploy-pipeline");
		expect(text).toContain("skill://deploy-pipeline");
		expect(text).toContain("Skills (1):");
	});

	it("JSON content includes skill_matches and skill_match_count when skills match", async () => {
		const tools: DiscoverableTool[] = [skillTool("run-tests", "Execute the project test suite and report results")];
		const session = createGenericSession(tools, true, false);
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-json", { query: "run test suite" });

		const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
		expect(parsed.skill_match_count).toBe(1);
		expect(parsed.skill_matches).toHaveLength(1);
		expect(parsed.skill_matches[0].name).toBe("run-tests");
		expect(parsed.skill_matches[0].read).toBe("skill://run-tests");
	});

	it("JSON content omits skill fields when no skills match", async () => {
		const tools: DiscoverableTool[] = [
			mcpTool("mcp__github_create_issue", "github", "create_issue", "Create a GitHub issue", ["owner", "repo"]),
		];
		const session = createGenericSession(tools, false, true);
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-no-skill", { query: "github" });

		const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
		expect(parsed.skill_match_count).toBeUndefined();
		expect(parsed.skill_matches).toBeUndefined();
	});

	it("execute throws when both discovery modes are disabled", async () => {
		const tools: DiscoverableTool[] = [];
		const session = createGenericSession(tools, false, false);
		const tool = new SearchToolBm25Tool(session);

		await expect(tool.execute("call-disabled", { query: "anything" })).rejects.toThrow("Tool discovery is disabled.");
	});
});

// ─── Regression guard: description getter caching (TC-006) ─────────────────────
//
// The `description` getter caches its rendered text keyed on the
// DiscoverableToolSearchIndex object reference returned by
// getDiscoverableToolSearchIndex(). The rendered text itself is built from
// getDiscoverableTools() (via getDiscoverableToolsForDescription) — and that
// call only happens on the cache-MISS path. So counting getDiscoverableTools
// invocations is a direct, non-coupled measurement of how many times the
// description re-rendered. That is the backbone of these tests.
describe("SearchToolBm25Tool — description getter caching", () => {
	/**
	 * Build a minimal stub session that exercises only the two methods the
	 * description getter touches: getDiscoverableTools (the render source, spied)
	 * and getDiscoverableToolSearchIndex (the cache key / invalidation signal).
	 */
	function createDescriptionCacheSession(opts: {
		getDiscoverableTools: () => DiscoverableTool[];
		getDiscoverableToolSearchIndex: () => DiscoverableToolSearchIndex;
	}): ToolSession {
		return {
			isToolDiscoveryEnabled: () => true,
			isSkillDiscoveryEnabled: () => false,
			getDiscoverableTools: opts.getDiscoverableTools,
			getDiscoverableToolSearchIndex: opts.getDiscoverableToolSearchIndex,
			getSelectedDiscoveredToolNames: () => [],
			activateDiscoveredTools: async (toolNames: string[]) => toolNames,
		} as unknown as ToolSession;
	}

	it("same index reference: returns cached text and does not re-render", () => {
		const idx = buildDiscoverableToolSearchIndex([]);
		const getTools = mock(() => [] as DiscoverableTool[]);
		const session = createDescriptionCacheSession({
			getDiscoverableTools: getTools,
			getDiscoverableToolSearchIndex: () => idx,
		});
		const tool = new SearchToolBm25Tool(session);

		const d1 = tool.description;
		const d2 = tool.description;

		// Identical output AND the render source was consulted exactly once:
		// the second access was served from cache.
		expect(d1).toBe(d2);
		expect(getTools.mock.calls.length).toBe(1);
	});

	it("changed index reference: busts cache and re-renders", () => {
		let currentIndex = buildDiscoverableToolSearchIndex([]);
		const getTools = mock(() => [] as DiscoverableTool[]);
		const session = createDescriptionCacheSession({
			getDiscoverableTools: getTools,
			getDiscoverableToolSearchIndex: () => currentIndex,
		});
		const tool = new SearchToolBm25Tool(session);

		const d1 = tool.description;
		// Swap to a brand-new index object reference — same contents, new identity.
		currentIndex = buildDiscoverableToolSearchIndex([]);
		const d2 = tool.description;

		// Both accesses re-rendered because the cache key (index reference) changed.
		expect(getTools.mock.calls.length).toBe(2);
		expect(typeof d1).toBe("string");
		expect(typeof d2).toBe("string");
	});

	it("throwing getDiscoverableToolSearchIndex falls back to uncached render and never poisons the cache", () => {
		let tools: DiscoverableTool[] = [];
		const getTools = mock(() => tools);
		const session = createDescriptionCacheSession({
			getDiscoverableTools: getTools,
			getDiscoverableToolSearchIndex: () => {
				throw new Error("pre-init");
			},
		});
		const tool = new SearchToolBm25Tool(session);

		// The getter must swallow the pre-init throw, never propagate it.
		// Read d1 inside this assertion path so this is the FIRST access (not a
		// separate extra one) — keeping the access count at exactly two below.
		let d1 = "";
		expect(() => {
			d1 = tool.description;
		}).not.toThrow();
		// Change the underlying tool set and read again. If the throw path had
		// wrongly written #descriptionCache, the second access would serve a stale
		// (poisoned) string. A correct uncached fallback re-renders every time.
		tools = [skillTool("deploy-pipeline", "Deploy the application")];
		const d2 = tool.description;

		expect(typeof d1).toBe("string");
		expect(d1).not.toBe(d2);
		// Re-rendered on every access (no caching when the index getter throws).
		expect(getTools.mock.calls.length).toBe(2);
	});
});
