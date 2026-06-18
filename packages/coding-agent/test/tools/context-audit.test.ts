import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, ContextUsageBreakdown } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_TOOLS, ContextAuditTool, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";

function createSession(overloads: { breakdown?: ContextUsageBreakdown; messages?: AgentMessage[] }): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		skipPythonPreflight: true,
		getContextBreakdown: () => overloads.breakdown,
		getProviderMessages: async () => overloads.messages ?? [],
	};
}

const BREAKDOWN: ContextUsageBreakdown = {
	contextWindow: 100_000,
	anchored: true,
	usedTokens: 5_000,
	systemPromptTokens: 800,
	systemToolsTokens: 1_200,
	systemContextTokens: 500,
	skillsTokens: 300,
	messagesTokens: 2_200,
};

// A heavy tool result, a tool-call assistant turn, and a tiny user message —
// distinct token weights so ranking/filtering is observable.
const MESSAGES: AgentMessage[] = [
	{ role: "user", content: "hi", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "reading the file now" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: [{ type: "text", text: "x".repeat(6_000) }],
		isError: false,
		timestamp: 3,
	},
	{
		role: "developer",
		content: [{ type: "text", text: `\x3Cfile path="/big.txt">\n${"y".repeat(8_000)}\n\x3C/file>` }],
		timestamp: 4,
	},
];

async function run(params: Record<string, unknown> = {}) {
	const tool = new ContextAuditTool(createSession({ breakdown: BREAKDOWN, messages: MESSAGES }));
	return tool.execute("call-1", params as never, undefined, undefined, undefined);
}

describe("context_audit registration", () => {
	it("is a default built-in tool with a discoverable loadMode and summary", async () => {
		expect("context_audit" in BUILTIN_TOOLS).toBe(true);
		const session = createSession({});
		const tools = await createTools(session);
		const names = tools.map(t => t.name);
		expect(names).toContain("context_audit");
		const tool = tools.find(t => t.name === "context_audit");
		expect(tool?.loadMode).toBe("discoverable");
		expect(tool?.summary).toBe("Audit what is consuming the model context window");
	});
});

describe("context_audit report", () => {
	it("reports window usage and the authoritative category breakdown", async () => {
		const result = await run();
		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { text: string }).text;
		// Window line anchored on the breakdown's real numbers.
		expect(text).toContain("5,000 / 100.0k tokens");
		expect(text).toContain("5.0% of context window");
		expect(text).toContain("anchored on provider usage");
		// Every category label is present.
		for (const label of ["System prompt", "Tool schemas", "System context", "Skills", "Conversation messages"]) {
			expect(text).toContain(label);
		}
		// Details snapshot mirrors the breakdown.
		expect(result.details).toMatchObject({
			contextWindow: 100_000,
			usedTokens: 5_000,
			anchored: true,
			categories: { systemPrompt: 800, tools: 1_200, systemContext: 500, skills: 300, messages: 2_200 },
		});
	});

	it("ranks the heaviest message rows and labels them", async () => {
		const text = ((await run()).content[0] as { text: string }).text;
		// Rows are labeled and ranked by estimated tokens; the assistant tool-call turn
		// carries its tool-call count in the label, and every ranked row precedes the tiny "hi" user row.
		expect(text).toContain("tool result: read");
		expect(text).toContain("assistant (1 tool call)");
		// Heaviest row appears before the tiny "hi" user row.
		const toolResultIdx = text.indexOf("tool result: read");
		const userIdx = text.indexOf("#0 user");
		expect(toolResultIdx).toBeGreaterThan(-1);
		expect(userIdx).toBeGreaterThan(-1);
		expect(toolResultIdx).toBeLessThan(userIdx);
	});

	it("respects min_tokens, query, and max_items filters", async () => {
		// min_tokens filters out the tiny user message.
		const minTokens = ((await run({ min_tokens: 50 })).content[0] as { text: string }).text;
		expect(minTokens).toContain("tool result: read");
		expect(minTokens).not.toContain("#0 user");

		// query keeps only rows whose label/preview match.
		const queried = ((await run({ query: "read" })).content[0] as { text: string }).text;
		expect(queried).toContain("tool result: read");
		expect(queried).not.toContain("#0 user");

		// max_items caps the row count even when more rows match.
		const capped = ((await run({ max_items: 1 })).content[0] as { text: string }).text;
		// Only one row index line should appear under "Heaviest message rows".
		const heaviestSection = capped.split("Heaviest message rows")[1]?.split("Largest groups")[0] ?? "";
		const rowIndexLines = heaviestSection.match(/^ {2}#\d+ /gm) ?? [];
		expect(rowIndexLines.length).toBe(1);
	});

	it("reports unavailable when no context window has resolved", async () => {
		const tool = new ContextAuditTool(createSession({ breakdown: undefined, messages: MESSAGES }));
		const result = await tool.execute("call-1", {} as never, undefined, undefined, undefined);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Context usage unavailable");
		expect(result.details).toBeUndefined();
	});
	it("counts expanded developer (@file) content as provider-visible tokens", async () => {
		const text = ((await run()).content[0] as { text: string }).text;
		// The 8000-char @file expansion (role: developer) is the heaviest row. estimateTokens
		// has no developer case, so ranking it first guards the developer-aware estimator shim.
		const heaviestSection = text.split("Heaviest message rows")[1]?.split("Largest groups")[0] ?? "";
		const firstRow = heaviestSection.match(/^ {2}#\d+ .+$/m)?.[0] ?? "";
		expect(firstRow).toContain("developer");
	});

	it("query matches message content even when previews are hidden", async () => {
		// "xxx" appears only in the tool result's content, not its label. With previews
		// suppressed, label-only matching would hide this row — finding it proves query
		// searches the separate content (searchText) field, not just the displayed preview.
		const text = ((await run({ include_previews: false, query: "xxx" })).content[0] as { text: string }).text;
		expect(text).toContain("tool result: read");
		// The preview is genuinely suppressed: the tool result's "xxx" content is not rendered.
		expect(text).not.toContain("xxx");
	});
	it("counts image-bearing rows so they are not dropped", async () => {
		// An image-only user message: estimateTokens' user branch ignores images (0 tokens),
		// which would filter it out — hiding exactly the screenshots worth dropping.
		const imageMessages: AgentMessage[] = [
			{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
		];
		const tool = new ContextAuditTool(createSession({ breakdown: BREAKDOWN, messages: imageMessages }));
		const text = (
			(await tool.execute("c", {} as never, undefined, undefined, undefined)).content[0] as { text: string }
		).text;
		// The image row survives (not zero-filtered) and carries the image surcharge (1,200 tokens).
		expect(text).toContain("#0 user");
		expect(text).toContain("1,200t");
	});
	it("query matches tool-call arguments on assistant rows", async () => {
		// A write/edit tool call's arguments are provider-visible and token-counted, so they
		// must be searchable even though they appear in neither the label nor a text block.
		const callMessages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "w1",
						name: "write",
						arguments: { path: "/a.ts", content: "ZZUNIQUE_MARKER_ZZ body" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];
		const tool = new ContextAuditTool(createSession({ breakdown: BREAKDOWN, messages: callMessages }));
		const text = (
			(await tool.execute("c", { query: "ZZUNIQUE_MARKER_ZZ" } as never, undefined, undefined, undefined))
				.content[0] as {
				text: string;
			}
		).text;
		// The marker appears only in the tool-call arguments — finding the row proves query
		// searches the arguments, not just the `[call name]` label.
		expect(text).toContain("assistant (1 tool call)");
	});
});

// Real-session integration test: guards that sdk.ts:getProviderMessages actually
// applies encodeInbandToolHistory when an owned dialect is active. A simulated
// fake-session test would not catch the glue being deleted.
describe("context_audit in-band dialect integration", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-ctxaudit-dialect-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		try {
			if (fs.existsSync(registryDir)) fs.rmSync(registryDir, { recursive: true, force: true });
		} catch {}
	});

	it("folds assistant tool calls into dialect text on the wire (qwen3)", async () => {
		// tools.format: qwen3 forces the owned dialect regardless of model capabilities.
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.format": "qwen3", "compaction.enabled": false }),
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			enableMCP: false,
		});
		sessions.push(session);
		// Append an assistant tool-call whose arguments carry a distinctive marker. Under
		// qwen3, encodeInbandToolHistory folds this into a text block rendering the call
		// as dialect-specific tagged text, so the marker appears in the folded text —
		// not as a separate toolCall block.
		session.agent.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "writing now" },
				{
					type: "toolCall",
					id: "q1",
					name: "write",
					arguments: { path: "/p.ts", content: "DIALECT_QWEN3_MARKER" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const tool = session.getToolByName("context_audit");
		expect(tool).toBeDefined();
		// Query for the qwen3 dialect closing tag — it only appears after
		// encodeInbandToolHistory folds the toolCall into dialect text. The raw
		// messagePreview renders the call as "[call write: ...]" with no dialect
		// tag, so finding this marker proves the sdk.ts getProviderMessages glue
		// applied the in-band transform.
		const dialectCloseTag = "\x3C/tool_call>";
		const result = await tool!.execute("c", { query: dialectCloseTag } as never, undefined, undefined, undefined);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain(dialectCloseTag);
		// The row is no longer labeled as a tool-call row — calls are folded into text.
		expect(text).not.toContain("assistant (1 tool call)");
	});
});
