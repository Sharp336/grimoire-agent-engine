/**
 * FlowExecutionStrategy — data-driven orchestrator over the live Agent.
 *
 * Wiring summary:
 *   - syncBeforeModelCall: push the entry frame on first turn, compute the
 *     effective tool set for the top of the flow stack, install the flow
 *     system prompt, and expose meta tools + node-as-tools + attachments.
 *   - transformContext: stable prefix + pocket messages from the open
 *     frames + a trailing <flow> developer block describing the current
 *     node and outgoing edges.
 *   - onTurnEnd: drive the interpreter with each tool_call event; auto-pop
 *     the top frame if the assistant answered with plain text and no tool
 *     calls. Parent frames resume with their attached tools intact.
 *   - onAgentEnd: persist flow state as a CustomMessage and close trace.
 *
 * Sub-flows are real. The `tool_selection` node, when pushed, injects the
 * scene-local toolbox (search_tools / describe_tool / select_tool /
 * drop_tool / ret) for as long as it is on top of the stack. select_tool
 * attaches tools to the PARENT frame's attachment set; when the sub-flow
 * rets, the parent resumes with those tools in scope.
 */

import type {
	AgentContext,
	AgentMessage,
	AgentTool,
	ExecutionStrategy,
	StrategyConvertToLlmFn,
} from "@oh-my-pi/pi-agent-core";
import type { DeveloperMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { classifyAssistantMessage, extractText } from "./flow-message-utils";
import { FlowRuntime } from "./flow-runtime";
import {
	createFlowStateMessage,
	extractLatestFlowState,
	isFlowStateMessage,
} from "./flow-state-codec";
import basePrompt from "./prompts/base.md" with { type: "text" };
import stylePrompt from "./prompts/style.md" with { type: "text" };
import toolSelectionPrompt from "./prompts/tool-selection.md" with { type: "text" };
import { seedFlowSkills } from "./flow-skill-seed";
import { FlowStore } from "./flow-store";
import { createFlowEditTool, createFlowInspectTool, isFlowOwnedToolName } from "./flow-tools";
import { FlowTraceWriter } from "./flow-trace";
import { FlowInterpreter } from "./flow-interpreter";
import { matchesName } from "./flow-tool-filter";
import {
	createToolSelectionTools,
	TOOL_SELECTION_NODE_ID,
	type ToolSelectionBackend,
} from "./flow-tool-selection";
import type { Flow as FlowV2 } from "./flow-types";
import type { CallFrame, FlowState } from "./types";


/**
 * Core builtin tools that are always active in any chat/flow frame. The
 * model should never need to `tool_selection` to reach these — they are
 * the basic toolkit. MCP tools and niche builtins still go through the
 * toolbox.
 */
const ALWAYS_ACTIVE_BUILTINS = [
	"bash",
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"lsp",
	"ast_grep",
	"ast_edit",
	"task",
	"todo_write",
	"web_search",
	"fetch",
	"ask",
];

/**
 * Auto-scout: tools that are "quiet" and can stay in the root frame
 * without polluting context. Everything else is "noisy" — when called
 * from the root node and a `scout` node exists, the strategy wraps the
 * tool so it auto-pushes a scout frame before executing.
 *
 * The model doesn't notice — it calls `bash` as usual. The wrapper
 * pushes scout, runs the real tool inside, and returns the result.
 * The model continues working in scout, then calls `ret(summary)` to
 * surface findings. All intermediate output dies with the frame.
 */
const QUIET_TOOLS = new Set([
	"ask",
	"todo_write",
	"task",
]);

export interface FlowExecutionStrategyOptions {
	getSubAgentModel?: () => Model | undefined;
	trace?: boolean;
	storePath?: string;
	/** Project working directory. Used to place .omp/flow.json. Defaults to process.cwd(). */
	cwd?: string;
	/** Session identifier used as a prefix for trace folders. */
	sessionId?: string;
	/** Node id to push at the start of every fresh user turn. Defaults to "chat". */
	entryNodeId?: string;
	/**
	 * Persist a message through the host's normal pipeline (agent state +
	 * session manager). Used by node-prompt injection so injected user
	 * messages end up in session.jsonl. Caller wires this from main.ts.
	 */
	persistMessage?: (msg: AgentMessage) => void;
}

export class FlowExecutionStrategy implements ExecutionStrategy {
	readonly name = "flow";

	#options: FlowExecutionStrategyOptions;
	#store: FlowStore;
	#flow: FlowV2;
	#interpreter: FlowInterpreter;
	#hydratedFromHistory = false;
	#trace: FlowTraceWriter | null = null;
	#traceEnabled: boolean;
	#seenUserMessages = new WeakSet<AgentMessage>();
	#rootClosedForCurrentTurn = false;
	#lastSystemPrompt: string | null = null;
	#lastToolNames: string[] = [];
	#entryNodeId: string;

	/**
	 * Per-node attachments. `select_tool` inside tool_selection adds to the
	 * SET keyed on the parent frame's NODE ID (not frame id). This way the
	 * attachments survive across user turns: when a fresh `chat` frame is
	 * pushed for the next user message, it inherits the chat-node
	 * attachment set automatically.
	 *
	 * When a frame closes its own node's attachments stay around — they
	 * live with the node, not the frame instance — unless the user or the
	 * model explicitly drops them via `drop_tool`.
	 */
	#attachments = new Map<string, Set<string>>();

	/**
	 * Pending ret request. Processed at onTurnEnd or drainPendingRet.
	 */
	#pendingRet: { value?: string } | null = null;

	/**
	 * Reference to the live AgentContext.messages array — set on every
	 * syncBeforeModelCall. Used by interpreter pushNode (via the
	 * appendMessage callback) to inject node prompts as user messages
	 * after onEnter hooks complete.
	 */
	#liveMessages: AgentMessage[] | null = null;

	/** Sub-flows that completed (ret) this conversation. Rendered in <flow>. */
	#completedSubFlows: { nodeId: string; result: string }[] = [];


	/**
	 * Catalog snapshot refreshed every turn — mirror of ctx.tools sans the
	 * flow-owned meta tools. Used by the tool_selection backend.
	 */
	#catalogSnapshot: { name: string; description: string }[] = [];



	constructor(options: FlowExecutionStrategyOptions = {}) {
		this.#options = options;
		this.#traceEnabled = options.trace ?? !!process.env.OMP_FLOW_TRACE;
		// Seed bundled flow skills (flow-editor, ...) into <cwd>/.omp/skills/
		// before loading the flow, so `onEnter` hooks that reference
		// `skill://flow-editor` resolve on first run.
		seedFlowSkills(options.cwd);
		this.#store = new FlowStore({ path: options.storePath, cwd: options.cwd });
		this.#flow = this.#store.load();
		this.#entryNodeId = options.entryNodeId ?? (this.#flow.nodes.chat ? "chat" : Object.keys(this.#flow.nodes)[0] ?? "chat");
		this.#interpreter = new FlowInterpreter(this.#flow, new FlowRuntime(this.#flow));
		this.#installTraceListener();
	}

	get storePath(): string {
		return this.#store.path;
	}

	get interpreter(): FlowInterpreter {
		return this.#interpreter;
	}

	/**
	 * Register each flow node as a slash command (e.g. /scout, /fixer).
	 * The command handler sends the args as a user prompt prefixed with
	 * "enter <node>:" so the model enters the node with context.
	 *
	 * `promptFn` is called with the final text — the caller wires it to
	 * session.prompt() from main.ts.
	 */
	registerNodeCommands(
		runner: { registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }): void },
		promptFn: (text: string) => Promise<void>,
	): void {
		const skipNodes = new Set([this.#entryNodeId, TOOL_SELECTION_NODE_ID]);
		for (const [nodeId, node] of Object.entries(this.#flow.nodes)) {
			if (skipNodes.has(nodeId)) continue;
			runner.registerCommand(nodeId, {
				description: node.description ?? `Enter ${nodeId} sub-flow`,
				async handler(args: string) {
					const prompt = args.trim()
						? `enter ${nodeId}: ${args.trim()}`
						: `enter ${nodeId}`;
					await promptFn(prompt);
				},
			});
		}
	}

	createPayloadLogger(): ((payload: unknown) => unknown) | undefined {
		if (!this.#traceEnabled || !this.#trace) return undefined;
		const writer = this.#trace;
		return (payload: unknown) => {
			writer.writePayload(payload);
			return undefined;
		};
	}

	/**
	 * Return the correct flowFrameId for a message at persist time.
	 *
	 * Called by session manager (the single writer) from `#appendEntry`.
	 * The strategy owns the "which frame?" logic:
	 *
	 * For toolResult messages:
	 *   - toolName is a node id → parent frame (node-entry tool's
	 *     execute() already pushed a child frame, but the result
	 *     belongs to the caller)
	 *   - toolName is "ret" → parent frame (ret pops the child,
	 *     result belongs to the caller)
	 *
	 * For assistant messages:
	 *   - Contains a toolCall whose name is a node id → top frame
	 *     (entry tool hasn't executed yet at message_end time, so
	 *     stack is still the caller's — top is correct)
	 *   - Contains a toolCall named "ret" → parent frame (the
	 *     assistant decided to ret from the current sub-frame, so
	 *     the message belongs to the caller that will resume)
	 *
	 * Everything else → top frame.
	 */
	getFrameIdForMessage(msg: unknown): string | undefined {
		const stack = this.#interpreter.runtime.frameStack;
		if (stack.length === 0) return undefined;

		const m = msg as { role?: string; toolName?: string; content?: unknown[] };

		// toolResult: node-entry and ret results belong to parent
		if (m.role === "toolResult" && typeof m.toolName === "string") {
			const isNodeEntry = m.toolName in this.#flow.nodes;
			const isRet = m.toolName === "ret";
			if ((isNodeEntry || isRet) && stack.length >= 2) {
				return stack[stack.length - 2].id;
			}
		}

		// assistant: node-entry or ret tool call → parent frame.
		// Race: by the time the consumer persists the assistant message,
		// the producer may have already executed the tool (pushing a child
		// frame for node-entry, or setting pendingRet for ret). So the
		// stack already reflects the post-execute state. We need parent.
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const hasNodeEntry = m.content.some(
				(b: any) => b?.type === "toolCall" && b.name in this.#flow.nodes,
			);
			const hasRet = m.content.some(
				(b: any) => b?.type === "toolCall" && b.name === "ret",
			);
			if ((hasNodeEntry || hasRet) && stack.length >= 2) {
				return stack[stack.length - 2].id;
			}
		}

		return stack[stack.length - 1].id;
	}

	#installTraceListener(): void {
		if (!this.#traceEnabled) return;
		if (!this.#trace) this.#trace = new FlowTraceWriter(this.#options.sessionId);
		const writer = this.#trace;
		this.#interpreter.runtime.setTraceListener(event => writer.write(event));
	}

	get state(): Readonly<FlowState> {
		const attachments: Record<string, string[]> = {};
		for (const [nodeId, set] of this.#attachments) {
			if (set.size > 0) attachments[nodeId] = Array.from(set);
		}
		return {
			version: 2,
			flowId: this.#flow.id,
			cursor: this.#interpreter.currentNodeId ?? this.#entryNodeId,
			frameStack: [...this.#interpreter.runtime.frameStack],
			executionLog: [...this.#interpreter.runtime.executionLog],
			attachments: Object.keys(attachments).length > 0 ? attachments : undefined,
			completedSubFlows: this.#completedSubFlows.length > 0 ? [...this.#completedSubFlows] : undefined,
		};
	}

	wrapConvertToLlm(base: StrategyConvertToLlmFn): StrategyConvertToLlmFn {
		return async (messages: AgentMessage[]): Promise<Message[]> => {
			const filtered = messages.filter(m => !isFlowStateMessage(m));
			return base(filtered);
		};
	}

	async transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		this.#rehydrateOnce(messages);

		// Set of frameIds that are currently open (on the stack).
		const openFrameIds = new Set(
			this.#interpreter.runtime.frameStack.map(f => f.id),
		);

		const view: AgentMessage[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (isFlowStateMessage(messages[i])) continue;
			const frameId = (messages[i] as any).flowFrameId as string | undefined;
			// No frameId = pre-flow message, always include.
			// frameId in openFrameIds = active frame, include.
			// frameId NOT in openFrameIds = closed frame, exclude.
			if (frameId !== undefined && !openFrameIds.has(frameId)) continue;
			view.push(messages[i]);
		}

		const statusMsg = this.#buildFlowStatusMessage(view.length);
		if (statusMsg) view.push(statusMsg);

		this.#dumpModelRequest(view);
		return view;
	}

	#dumpModelRequest(messages: readonly AgentMessage[]): void {
		if (!this.#trace) return;
		this.#trace.write({
			kind: "model_request",
			at: Date.now(),
			systemPrompt: this.#lastSystemPrompt ?? "",
			tools: this.#lastToolNames,
			messages: messages as unknown[],
		});
	}

	async syncBeforeModelCall(ctx: AgentContext): Promise<void> {
		this.#rehydrateOnce(ctx.messages);
		this.#maybeStartNewTrace(ctx.messages);

		// Bind the live messages array so pushNode can append node prompts
		// (via interpreter context's appendMessage callback) — both for
		// the root push below and for auto-scout pushes triggered later
		// inside tool execute closures.
		this.#liveMessages = ctx.messages;

		// The catalog is everything ctx.tools has minus our own meta tools
		// AND minus any scene-local tools the strategy itself injected on
		// the previous turn (search_tools / describe_tool / select_tool /
		// drop_tool / ret). Refreshed each turn because MCP loads async.
		// Meta tools `read_flow` / `flow_edit` are prepended so any node
		// that mentions them in `available_tools` can opt in via the
		// standard filter path — no special-casing of node ids.
		const SCENE_LOCAL = new Set(["search_tools", "describe_tool", "select_tool", "drop_tool", "ret"]);
		const baseCatalog = (ctx.tools ?? []).filter(
			t => !isFlowOwnedToolName(t.name) && !SCENE_LOCAL.has(t.name) && t.name !== TOOL_SELECTION_NODE_ID,
		);
		const metaTools: AgentTool<any>[] = [
			createFlowInspectTool(this.#interpreter),
			createFlowEditTool(this.#interpreter, flow => {
				this.#flow = flow;
				this.#store.save(flow);
			}),
		];
		const catalog: AgentTool<any>[] = [...metaTools, ...baseCatalog];
		this.#catalogSnapshot = catalog.map(t => ({ name: t.name, description: t.description ?? "" }));

		// Process any pending frame transitions left over from the previous
		// turn (race: onTurnEnd may run after the next syncBeforeModelCall in
		// the agent-loop producer/consumer pair).
		await this.#drainPendingRet(catalog);

		if (this.#interpreter.isStackEmpty && !this.#rootClosedForCurrentTurn) {
			await this.#interpreter.pushNode(this.#entryNodeId, this.#interpreterCtx(catalog));
		}

		const topFrame = this.#interpreter.runtime.topFrame;
		const topNodeId = this.#interpreter.currentNodeId;

		// In-frame tool set:
		//   1. Node-as-tool exposure for any other node the model can call
		//      from the current node (resolved from the node's available_tools
		//      filter). We do NOT leak the full catalog here.
		//   2. Plus any tools this frame has "attached" via tool_selection.
		//   3. If we are currently inside tool_selection, expose its
		//      scene-local tools (search/describe/select/drop/ret).
		let effective: AgentTool<any>[] = [];

		if (topNodeId === TOOL_SELECTION_NODE_ID && topFrame) {
			effective = createToolSelectionTools(this.#makeToolSelectionBackend(topFrame, catalog));
		} else if (topFrame && topNodeId) {
			const currentNode = this.#interpreter.currentNode;
			const nodeFilter = currentNode?.available_tools;
			const byName = new Map(catalog.map(t => [t.name, t]));

			// Start with the baseline: core builtins + attached tools.
			for (const name of ALWAYS_ACTIVE_BUILTINS) {
				const tool = byName.get(name);
				if (tool && !effective.some(t => t.name === name)) effective.push(tool);
			}
			const attached = this.#attachments.get(topNodeId) ?? new Set<string>();
			for (const name of attached) {
				const tool = byName.get(name);
				if (tool && !effective.some(t => t.name === name)) effective.push(tool);
			}

			if (nodeFilter && nodeFilter.length > 0) {
				// Node declared a filter: add allowed tools and node-as-tools
				// on top of the baseline, then apply deny entries.
				const denied: string[] = [];
				for (const entry of nodeFilter) {
					if (entry.startsWith("!")) {
						denied.push(entry.slice(1));
						continue;
					}
					// Wildcard allow: pull in every catalog tool that matches.
					if (entry.includes("*")) {
						for (const tool of catalog) {
							if (matchesName(entry, tool.name) && !effective.some(t => t.name === tool.name)) {
								effective.push(tool);
							}
						}
						continue;
					}
					const tool = byName.get(entry);
					if (tool && !effective.some(t => t.name === entry)) {
						effective.push(tool);
						continue;
					}
					const node = this.#flow.nodes[entry];
					if (node && !effective.some(t => t.name === entry)) {
						effective.push(this.#makeGenericNodeTool(entry, catalog));
					}
				}
				// Remove denied tools (literal or wildcard).
				if (denied.length > 0) {
					effective = effective.filter(t => !denied.some(pat => matchesName(pat, t.name)));
				}
			} else {
				// No filter: expose all flow nodes as callable tools.
				for (const nodeId of Object.keys(this.#flow.nodes)) {
					if (nodeId === topNodeId) continue;
					if (nodeId === TOOL_SELECTION_NODE_ID) continue;
					if (effective.some(t => t.name === nodeId)) continue;
					effective.push(this.#makeGenericNodeTool(nodeId, catalog));
				}
			}

			// tool_selection is always available (navigation, not work).
			if (!effective.some(t => t.name === TOOL_SELECTION_NODE_ID)) {
				effective.push(this.#makeToolSelectionEntryTool(catalog));
			}

			// In any non-root sub-frame, expose a generic `ret` tool so the
			// model has an explicit way to close the frame and return to
			// the caller. `tool_selection` supplies its own `ret` via the
			// scene-local toolset above.
			if (this.#interpreter.runtime.frameStack.length > 1 && !effective.some(t => t.name === "ret")) {
				effective.push(this.#makeRetTool(catalog));
			}
		}

		// Auto-scout: when at root and a `scout` node exists, wrap noisy
		// tools so they auto-push a scout frame before executing. The model
		// calls `bash` as usual — the wrapper is transparent. After the
		// tool runs, the model continues in scout and must `ret(summary)`
		// to surface findings. All intermediate output dies with the frame.
		const isRoot = this.#interpreter.runtime.frameStack.length === 1;
		const hasScout = !!this.#flow.nodes.scout;
		if (isRoot && hasScout) {
			effective = effective.map(t =>
				QUIET_TOOLS.has(t.name) ? t : this.#wrapAutoScout(t, catalog),
			);
		}

		ctx.tools = effective;
		ctx.systemPrompt = this.#buildFlowSystemPrompt();
		this.#lastSystemPrompt = ctx.systemPrompt;
		this.#lastToolNames = ctx.tools.map(t => t.name);
	}

	/**
	 * Build the InterpreterContext used for pushNode/popNode/handleEvent.
	 * `appendMessage` writes into the live AgentContext.messages array
	 * (bound at the top of syncBeforeModelCall) so node prompts injected
	 * by the interpreter end up in the conversation immediately.
	 */
	#interpreterCtx(catalog: AgentTool<any>[]): { tools: AgentTool<any>[]; appendMessage?: (msg: AgentMessage) => void } {
		return {
			tools: catalog,
			appendMessage: this.#makeAppendMessage(),
		};
	}

	#makeToolSelectionEntryTool(catalog: AgentTool<any>[]): AgentTool<any> {
		const strategy = this;
		return this.#interpreter.makeNodeEntryTool(TOOL_SELECTION_NODE_ID, () => catalog, {
			label: "ToolSelection",
			description:
				"Enter the tool_selection sub-flow to browse and activate tools from the catalog. Inside this frame you will see search_tools / describe_tool / select_tool / drop_tool / ret. Any tool you select is attached to THIS frame (the parent) and becomes callable when tool_selection rets. Scratch in the sub-flow dies with it.",
			appendMessage: () => strategy.#makeAppendMessage(),
		});
	}

	#makeGenericNodeTool(nodeId: string, catalog: AgentTool<any>[]): AgentTool<any> {
		const strategy = this;
		return this.#interpreter.makeNodeEntryTool(nodeId, () => catalog, {
			appendMessage: () => strategy.#makeAppendMessage(),
		});
	}

	#makeAppendMessage(): ((msg: AgentMessage) => void) | undefined {
		const persist = this.#options.persistMessage;
		const live = this.#liveMessages;
		if (!persist && !live) return undefined;
		return msg => {
			// Persist through the host pipeline (agent state + session manager).
			persist?.(msg);
			// Also push into the live ctx.messages so the model sees the
			// message *immediately* this turn — without waiting for the
			// agent loop to round-trip the new message back into context.
			if (live && !live.includes(msg)) live.push(msg);
		};
	}

	/**
	 * Wrap a tool for auto-scout: when the model calls it from root, the
	 * wrapper pushes a scout frame, executes the real tool inside, and
	 * returns the result. The model continues in scout (sees ret + all
	 * noisy tools) and must ret(summary) to exit. Transparent — same
	 * name, same params, same result shape.
	 */
	#wrapAutoScout(tool: AgentTool<any>, catalog: AgentTool<any>[]): AgentTool<any> {
		// Don't wrap node-entry tools or flow meta tools
		if (tool.name in this.#flow.nodes) return tool;
		if (isFlowOwnedToolName(tool.name)) return tool;
		if (tool.name === "ret") return tool;

		const strategy = this;
		const realExecute = tool.execute.bind(tool);
		return {
			...tool,
			async execute(id: string, params: any, ...rest: any[]): Promise<any> {
				// If we're already inside scout (or any sub-frame), don't
				// push again. The first noisy tool call in a root turn
				// pushes scout; subsequent tool calls in the same turn run
				// in the existing scout frame.
				const stack = strategy.#interpreter.runtime.frameStack;
				const alreadyInScout = stack.some(f => f.nodeId === "scout");
				if (!alreadyInScout) {
					await strategy.#interpreter.pushNode("scout", strategy.#interpreterCtx(catalog));
				}
				return realExecute(id, params, ...rest);
			},
		};
	}

	#makeRetTool(_catalog: AgentTool<any>[]): AgentTool<any> {
		const strategy = this;
		return {
			name: "ret",
			label: "Ret",
			description:
				"Close the current sub-flow frame and return control to the caller. `value` is REQUIRED and MUST be a non-empty string — it is the ONLY information that survives into the parent frame. Everything else (search results, file contents, reasoning) is discarded when the frame closes. Write a concrete, actionable summary of what you found or accomplished. If you have nothing to report, say why. An empty or missing value means the parent learns nothing from this sub-flow.",
			parameters: {
				type: "object",
				properties: {
					value: {
						type: "string",
						minLength: 1,
						description: "REQUIRED — concrete result of this sub-flow: findings, decisions, artifacts. This is the only thing the caller will see.",
					},
				},
				required: ["value"],
			} as never,
			strict: false,
			concurrency: "exclusive",
			async execute(_id: string, params: { value?: string }): Promise<{ content: { type: "text"; text: string }[] }> {
				strategy.#pendingRet = { value: params?.value };
				return { content: [{ type: "text", text: "ret" }] };
			},
		};
	}

	#makeToolSelectionBackend(topFrame: CallFrame, catalog: AgentTool<any>[]): ToolSelectionBackend {
		const strategy = this;
		// Attachments key is the PARENT NODE ID (not frame.id) so the
		// attachments persist across user turns even when the chat frame
		// is re-created for each fresh root push.
		const stack = strategy.#interpreter.runtime.frameStack;
		const parentFrame = stack[stack.length - 2];
		const parentNodeId = parentFrame?.nodeId ?? topFrame.nodeId;
		if (!strategy.#attachments.has(parentNodeId)) {
			strategy.#attachments.set(parentNodeId, new Set<string>());
		}
		const set = strategy.#attachments.get(parentNodeId)!;
		const byName = new Map(catalog.map(t => [t.name, t]));
		return {
			listCatalog: () => strategy.#catalogSnapshot.slice(),
			attach: (name: string) => {
				if (!byName.has(name)) return { ok: false, reason: `unknown tool "${name}"` };
				set.add(name);
				return { ok: true };
			},
			detach: (name: string) => {
				if (!set.has(name)) return { ok: false, reason: `"${name}" not attached` };
				set.delete(name);
				return { ok: true };
			},
			currentAttachments: () => Array.from(set),
			requestRet: (value?: string) => {
				strategy.#pendingRet = { value };
			},
		};
	}

	async #popWithRetValue(retValue: string, catalog: AgentTool<any>[]): Promise<void> {
		const nodeId = this.#interpreter.currentNodeId ?? "unknown";
		await this.#interpreter.popNode(retValue, this.#interpreterCtx(catalog));
		this.#completedSubFlows.push({ nodeId, result: retValue || "(no value)" });
	}

	async #drainPendingRet(catalog: AgentTool<any>[]): Promise<void> {
		while (this.#pendingRet && this.#interpreter.runtime.frameStack.length > 1) {
			await this.#popWithRetValue(this.#pendingRet.value ?? "", catalog);
			this.#pendingRet = null;
		}
		// If pendingRet is still set but we're at root, discard it — never
		// pop the root frame.
		if (this.#pendingRet && this.#interpreter.runtime.frameStack.length <= 1) {
			this.#pendingRet = null;
		}
	}

	#buildFlowSystemPrompt(): string {
		const cur = this.#interpreter.currentNodeId;
		const node = this.#interpreter.currentNode;
		const sections: string[] = [basePrompt.trimEnd()];
		if (cur === TOOL_SELECTION_NODE_ID) {
			sections.push(toolSelectionPrompt.trimEnd());
		} else if (cur && node) {
			const lines = [`## Current node: \`${cur}\``];
			if (node.description) lines.push(node.description);
			sections.push(lines.join("\n"));
		}
		sections.push(stylePrompt.trimEnd());
		sections.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);
		return sections.join("\n\n");
	}

	async onTurnEnd(info: {
		context: AgentContext;
		message: AgentMessage;
		newMessages: readonly AgentMessage[];
	}): Promise<void> {
		const stackWasNonEmpty =
			!this.#interpreter.isStackEmpty || this.#interpreter.runtime.executionLog.length > 0;

		// Single pass over the assistant message's content blocks.
		const cls = classifyAssistantMessage(info.message);

		// flowFrameId stamping is handled by session manager at persist
		// time via getFrameIdForMessage(). No re-stamping here.

		// Drive edges for every tool call in the assistant message.
		// onTurnEnd doesn't have ctx.messages directly — but #liveMessages
		// is still set from the last syncBeforeModelCall, so #interpreterCtx
		// works. info.context.messages is the same array anyway.
		this.#liveMessages = info.context.messages;
		const catalog = (info.context.tools ?? []).filter(t => !isFlowOwnedToolName(t.name));
		for (const name of cls.toolCallNames) {
			await this.#interpreter.handleEvent({ kind: "tool_call", name }, this.#interpreterCtx(catalog));
		}

		// Ret: pop the sub-frame. Never pop the root frame — only sub-frames
		// (depth > 1) should be closed by ret.
		if (this.#pendingRet && this.#interpreter.runtime.frameStack.length > 1) {
			await this.#popWithRetValue(this.#pendingRet.value ?? "", catalog);
			this.#pendingRet = null;
		}

		if (this.#interpreter.isStackEmpty && stackWasNonEmpty) {
			this.#rootClosedForCurrentTurn = true;
		}
	}

	async onAgentEnd(info: { context: AgentContext; newMessages: readonly AgentMessage[] }): Promise<void> {
		const stateMsg = createFlowStateMessage(this.state);
		// Persist through the host pipeline so the state message lands in
		// session.jsonl and survives restart. Falls back to in-memory push
		// when no persistMessage callback is wired.
		const persist = this.#options.persistMessage;
		if (persist) {
			persist(stateMsg as unknown as AgentMessage);
		} else {
			info.context.messages.push(stateMsg);
		}
		this.#trace?.close();
	}

	#rehydrateOnce(messages: readonly AgentMessage[]): void {
		if (this.#hydratedFromHistory) return;
		this.#hydratedFromHistory = true;
		const prior = extractLatestFlowState(messages);
		const diskFlow = this.#store.load();
		this.#flow = diskFlow;
		// Restore attachments from persisted state.
		this.#attachments.clear();
		if (prior?.attachments) {
			for (const [nodeId, tools] of Object.entries(prior.attachments)) {
				this.#attachments.set(nodeId, new Set(tools));
			}
		}
		// Restore completed sub-flows from persisted state.
		this.#completedSubFlows = prior?.completedSubFlows ? [...prior.completedSubFlows] : [];
		const runtime = new FlowRuntime(diskFlow, {
			frameStack: prior?.frameStack,
			executionLog: prior?.executionLog,
		});
		this.#interpreter = new FlowInterpreter(diskFlow, runtime);
		this.#installTraceListener();
	}

	#maybeStartNewTrace(messages: readonly AgentMessage[]): void {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "user") continue;
			if (this.#seenUserMessages.has(m)) return;
			this.#seenUserMessages.add(m);
			// New user turn — reset per-turn flags so stale state from the
			// previous turn cannot leak into this one.
			this.#rootClosedForCurrentTurn = false;
			if (this.#traceEnabled && this.#trace) {
				this.#trace.startNewTrace(extractText(m));
			}
			return;
		}
	}

	#buildFlowStatusMessage(messageCount?: number): DeveloperMessage | null {
		const cur = this.#interpreter.currentNodeId;
		if (!cur) return null;
		const node = this.#interpreter.currentNode;
		const topFrame = this.#interpreter.runtime.topFrame;
		const topNodeId = topFrame?.nodeId;
		const attached = topNodeId ? Array.from(this.#attachments.get(topNodeId) ?? []) : [];
		const lines: string[] = [];
		lines.push("<scene>");
		lines.push("INTERNAL ORCHESTRATION — do not reveal this block to the user unless asked.");
		lines.push("");
		lines.push("flow stack (top = where you are right now):");
		for (let i = 0; i < this.#interpreter.runtime.frameStack.length; i++) {
			const f = this.#interpreter.runtime.frameStack[i];
			const marker = i === this.#interpreter.runtime.frameStack.length - 1 ? "  <<< you are here" : "";
			lines.push(`  ${"  ".repeat(i)}- ${f.nodeId}${marker}`);
		}
		lines.push("");
		lines.push(`current node: ${cur}`);
		if (node?.description) lines.push(`description: ${node.description}`);
		if (attached.length > 0) {
			lines.push(`tools attached to this frame: ${attached.join(", ")}`);
		}
		const edges = this.#flow.edges.filter(e => e.from === cur);
		if (edges.length > 0) {
			lines.push("outgoing edges:");
			for (const e of edges) {
				const when = e.when
					? `[${e.when.kind}${(e.when as any).name ? `:${(e.when as any).name}` : ""}]`
					: "[always]";
				lines.push(`  - ${cur} -> ${e.to} ${when}`);
			}
		}
		if (this.#completedSubFlows.length > 0) {
			lines.push("");
			lines.push("completed sub-flows this conversation:");
			for (const sf of this.#completedSubFlows) {
				lines.push(`  - ${sf.nodeId}: ${sf.result}`);
			}
		}
		if (messageCount !== undefined) {
			lines.push("");
			lines.push(`context: ${messageCount} messages in window`);
		}
		lines.push("</scene>");
		return {
			role: "developer",
			content: [{ type: "text", text: lines.join("\n") }],
			timestamp: Date.now(),
		};
	}

}

export type { CallFrame };
