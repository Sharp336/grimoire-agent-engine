import type { SnapshotStore } from "@oh-my-pi/hashline";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import type { ImageBudget, TUI } from "@oh-my-pi/pi-tui";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../../modes/components/read-tool-group";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../../modes/components/tool-execution";
import { TranscriptContainer } from "../../modes/components/transcript-container";
import { StreamingRevealController } from "./streaming-reveal";

export interface TranscriptRendererDeps {
	getSmoothStreaming(): boolean;
	getHideThinkingBlock(): boolean;
	getToolResultPreview(): boolean;
	getToolOutputExpanded(): boolean;
	getShowImages(): boolean;
	requestRender(): void;
	ui?: TUI;
	pendingTools?: Map<string, ToolExecutionHandle>;
	getToolByName?(toolName: string): AgentTool | undefined;
	getCwd?(): string;
	getSnapshots?(): SnapshotStore | undefined;
	getEditFuzzyThreshold?(): number | undefined;
	getEditAllowFuzzy?(): boolean;
	getAssistantThinkingRenderers?(): readonly AssistantThinkingRenderer[];
	getImageBudget?(): ImageBudget | undefined;
	getStreamingComponent?(): AssistantMessageComponent | undefined;
	setStreamingComponent?(component: AssistantMessageComponent | undefined): void;
	setStreamingMessage?(message: AssistantMessage | undefined): void;
	getAssistantMessageDisplay?(message: AssistantMessage): AssistantMessage;
}

type MessageStartEvent = Extract<AgentEvent, { type: "message_start" }>;
type MessageUpdateEvent = Extract<AgentEvent, { type: "message_update" }>;
type MessageEndEvent = Extract<AgentEvent, { type: "message_end" }>;
type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionUpdateEvent = Extract<AgentEvent, { type: "tool_execution_update" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

type ToolResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
};

function normalizedRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asyncState(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const asyncDetails = (details as { async?: unknown }).async;
	if (!asyncDetails || typeof asyncDetails !== "object") return undefined;
	const state = (asyncDetails as { state?: unknown }).state;
	return typeof state === "string" ? state : undefined;
}

function argsWithPartialJson(args: unknown, partialJson: unknown): unknown {
	if (partialJson === undefined) return args;
	return { ...normalizedRecord(args), __partialJson: partialJson };
}

export class TranscriptRenderer {
	readonly #deps: TranscriptRendererDeps;
	readonly #container: TranscriptContainer;
	readonly #pendingTools: Map<string, ToolExecutionHandle>;
	readonly #streamingReveal: StreamingRevealController;
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	// Count of visible assistant content blocks (rendered non-empty text/thinking)
	// already seen in the current streaming message. A newly appearing one breaks
	// the read run: the rendered reasoning/answer is a visual separator, so reads
	// after it start a fresh group. Empty/absent thinking — common when a model
	// emits one read per completion — does not break it, so a run of consecutive
	// reads collapses into one group even across completion boundaries.
	#lastVisibleBlockCount = 0;
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	#backgroundToolCallIds = new Set<string>();
	#streamingComponent: AssistantMessageComponent | undefined = undefined;

	constructor(deps: TranscriptRendererDeps, container: TranscriptContainer = new TranscriptContainer()) {
		this.#deps = deps;
		this.#container = container;
		this.#pendingTools = deps.pendingTools ?? new Map<string, ToolExecutionHandle>();
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: deps.getSmoothStreaming,
			getHideThinkingBlock: deps.getHideThinkingBlock,
			requestRender: deps.requestRender,
		});
	}

	getContainer(): TranscriptContainer {
		return this.#container;
	}

	get streamingComponent(): AssistantMessageComponent | undefined {
		return this.#getStreamingComponent();
	}

	feed(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#handleAgentStart();
				break;
			case "agent_end":
				this.#handleAgentEnd();
				break;
			case "message_start":
				this.#handleMessageStart(event);
				break;
			case "message_update":
				this.#handleMessageUpdate(event);
				break;
			case "message_end":
				this.#handleMessageEnd(event);
				break;
			case "tool_execution_start":
				this.#handleToolExecutionStart(event);
				break;
			case "tool_execution_update":
				this.#handleToolExecutionUpdate(event);
				break;
			case "tool_execution_end":
				this.#handleToolExecutionEnd(event);
				break;
			case "turn_start":
			case "turn_end":
				break;
		}
	}

	seed(events: AgentEvent[]): void {
		this.#streamingReveal.stop();
		this.#container.clear();
		this.#pendingTools.clear();
		this.#backgroundToolCallIds.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastReadGroup = undefined;
		this.#lastVisibleBlockCount = 0;
		this.#lastAssistantComponent = undefined;
		this.#setStreamingComponent(undefined);
		this.#setStreamingMessage(undefined);
		for (const event of events) {
			this.feed(event);
		}
	}

	dispose(): void {
		this.#streamingReveal.stop();
	}

	#handleAgentStart(): void {
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		this.#lastVisibleBlockCount = 0;
		this.#lastAssistantComponent = undefined;
	}

	#handleAgentEnd(): void {
		this.#streamingReveal.stop();
		const streamingComponent = this.#getStreamingComponent();
		if (streamingComponent) {
			this.#container.removeChild(streamingComponent);
			this.#setStreamingComponent(undefined);
			this.#setStreamingMessage(undefined);
		}
		for (const toolCallId of Array.from(this.#pendingTools.keys())) {
			if (this.#backgroundToolCallIds.has(toolCallId)) continue;
			const component = this.#pendingTools.get(toolCallId);
			if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent) {
				component.seal();
			}
			this.#pendingTools.delete(toolCallId);
		}
		this.#backgroundToolCallIds = new Set(
			Array.from(this.#backgroundToolCallIds).filter(toolCallId => this.#pendingTools.has(toolCallId)),
		);
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		this.#lastAssistantComponent = undefined;
		this.#lastVisibleBlockCount = 0;
	}

	#handleMessageStart(event: MessageStartEvent): void {
		if (event.message.role !== "assistant") {
			this.#resetReadGroup();
			return;
		}
		this.#beginAssistantComponent(event.message);
		this.#deps.requestRender();
	}

	/**
	 * Create + register the streaming assistant component and begin its reveal.
	 * Reused for orphan recovery: when a live transcript attaches mid-message (the
	 * original message_start was missed), the first update/end synthesizes the
	 * component so the in-flight turn still renders instead of being dropped.
	 */
	#beginAssistantComponent(message: AssistantMessage): AssistantMessageComponent {
		this.#lastVisibleBlockCount = 0;
		const component = new AssistantMessageComponent(
			undefined,
			this.#deps.getHideThinkingBlock(),
			this.#deps.requestRender,
			this.#deps.getAssistantThinkingRenderers?.() ?? [],
			this.#deps.getImageBudget?.() ?? this.#deps.ui?.imageBudget,
		);
		this.#setStreamingComponent(component);
		this.#setStreamingMessage(message);
		this.#container.addChild(component);
		this.#streamingReveal.begin(component, message);
		return component;
	}

	#handleMessageUpdate(event: MessageUpdateEvent): void {
		if (event.message.role !== "assistant") return;
		if (!this.#getStreamingComponent()) {
			// Mid-message attach: synthesize the missed start so updates still render.
			this.#beginAssistantComponent(event.message);
		}
		this.#setStreamingMessage(event.message);
		this.#streamingReveal.setTarget(event.message);

		const visibleBlockCount = event.message.content.filter(
			content =>
				(content.type === "text" && content.text.trim().length > 0) ||
				(content.type === "thinking" && content.thinking.trim().length > 0),
		).length;
		if (visibleBlockCount > this.#lastVisibleBlockCount) {
			this.#resetReadGroup();
			this.#lastVisibleBlockCount = visibleBlockCount;
		}

		for (const content of event.message.content) {
			if (content.type !== "toolCall") continue;
			if (content.name === "read") {
				if (!readArgsHaveTarget(content.arguments)) {
					continue;
				}
				if (!readArgsTargetInternalUrl(content.arguments)) {
					this.#trackReadToolCall(content.id, content.arguments);
					const pending = this.#pendingTools.get(content.id);
					if (pending) {
						pending.updateArgs(content.arguments, content.id);
					} else {
						const group = this.#getReadGroup();
						group.updateArgs(content.arguments, content.id);
						this.#pendingTools.set(content.id, group);
					}
					continue;
				}
			}

			const renderArgs =
				"partialJson" in content ? argsWithPartialJson(content.arguments, content.partialJson) : content.arguments;
			const pending = this.#pendingTools.get(content.id);
			if (pending) {
				pending.updateArgs(renderArgs, content.id);
				continue;
			}
			this.#resetReadGroup();
			const toolComponent = this.#createToolExecutionComponent(content.name, renderArgs, content.id);
			if (!toolComponent) continue;
			this.#container.addChild(toolComponent);
			this.#pendingTools.set(content.id, toolComponent);
		}

		this.#deps.requestRender();
	}

	#handleMessageEnd(event: MessageEndEvent): void {
		if (event.message.role !== "assistant") return;
		const component = this.#getStreamingComponent() ?? this.#beginAssistantComponent(event.message);
		this.#setStreamingMessage(event.message);
		this.#streamingReveal.stop();
		component.updateContent(this.#deps.getAssistantMessageDisplay?.(event.message) ?? event.message);

		if (event.message.stopReason !== "aborted" && event.message.stopReason !== "error") {
			for (const [toolCallId, pending] of this.#pendingTools.entries()) {
				pending.setArgsComplete(toolCallId);
			}
		} else {
			for (const [toolCallId, pending] of this.#pendingTools.entries()) {
				if (!this.#backgroundToolCallIds.has(toolCallId) && pending instanceof ToolExecutionComponent) {
					pending.seal();
				}
			}
		}
		this.#lastAssistantComponent = component;
		this.#lastAssistantComponent.setUsageInfo(event.message.usage);
		this.#lastAssistantComponent.markTranscriptBlockFinalized();
		this.#setStreamingComponent(undefined);
		this.#setStreamingMessage(undefined);
		this.#deps.requestRender();
	}

	#handleToolExecutionStart(event: ToolExecutionStartEvent): void {
		if (this.#pendingTools.has(event.toolCallId)) return;
		if (event.toolName === "read" && readArgsHaveTarget(event.args) && !readArgsTargetInternalUrl(event.args)) {
			this.#trackReadToolCall(event.toolCallId, event.args);
			const pending = this.#pendingTools.get(event.toolCallId);
			if (pending) {
				pending.updateArgs(event.args, event.toolCallId);
			} else {
				const group = this.#getReadGroup();
				group.updateArgs(event.args, event.toolCallId);
				this.#pendingTools.set(event.toolCallId, group);
			}
			this.#deps.requestRender();
			return;
		}

		this.#resetReadGroup();
		const component = this.#createToolExecutionComponent(event.toolName, event.args, event.toolCallId);
		if (!component) return;
		this.#container.addChild(component);
		this.#pendingTools.set(event.toolCallId, component);
		this.#deps.requestRender();
	}

	#handleToolExecutionUpdate(event: ToolExecutionUpdateEvent): void {
		const component = this.#pendingTools.get(event.toolCallId);
		if (!component) return;
		const state = asyncState(event.partialResult.details);
		const isFinalAsyncState = state === "completed" || state === "failed";
		component.updateResult(
			{ ...event.partialResult, isError: state === "failed" },
			!isFinalAsyncState,
			event.toolCallId,
		);
		if (isFinalAsyncState) {
			this.#pendingTools.delete(event.toolCallId);
			this.#backgroundToolCallIds.delete(event.toolCallId);
		}
		this.#deps.requestRender();
	}

	#handleToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (event.toolName === "read") {
			this.#handleReadToolExecutionEnd(event);
		} else {
			this.#handleStandardToolExecutionEnd(event);
		}
	}

	#handleReadToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
			const component = this.#pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
				this.#pendingTools.delete(event.toolCallId);
			}
			this.#syncBackgroundTool(event.toolCallId, event.result.details);
			if (!this.#backgroundToolCallIds.has(event.toolCallId)) {
				this.#clearReadToolCall(event.toolCallId);
			}
			this.#deps.requestRender();
			return;
		}

		let component = this.#pendingTools.get(event.toolCallId);
		if (!component) {
			const group = this.#getReadGroup();
			const args = this.#readToolCallArgs.get(event.toolCallId);
			if (args) {
				group.updateArgs(args, event.toolCallId);
			}
			component = group;
			this.#pendingTools.set(event.toolCallId, group);
		}
		const isBackgroundRunning = asyncState(event.result.details) === "running";
		component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
		if (isBackgroundRunning) {
			this.#backgroundToolCallIds.add(event.toolCallId);
		} else {
			this.#pendingTools.delete(event.toolCallId);
			this.#backgroundToolCallIds.delete(event.toolCallId);
			this.#clearReadToolCall(event.toolCallId);
		}
		this.#deps.requestRender();
	}

	#handleStandardToolExecutionEnd(event: ToolExecutionEndEvent): void {
		const component = this.#pendingTools.get(event.toolCallId);
		if (!component) return;
		const isBackgroundRunning = asyncState(event.result.details) === "running";
		component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
		if (isBackgroundRunning) {
			this.#backgroundToolCallIds.add(event.toolCallId);
		} else {
			this.#pendingTools.delete(event.toolCallId);
			this.#backgroundToolCallIds.delete(event.toolCallId);
		}
		this.#deps.requestRender();
	}

	#syncBackgroundTool(toolCallId: string, details: unknown): void {
		if (asyncState(details) === "running") {
			this.#backgroundToolCallIds.add(toolCallId);
		} else {
			this.#backgroundToolCallIds.delete(toolCallId);
		}
	}

	#resetReadGroup(): void {
		this.#lastReadGroup?.finalize();
		this.#lastReadGroup = undefined;
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			const group = new ReadToolGroupComponent({
				showContentPreview: this.#deps.getToolResultPreview(),
			});
			group.setExpanded(this.#deps.getToolOutputExpanded());
			this.#container.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		this.#readToolCallArgs.set(toolCallId, normalizedRecord(args));
		const assistantComponent = this.#getStreamingComponent() ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#inlineReadToolImages(toolCallId: string, result: ToolResult): boolean {
		if (!this.#deps.getShowImages()) return false;
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = result.content
			.filter(
				(content): content is ImageContent =>
					content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
			)
			.map(content => ({ type: "image", data: content.data, mimeType: content.mimeType }));
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return true;
	}

	#createToolExecutionComponent(
		toolName: string,
		args: unknown,
		toolCallId: string,
	): ToolExecutionComponent | undefined {
		const ui = this.#deps.ui;
		if (!ui) return undefined;
		const component = new ToolExecutionComponent(
			toolName,
			args,
			{
				snapshots: this.#deps.getSnapshots?.(),
				showImages: this.#deps.getShowImages(),
				editFuzzyThreshold: this.#deps.getEditFuzzyThreshold?.(),
				editAllowFuzzy: this.#deps.getEditAllowFuzzy?.(),
			},
			this.#deps.getToolByName?.(toolName),
			ui,
			this.#deps.getCwd?.(),
			toolCallId,
		);
		component.setExpanded(this.#deps.getToolOutputExpanded());
		return component;
	}

	#getStreamingComponent(): AssistantMessageComponent | undefined {
		return this.#deps.getStreamingComponent?.() ?? this.#streamingComponent;
	}

	#setStreamingComponent(component: AssistantMessageComponent | undefined): void {
		this.#streamingComponent = component;
		this.#deps.setStreamingComponent?.(component);
	}

	#setStreamingMessage(message: AssistantMessage | undefined): void {
		this.#deps.setStreamingMessage?.(message);
	}
}
