import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import xdevMountNoticePrompt from "../src/prompts/system/xdev-mount-notice.md" with { type: "text" };

// Cache-stability invariant: when MCP servers reconnect with byte-identical tool
// definitions, `refreshMCPTools` must not rebuild the system prompt. A rebuild
// invalidates the Anthropic prompt-cache breakpoint placed on the system block
// and forces a full prefix re-encode on the next request.

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createBasicTool(name: string, label: string, description = `${label} tool`): AgentTool {
	return {
		name,
		label,
		description,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string, description: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

/** Rendered xd:// mount notices within one provider call's messages. */
function mountNoticesIn(messages: Message[]): string[] {
	return messages.flatMap(message => {
		const { content } = message;
		const text =
			typeof content === "string"
				? content
				: content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
		return text.includes("The xd:// device inventory changed.") ? [text] : [];
	});
}

describe("AgentSession refreshMCPTools rebuild skipping", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	interface NewSessionOptions {
		getMcpServerInstructions?: () => Map<string, string> | undefined;
		getLocalCalendarDate?: () => string;
		xdevRegistry?: XdevRegistry;
		lazyWrite?: boolean;
		/** Scripted mock model responses; enables driving `session.prompt()`. */
		responses?: MockResponseSource;
	}

	function newSession(
		rebuildSystemPrompt: (toolNames: string[]) => Promise<string>,
		options: NewSessionOptions = {},
	): {
		session: AgentSession;
		/** Provider-call message snapshots (LLM-converted), one per model request. */
		contexts: Message[][];
	} {
		const readTool = createBasicTool("read", "Read");
		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const writeTool = createBasicTool("write", "Write");
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[initialMcp.name, initialMcp as unknown as AgentTool],
		]);
		if (options.xdevRegistry && !options.lazyWrite) toolRegistry.set(writeTool.name, writeTool);
		const mock = options.responses ? createMockModel({ responses: options.responses }) : undefined;
		const contexts: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: options.xdevRegistry
					? options.lazyWrite
						? [readTool, initialMcp as unknown as AgentTool]
						: [readTool, writeTool, initialMcp as unknown as AgentTool]
					: [readTool, initialMcp as unknown as AgentTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock
				? (model, context, streamOptions) => {
						contexts.push([...context.messages]);
						return mock.stream(model, context, streamOptions);
					}
				: undefined,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry,
			builtInToolNames: options.xdevRegistry && !options.lazyWrite ? ["read", "write"] : ["read"],
			ensureWriteRegistered: async () => {
				if (!options.xdevRegistry) return false;
				if (!toolRegistry.has("write")) toolRegistry.set("write", writeTool);
				return true;
			},
			rebuildSystemPrompt: async (toolNames, _tools) => ({
				systemPrompt: [await rebuildSystemPrompt(toolNames)],
			}),
			getMcpServerInstructions: options.getMcpServerInstructions,
			getLocalCalendarDate: options.getLocalCalendarDate,
			xdevRegistry: options.xdevRegistry,
		});
		sessions.push(session);
		return { session, contexts };
	}

	it("skips rebuild when an MCP refresh produces an identical tool set", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});
		// The session constructor does not run rebuildSystemPrompt; baseline=0.
		expect(rebuildCount).toBe(0);

		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// First refresh: no signature recorded yet, must rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Second refresh with byte-identical metadata: must NOT rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Third refresh, again identical: still no rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);
	});

	it("rebuilds when an MCP tool's description changes", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v1");
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(1);

		const v2 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v2");
		await session.refreshMCPTools([v2]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when the active tool list changes via setActiveToolsByName", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const b = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain");

		// Connected MCP tools are all enabled after refresh.
		await session.refreshMCPTools([a, b]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Remove one active tool: the active list shrinks, so rebuild must fire.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same list again: skip.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Restore it: rebuild fires again.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search", "mcp__nucleus_explain"]);
		expect(rebuildCount).toBe(baseline + 2);
	});

	it("updates live active-tool predicates before rebuilding the prompt", async () => {
		const activeToolNames = new Set(["read", "bash", "grep"]);
		const readTool = createBasicTool("read", "Read");
		const bashTool = createBasicTool("bash", "Bash");
		const grepTool = createBasicTool("grep", "Grep");
		Object.defineProperty(bashTool, "description", {
			get: () => (activeToolNames.has("grep") ? "bash sees grep" : "bash hides grep"),
			enumerable: true,
			configurable: true,
		});
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[bashTool.name, bashTool],
			[grepTool.name, grepTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, bashTool, grepTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			toolRegistry,
			setActiveToolNames: names => {
				activeToolNames.clear();
				for (const name of names) {
					activeToolNames.add(name);
				}
			},
			rebuildSystemPrompt: async (_toolNames, tools) => ({
				systemPrompt: [tools.get("bash")?.description ?? "missing bash"],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read", "bash"]);

		expect(agent.state.systemPrompt).toEqual(["bash hides grep"]);
	});

	it("does not skip when refreshBaseSystemPrompt is called explicitly", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Explicit refresh must always rebuild (callers use it to pick up env-side changes
		// such as edit mode toggles, which are invisible to our tool signature).
		await session.refreshBaseSystemPrompt();
		expect(rebuildCount).toBe(2);

		// Subsequent identical MCP refresh should still skip after the explicit refresh
		// freshens the cached signature.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when the refresh argument tool order changes", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_a", "nucleus", "a", "A");
		const b = createMcpCustomTool("mcp__nucleus_b", "nucleus", "b", "B");

		// All connected MCP tools are active, so their ordering contributes to the
		// rendered prompt and changing it must rebuild.
		await session.refreshMCPTools([a, b]);
		expect(rebuildCount).toBe(1);

		await session.refreshMCPTools([b, a]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when an MCP tool's label changes", async () => {
		// Tool labels are rendered into the prompt body (`{{label}}: \`{{name}}\``),
		// so a label change — even with name and description constant — must force
		// a rebuild. Otherwise we'd serve a stale label after an MCP server upgrade.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		// Override the auto-derived label so the test mutates only the label.
		const v1WithLabel = { ...v1, label: "old label" } as typeof v1;
		await session.refreshMCPTools([v1WithLabel]);
		expect(rebuildCount).toBe(1);

		const v2WithLabel = { ...v1, label: "new label" } as typeof v1;
		await session.refreshMCPTools([v2WithLabel]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when MCP server instructions text changes", async () => {
		// `rebuildSystemPrompt` embeds per-server `instructions` text into the appended
		// prompt. The signature must include this so a server upgrade that changes
		// instructions while keeping tools constant still triggers a rebuild.
		let rebuildCount = 0;
		const instructions = new Map<string, string>([["nucleus", "v1 instructions"]]);
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ getMcpServerInstructions: () => instructions },
		);

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Same tools, same instructions: skip.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate the live instructions map (callers return the live reference).
		instructions.set("nucleus", "v2 instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);

		// Adding a new server's instructions also triggers rebuild.
		instructions.set("glean", "glean instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when an MCP registry tool's metadata changes", async () => {
		// All connected MCP tools are enabled. The signature must capture the full
		// registry so a description change cannot leave stale prompt metadata cached.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		}, {});

		const active = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const secondary = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v1");

		await session.refreshMCPTools([active, secondary]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same registry: skip.
		await session.refreshMCPTools([active, secondary]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the secondary tool's description: the signature must differ and force
		// a rebuild.
		const secondaryV2 = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v2");
		await session.refreshMCPTools([active, secondaryV2]);
		expect(rebuildCount).toBe(baseline + 1);
	});
	it("rebuilds when an MCP tool's customWireName changes", async () => {
		// `customWireName` overrides the model-facing tool name (e.g. `edit` exposes
		// itself as `apply_patch` to GPT-5). The wire name is rendered into the prompt
		// body via `toolPromptNames`, so a wire-name flip with the rest of the metadata
		// constant would otherwise leave a stale system prompt that advertises the wrong
		// callable name to the model. The signature must catch this.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		// Attach a custom wire name to the MCP tool. `applyToolProxy` forwards arbitrary
		// properties from the underlying CustomTool to the wrapper, so the AgentTool the
		// signature inspects exposes `customWireName` as if it were declared on the type.
		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const v1WithWire = { ...v1, customWireName: "wire_v1" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Same wire name: skip.
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Wire name changes while name/label/description stay constant: must rebuild.
		const v2WithWire = { ...v1, customWireName: "wire_v2" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v2WithWire]);
		expect(rebuildCount).toBe(2);

		// Drop wire name entirely: must rebuild (signature must differ from `wire_v2`).
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when a tool's getter-based description reflects new settings state", async () => {
		// Built-in tools whose prompt-rendered metadata depends on settings expose
		// `description` via getters that re-evaluate on every access (TaskTool reads
		// task.disabledAgents/maxConcurrency/isolation.mode/simple/async.enabled, and
		// EditTool resolves through the current edit-mode definition). The signature
		// reads `tool.description` live each call, so a settings flip that mutates the
		// rendered string must change the signature on the next
		// `#applyActiveToolsByName`.
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			// The dynamic tool is active, so the signature reads its description via
			// the active tool metadata segment.
			{},
		);

		// Reuse the initially-active MCP name so the tool stays in the active list
		// across refreshes - we want to defend the path where `tool.description` is read
		// for the active descriptionSegment, not just the registrySegment.
		const settingState = { disabled: "none" };
		const dynamicTool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "placeholder");
		Object.defineProperty(dynamicTool, "description", {
			get: () => `dynamic disabled=${settingState.disabled}`,
			enumerable: true,
			configurable: true,
		});

		await session.refreshMCPTools([dynamicTool]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same underlying state, same tool object identity: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the settings-backed state. The tool object identity does not change,
		// but its `description` getter now returns a new string. The signature must
		// pick this up live (no per-tool caching) and force a rebuild.
		settingState.disabled = "plan,scout";
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same state again: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);
	});
	it("rebuilds when the local calendar date rolls over between tool-stable MCP refreshes", async () => {
		// `buildSystemPrompt` injects today's local date into the prompt body. The
		// signature reads the same date provider so a session spanning local midnight
		// must rebuild after an MCP reconnect with an otherwise identical tool set.
		let currentDate = "2026-06-30";
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ getLocalCalendarDate: () => currentDate },
		);
		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

		// First refresh: no signature yet, must rebuild.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Same tools, same local day: signature matches, skip.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		currentDate = "2026-07-01";

		// Same tools, new local calendar day: date segment changed, must rebuild.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);

		// Same tools, same new local day: skip again.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});
	it("does not rebuild when MCP server instructions change only beyond the 4000-char truncation boundary", async () => {
		// `rebuildSystemPrompt` (sdk.ts) truncates each server instruction to 4000 chars
		// before embedding it. The `getMcpServerInstructions` callback must therefore
		// return pre-truncated strings so the signature hashes exactly what the prompt
		// builder uses. Changes beyond char 4000 cannot affect rendered prompt bytes
		// and must NOT trigger a rebuild.
		const prefix = "A".repeat(4000);
		const instructions = new Map<string, string>([["nucleus", `${prefix}_tail_v1`]]);
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{
				getMcpServerInstructions: () => {
					// Mirror what sdk.ts does: truncate to 4000 chars before returning.
					const out = new Map<string, string>();
					for (const [name, text] of instructions) {
						out.set(name, text.length > 4000 ? text.slice(0, 4000) : text);
					}
					return out;
				},
			},
		);
		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate only the text beyond char 4000: truncated string is identical → skip.
		instructions.set("nucleus", `${prefix}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate within the first 4000 chars: truncated string differs → rebuild.
		instructions.set("nucleus", `${"B".repeat(4000)}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});

	it("waits for the next user prompt before delivering xd:// mount notices", async () => {
		const firstCallStarted = Promise.withResolvers<void>();
		const releaseFirstCall = Promise.withResolvers<void>();
		let rebuildCount = 0;
		const { session, contexts } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{
				xdevRegistry: new XdevRegistry([]),
				responses: [
					async () => {
						firstCallStarted.resolve();
						await releaseFirstCall.promise;
						return { content: ["first answer"] };
					},
					{ content: ["second answer"] },
					{ content: ["third answer"] },
				],
			},
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		// Devices mount while the first request is in flight. The refresh must
		// not turn the hidden notice into a second, unsolicited provider call.
		const firstPrompt = session.prompt("hello");
		await firstCallStarted.promise;
		await session.refreshMCPTools([search]);
		await session.refreshMCPTools([search, fetch]);
		releaseFirstCall.resolve();
		await firstPrompt;
		expect(rebuildCount).toBe(1);
		expect(contexts).toHaveLength(1);
		expect(mountNoticesIn(contexts[0])).toHaveLength(0);

		// The next user prompt carries one coalesced notice for both mounts.
		await session.prompt("again");
		expect(contexts).toHaveLength(2);
		const mountNotices = mountNoticesIn(contexts[1]);
		expect(mountNotices).toHaveLength(1);
		expect(mountNotices[0]).toContain("became available");
		expect(mountNotices[0]).toContain("xd://mcp__nucleus_search");
		expect(mountNotices[0]).toContain("xd://mcp__nucleus_fetch");
		expect(mountNotices[0]).not.toContain("No longer mounted");

		// A later unmount is likewise held for the following user prompt.
		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(1);
		expect(contexts).toHaveLength(2);
		await session.prompt("third");
		const allNotices = mountNoticesIn(contexts[2]);
		expect(allNotices).toHaveLength(2);
		expect(allNotices[1]).toContain("No longer mounted");
		expect(allNotices[1]).toContain("xd://mcp__nucleus_fetch");
		expect(allNotices[1]).not.toContain("became available");
	});

	it("caps dynamic xd:// mount-notice summaries", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdevRegistry: new XdevRegistry([]),
			responses: [{ content: ["ok"] }],
		});
		const description = `Search ${"x".repeat(XdevRegistry.EXTERNAL_DESCRIPTION_CAP * 3)} TAIL`;
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", description);

		await session.refreshMCPTools([search]);
		await session.prompt("hello");

		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("xd://mcp__nucleus_search");
		expect(notices[0]).not.toContain("TAIL");
	});

	it("keeps the rendered mount notice within one shared budget across inventory and inline docs", async () => {
		// With `tools.xdevDocs = "inline"` and a 4000-char cap, 150 long
		// descriptions would produce a ~96,000-char notice if the inventory and
		// the inline docs each spent their own 48,000-char allowance. The notice
		// must share a single budget across both sections.
		const registry = new XdevRegistry([], 4000);
		const tools = Array.from({ length: 150 }, (_, index) =>
			createMcpCustomTool(
				`mcp__large_tool_${index}`,
				"large",
				`tool_${index}`,
				`Tool ${index}. ${"x".repeat(5000)}`,
			),
		);
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdevRegistry: registry,
			responses: [{ content: ["ok"] }],
		});
		session.settings.set("tools.xdevDocs", "inline");

		await session.refreshMCPTools(tools);
		await session.prompt("hello");

		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		const notice = notices[0]!;
		// Only the variable content is budgeted; measure the fixed template
		// boilerplate by rendering the same branches with 1-char markers.
		const marker = prompt.render(xdevMountNoticePrompt, {
			added: [{ name: "n", summary: "s" }],
			removed: [],
			docs: "d",
			omitted_line: undefined,
		});
		const overhead = marker.length - "- xd://n — s".length - "d".length;
		expect(notice.length).toBeLessThanOrEqual(XdevRegistry.DOCS_TOTAL_BUDGET + overhead);
		// Name-slot reservation: every device is still announced by name.
		expect(notice).toContain("- xd://mcp__large_tool_149");
		// No device leaks its full 5000-char description into the notice.
		expect(notice).not.toContain("x".repeat(4500));
		// Rows whose summary was budgeted away must not emit a dangling separator.
		expect(notice).not.toMatch(/—\s*\n/);
	});

	it("announces omitted devices in the mount notice when name rows exhaust the budget", async () => {
		// With `tools.xdevDocs = "builtins"`, external devices contribute no docs,
		// so devices dropped from an oversized inventory would be invisible to the
		// model without an omission line pointing at `read xd://`.
		const registry = new XdevRegistry([]);
		const tools = Array.from({ length: 300 }, (_, index) =>
			createMcpCustomTool(`mcp__${"n".repeat(180)}_${index}`, "longnames", `tool_${index}`, `Tool ${index}`),
		);
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdevRegistry: registry,
			responses: [{ content: ["ok"] }],
		});

		await session.refreshMCPTools(tools);
		await session.prompt("hello");

		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/\d+ more devices omitted — read xd:\/\/ for the complete inventory\./);
	});

	it("applies a settings description-cap change to the active xd prompt", async () => {
		const registry = new XdevRegistry([], 50);
		const description = `Search ${"x".repeat(400)} TAIL`;
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", description);
		const { session } = newSession(async () => registry.docsAll("inline"), { xdevRegistry: registry });
		const errors: string[] = [];
		const controller = new SelectorController({
			session,
			showError: (message: string) => errors.push(message),
		} as unknown as InteractiveModeContext);

		await session.refreshMCPTools([search]);
		expect(session.agent.state.systemPrompt.join("\n")).not.toContain(description);

		session.settings.set("tools.xdevExternalDescriptionCap", 1000);
		// Settings UI fire-and-forgets; await the session path for the contract.
		controller.handleSettingChange("tools.xdevExternalDescriptionCap", 1000);
		await session.applyXdevExternalDescriptionCap(1000);

		expect(session.agent.state.systemPrompt.join("\n")).toContain(description);
		expect(errors).toEqual([]);
	});

	it("keeps the latest description-cap when settings change races a rebuild", async () => {
		const registry = new XdevRegistry([], 50);
		const description = `Search ${"x".repeat(400)} TAIL`;
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", description);
		let rebuilds = 0;
		const { session } = newSession(
			async () => {
				rebuilds++;
				// Yield so a second apply can interleave before we snapshot docs.
				await Bun.sleep(20);
				return registry.docsAll("inline");
			},
			{ xdevRegistry: registry },
		);

		await session.refreshMCPTools([search]);
		// First apply starts a slow rebuild; second supersedes before it finishes.
		// The settings UI persists before notifying, so mirror that ordering.
		session.settings.set("tools.xdevExternalDescriptionCap", 100);
		const first = session.applyXdevExternalDescriptionCap(100);
		session.settings.set("tools.xdevExternalDescriptionCap", 1000);
		const second = session.applyXdevExternalDescriptionCap(1000);
		await Promise.all([first, second]);

		expect(session.agent.state.systemPrompt.join("\n")).toContain(description);
		// At least one rebuild for the final value; supersession may skip an intermediate.
		expect(rebuilds).toBeGreaterThanOrEqual(1);
	});

	it("converges the registry cap to the effective setting on prompt refresh (project settings reload)", async () => {
		// `/move` reloads project settings without running the selector's
		// setting-change handler; the next prompt refresh (which the /move flow
		// triggers via refreshSkillState) must re-sync the registry from the
		// effective setting instead of keeping the construction-time cap.
		const registry = new XdevRegistry([], 50);
		const description = `Search ${"x".repeat(400)} TAIL`;
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", description);
		const { session } = newSession(async () => registry.docsAll("inline"), { xdevRegistry: registry });

		session.settings.set("tools.xdevExternalDescriptionCap", 50);
		await session.refreshMCPTools([search]);
		expect(session.agent.state.systemPrompt.join("\n")).not.toContain(description);

		// Simulates Settings.reloadForCwd landing a different project value.
		session.settings.set("tools.xdevExternalDescriptionCap", 1000);
		await session.refreshBaseSystemPrompt();

		expect(session.agent.state.systemPrompt.join("\n")).toContain(description);
	});

	it("never lets a stale in-flight rebuild overwrite a newer description cap", async () => {
		// Race from the review: a tool-refresh rebuild snapshots the prompt with
		// the old cap and finishes after the cap-apply rebuild, clobbering the
		// new cap's prompt while the registry keeps the new value. All prompt
		// applications must serialize so the last scheduled rebuild wins.
		const registry = new XdevRegistry([], 50);
		const description = `Search ${"x".repeat(400)} TAIL`;
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", description);
		const readTool = createBasicTool("read", "Read");
		const writeTool = createBasicTool("write", "Write");
		// A top-level tool with a mutable description: flipping it changes the
		// tool signature, forcing a rebuild on the next MCP refresh while the
		// mounted xd:// device (whose inventory is deliberately not signed) stays.
		const bashState = { version: "v1" };
		const bashTool = createBasicTool("bash", "Bash");
		Object.defineProperty(bashTool, "description", {
			get: () => `bash ${bashState.version}`,
			enumerable: true,
			configurable: true,
		});
		const staleRebuildGate = Promise.withResolvers<void>();
		let rebuilds = 0;
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, writeTool, bashTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry: new Map<string, AgentTool>([
				[readTool.name, readTool],
				[writeTool.name, writeTool],
				[bashTool.name, bashTool],
			]),
			builtInToolNames: ["read", "write", "bash"],
			xdevRegistry: registry,
			rebuildSystemPrompt: async () => {
				rebuilds++;
				// Snapshot first (with the cap active at build start), then park the
				// second rebuild so the cap change lands mid-flight.
				const snapshot = registry.docsAll("inline");
				if (rebuilds === 2) await staleRebuildGate.promise;
				return { systemPrompt: [snapshot] };
			},
		});
		sessions.push(session);

		session.settings.set("tools.xdevExternalDescriptionCap", 50);
		await session.refreshMCPTools([search]);
		expect(session.agent.state.systemPrompt.join("\n")).not.toContain("TAIL");

		// Force rebuild 2, which snapshots with the old cap and stalls mid-flight.
		bashState.version = "v2";
		const slowRefresh = session.refreshMCPTools([search]);
		await Bun.sleep(10);
		expect(rebuilds).toBe(2);

		// The cap changes while rebuild 2 is in flight; its own rebuild must apply last.
		session.settings.set("tools.xdevExternalDescriptionCap", 1000);
		const capApply = session.applyXdevExternalDescriptionCap(1000);
		staleRebuildGate.resolve();
		await Promise.all([slowRefresh, capApply]);

		expect(session.agent.state.systemPrompt.join("\n")).toContain("TAIL");
		expect(rebuilds).toBe(3);
	});

	it("inlines configured late xd:// device docs in mount notices", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdevRegistry: new XdevRegistry([]),
			responses: [{ content: ["ok"] }],
		});
		session.settings.set("tools.xdevDocs", "builtins");
		session.settings.set("tools.xdevInlineDevices", ["mcp__nucleus_*"]);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		await session.refreshMCPTools([search]);
		await session.prompt("hello");

		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("## mcp__nucleus_search");
		expect(notices[0]).toContain("## Schema");
	});

	it("drops a mount delta that cancels out before the next prompt", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdevRegistry: new XdevRegistry([]),
			responses: [{ content: ["ok"] }],
		});
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");

		// fetch mounts and unmounts before the model ever hears about it → the
		// coalesced notice must not mention it in either direction.
		await session.refreshMCPTools([search]);
		await session.refreshMCPTools([search, fetch]);
		await session.refreshMCPTools([search]);

		await session.prompt("hello");
		const notices = mountNoticesIn(contexts[0]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("xd://mcp__nucleus_search");
		expect(notices[0]).not.toContain("mcp__nucleus_fetch");
		expect(notices[0]).not.toContain("No longer mounted");
	});

	it("keeps xd:// mount deltas model-visible without rendering them during quiet startup", async () => {
		const { session, contexts } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdevRegistry: new XdevRegistry([]),
			responses: [{ content: ["ok"] }],
		});
		session.settings.set("startup.quiet", true);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "xdev") notices.push(event.message);
		});

		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		await session.refreshMCPTools([search]);

		expect(notices).toEqual([]);
		await session.prompt("hello");
		const delivered = mountNoticesIn(contexts[0]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("xd://mcp__nucleus_search");
	});

	it("keeps lazy write registration while rolling back applied state on rebuild failure", async () => {
		let failRebuild = true;
		const xdevRegistry = new XdevRegistry([]);
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdevRegistry, lazyWrite: true },
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const activeBefore = session.getActiveToolNames();
		const mountedBefore = session.getMountedXdevToolNames();

		await expect(session.refreshMCPTools([search])).rejects.toThrow("rebuild failed");

		expect(session.getActiveToolNames()).toEqual(activeBefore);
		expect(session.getMountedXdevToolNames()).toEqual(mountedBefore);
		expect(session.getToolByName("write")).toBeDefined();
		expect(session.hasBuiltInTool("write")).toBe(true);

		failRebuild = false;
		await session.refreshMCPTools([search]);
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getMountedXdevToolNames()).toContain(search.name);
	});

	it("rolls back MCP catalog replacement when prompt rebuild fails", async () => {
		let failRebuild = false;
		let date = "2026-07-16";
		const xdevRegistry = new XdevRegistry([]);
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdevRegistry, getLocalCalendarDate: () => date },
		);
		const oldTool = createMcpCustomTool("mcp__nucleus_old", "nucleus", "old", "Old tool");
		const newTool = createMcpCustomTool("mcp__nucleus_new", "nucleus", "new", "New tool");
		await session.refreshMCPTools([oldTool]);
		date = "2026-07-17";
		failRebuild = true;

		await expect(session.refreshMCPTools([newTool])).rejects.toThrow("rebuild failed");
		expect(session.getToolByName(oldTool.name)).toBeDefined();
		expect(session.getToolByName(newTool.name)).toBeUndefined();
		expect(session.getMountedXdevToolNames()).toContain(oldTool.name);

		failRebuild = false;
		await session.refreshMCPTools([newTool]);
		expect(session.getToolByName(oldTool.name)).toBeUndefined();
		expect(session.getToolByName(newTool.name)).toBeDefined();
		expect(session.getMountedXdevToolNames()).toContain(newTool.name);
	});

	it("rolls back RPC catalog replacement when prompt rebuild fails", async () => {
		let failRebuild = false;
		let date = "2026-07-16";
		const xdevRegistry = new XdevRegistry([]);
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdevRegistry, getLocalCalendarDate: () => date },
		);
		const oldTool = { ...createBasicTool("rpc_old", "RPC Old"), loadMode: "discoverable" as const };
		const newTool = { ...createBasicTool("rpc_new", "RPC New"), loadMode: "discoverable" as const };
		await session.refreshRpcHostTools([oldTool]);
		date = "2026-07-17";
		failRebuild = true;

		await expect(session.refreshRpcHostTools([newTool])).rejects.toThrow("rebuild failed");
		expect(session.getToolByName(oldTool.name)).toBeDefined();
		expect(session.getToolByName(newTool.name)).toBeUndefined();
		expect(session.getMountedXdevToolNames()).toContain(oldTool.name);

		failRebuild = false;
		await session.refreshRpcHostTools([newTool]);
		expect(session.getToolByName(oldTool.name)).toBeUndefined();
		expect(session.getToolByName(newTool.name)).toBeDefined();
		expect(session.getMountedXdevToolNames()).toContain(newTool.name);
	});
});
