import { afterAll, describe, expect, it } from "bun:test";
import { addInteractiveBuiltinExtensions } from "@oh-my-pi/pi-coding-agent/main";
import type { Component } from "@oh-my-pi/pi-tui";
import commentaryCollapse from "../src/extensibility/extensions/commentary-collapse";
import {
	installPresentationPatch,
	type PresentationPatchApi,
} from "../src/extensibility/extensions/commentary-collapse/patch";
import {
	COLLAPSED_COMMENTARY_VISIBLE_CODE_POINT_LIMIT,
	createCollapsedCommentarySummary,
	transformMessageForCollapsedDisplay,
	transformMessageWithoutCommentary,
} from "../src/extensibility/extensions/commentary-collapse/transform";
import { TurnActivityGroup } from "../src/extensibility/extensions/commentary-collapse/turn-group";
import type { PhaseMessage } from "../src/extensibility/extensions/commentary-collapse/types";
import type { ExtensionAPI } from "../src/extensibility/extensions/types";

type ProviderContext = {
	model: unknown;
	hasUI: boolean;
	ui: { getToolsExpanded(): boolean };
	sessionManager: object;
};
const commentarySignature = JSON.stringify({ v: 1, id: "commentary-1", phase: "commentary" });
function fakePatchHost(calls: { expanded: number; events: number; updates: unknown[] }) {
	class Assistant {
		updateContent(message: unknown): string {
			calls.updates.push(message);
			return "native-update";
		}
		getTranscriptBlockSettledRows(): number {
			return 1;
		}
		markTranscriptBlockFinalized(): void {}
		setExpanded(_expanded: boolean): void {
			calls.expanded += 1;
		}
	}
	class Builder {
		setExpanded(_expanded: boolean): void {}
		rebuild(_entries: unknown): void {}
		append(_entries: unknown): void {}
	}
	class EventController {
		async handleEvent(_event: unknown): Promise<void> {
			calls.events += 1;
		}
	}
	class User {}
	class Ui {
		addMessageToChat(_message: unknown, _options?: unknown): void {}
	}
	return {
		version: "17.2.0",
		AssistantMessageComponent: Assistant,
		ChatTranscriptBuilder: Builder,
		EventController,
		UserMessageComponent: User,
		UiHelpers: Ui,
	};
}

function patchApi(pi: unknown): Parameters<typeof installPresentationPatch>[0] {
	return {
		pi: pi as Parameters<typeof installPresentationPatch>[0]["pi"],
		logger: { warn: () => {} },
	};
}

function clearPatchManager(): void {
	Reflect.deleteProperty(globalThis, Symbol.for("omp-commentary-collapse.patch.v1"));
}
const finalSignature = JSON.stringify({ v: 1, id: "final-1", phase: "final_answer" });

function component(rows: readonly string[]): Component {
	return { render: () => rows };
}

describe("commentary-collapse display behavior", () => {
	it("sanitizes and truncates commentary summaries by visible code points", () => {
		const summary = createCollapsedCommentarySummary("\u001b[31m  Progress\tupdate  \u001b[0m\nignored");
		expect(summary).toBe("↳ Progress update");

		const long = createCollapsedCommentarySummary("x".repeat(200));
		expect(long).toBeDefined();
		expect(Array.from(long ?? "")).toHaveLength(COLLAPSED_COMMENTARY_VISIBLE_CODE_POINT_LIMIT);
		expect(long?.endsWith("…")).toBe(true);
	});

	it("copies only native commentary blocks and leaves source content untouched", () => {
		const source = {
			role: "assistant",
			content: [
				{ type: "text", text: "working", textSignature: commentarySignature },
				{ type: "text", text: "done", textSignature: finalSignature },
			],
		};
		const originalContent = source.content;
		const collapsed = transformMessageForCollapsedDisplay(source);

		expect(collapsed).not.toBe(source);
		expect(collapsed.content).not.toBe(originalContent);
		expect(collapsed.content?.[0]).toMatchObject({ text: "↳ working", textSignature: commentarySignature });
		expect(collapsed.content?.[1]).toBe(originalContent[1]);
		expect(source.content).toBe(originalContent);
		expect(source.content[0]?.text).toBe("working");
	});

	it("removes commentary only for the final-answer display copy", () => {
		const source = {
			role: "assistant",
			content: [
				{ type: "text", text: "working", textSignature: commentarySignature },
				{ type: "text", text: "done", textSignature: finalSignature },
			],
		};
		const display = transformMessageWithoutCommentary(source);
		expect(display.content).toEqual([source.content[1]]);
		expect(source.content).toHaveLength(2);
	});

	it("collapses turn activity to a count row and replays children on expansion", () => {
		const commentary = component(["commentary"]);
		const tool = component(["tool output"]);
		const group = new TurnActivityGroup([
			{ kind: "commentary", component: commentary, textSignature: commentarySignature },
			{ kind: "tool", component: tool, toolCallId: "tool-1" },
		]);

		expect(group.render(80)).toEqual(["› 1 tool call, 1 message"]);
		group.setExpanded(true);
		expect(group.render(80)).toEqual(["commentary", "", "tool output"]);
		group.setExpanded(false);
		expect(group.render(80)).toEqual(["› 1 tool call, 1 message"]);
	});

	it("does not count malformed or other-provider signatures as native commentary", () => {
		const group = new TurnActivityGroup([
			{
				kind: "commentary",
				component: component(["unchanged"]),
				textSignatures: ["not-json", JSON.stringify({ v: 1, id: "x", phase: "analysis" })],
			},
		]);
		expect(group.getCounts()).toEqual({ toolCalls: 0, messages: 0 });
		expect(group.render(80)).toEqual(["› 0 tool calls, 0 messages"]);
	});
});

describe("commentary-collapse patch lifecycle", () => {
	afterAll(clearPatchManager);
	it("fails open for unsupported concurrent installs and delegates native setExpanded", () => {
		clearPatchManager();
		const unsupported = installPresentationPatch(patchApi({ version: "16.9.0" }));
		const calls = { expanded: 0, events: 0, updates: [] };
		const host = fakePatchHost(calls);
		const supported = installPresentationPatch(patchApi(host));
		unsupported.setEnabled(true);
		supported.setEnabled(true);
		expect(supported.compatible).toBe(false);
		expect(supported.enabled).toBe(false);
		const assistant = new host.AssistantMessageComponent();
		assistant.setExpanded(true);
		expect(calls.expanded).toBe(1);
		unsupported.dispose();
	});

	it("composes commentary expansion with the native assistant expansion method", () => {
		clearPatchManager();
		const calls = { expanded: 0, events: 0, updates: [] as unknown[] };
		const host = fakePatchHost(calls);
		const patch = installPresentationPatch(patchApi(host));
		expect(patch.compatible).toBe(true);
		patch.setEnabled(true);

		const assistant = new host.AssistantMessageComponent();
		const source = {
			role: "assistant",
			content: [{ type: "text", text: "working", textSignature: commentarySignature }],
		};
		assistant.updateContent(source);
		expect(calls.updates.at(-1)).toMatchObject({
			content: [{ text: "↳ working", textSignature: commentarySignature }],
		});

		assistant.setExpanded(true);
		expect(calls.expanded).toBe(1);
		expect(calls.updates.at(-1)).toBe(source);
		patch.dispose();
	});

	it("does not stack wrappers across repeated install and dispose", () => {
		clearPatchManager();
		const calls = { expanded: 0, events: 0, updates: [] };
		const host = fakePatchHost(calls);
		const first = installPresentationPatch(patchApi(host));
		const second = installPresentationPatch(patchApi(host));
		second.setEnabled(true);
		first.dispose();
		first.dispose();
		const assistant = new host.AssistantMessageComponent();
		assistant.setExpanded(true);
		expect(calls.expanded).toBe(1);
		second.dispose();
		second.dispose();
		expect(second.enabled).toBe(false);
	});
});

describe("commentary-collapse CLI assembly", () => {
	it("adds the built-in factory only for the interactive default path", () => {
		const enabled: { extensions: (typeof commentaryCollapse)[] } = { extensions: [] };
		addInteractiveBuiltinExtensions(enabled, true, false, false);
		expect(enabled.extensions).toEqual([commentaryCollapse]);

		const disabled: { extensions: (typeof commentaryCollapse)[] } = { extensions: [] };
		addInteractiveBuiltinExtensions(disabled, true, true, false);
		expect(disabled.extensions).toEqual([]);
	});
});

describe("commentary-collapse provider lifecycle", () => {
	it("enables presentation handling for every active provider", () => {
		const handlers = new Map<string, unknown>();
		const pi = {
			on(name: string, handler: unknown): void {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI;
		commentaryCollapse(pi);
		let expandedReads = 0;
		const context = (api: string): ProviderContext => ({
			model: { api },
			hasUI: true,
			ui: {
				getToolsExpanded(): boolean {
					expandedReads += 1;
					return false;
				},
			},
			sessionManager: {},
		});
		const sessionStart = handlers.get("session_start") as
			| ((event: unknown, context: ProviderContext) => void)
			| undefined;
		const messageStart = handlers.get("message_start") as
			| ((event: unknown, context: ProviderContext) => void)
			| undefined;
		const sessionSwitch = handlers.get("session_switch") as
			| ((event: unknown, context: ProviderContext) => void)
			| undefined;
		const sessionBranch = handlers.get("session_branch") as
			| ((event: unknown, context: ProviderContext) => void)
			| undefined;
		const sessionTree = handlers.get("session_tree") as
			| ((event: unknown, context: ProviderContext) => void)
			| undefined;
		const shutdown = handlers.get("session_shutdown") as
			| ((event: unknown, context: ProviderContext) => void)
			| undefined;
		if (
			sessionStart === undefined ||
			messageStart === undefined ||
			sessionSwitch === undefined ||
			sessionBranch === undefined ||
			sessionTree === undefined ||
			shutdown === undefined
		) {
			throw new Error("Expected commentary-collapse lifecycle handlers");
		}
		sessionStart({}, context("openai-codex-responses"));
		sessionSwitch({}, context("openai-codex-responses"));
		sessionBranch({}, context("openai-codex-responses"));
		sessionTree({}, context("openai-codex-responses"));
		messageStart({}, context("anthropic-messages"));
		messageStart({}, context("openai-codex-responses"));
		expect(expandedReads).toBe(6);
		shutdown({}, context("openai-codex-responses"));
	});
});

interface CrossProviderMessage extends PhaseMessage {
	readonly role: "assistant" | "user";
	readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

interface CrossProviderEvent {
	readonly type: string;
	readonly message?: CrossProviderMessage;
	readonly toolCallId?: string;
}

class CrossProviderContainer {
	readonly children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index >= 0) this.children.splice(index, 1);
	}
}

class CrossProviderAssistant implements Component {
	message: PhaseMessage = { content: [] };
	nativeExpansionCalls = 0;

	constructor(message?: PhaseMessage) {
		if (message !== undefined) this.updateContent(message);
	}

	updateContent(message: PhaseMessage): void {
		this.message = message;
	}

	setExpanded(_expanded: boolean): void {
		this.nativeExpansionCalls += 1;
	}

	getTranscriptBlockSettledRows(): number {
		return 0;
	}

	markTranscriptBlockFinalized(): void {}

	render(): string[] {
		const rows: string[] = [];
		for (const block of this.message.content ?? []) {
			if (typeof block !== "object" || block === null || !("type" in block)) continue;
			if (block.type === "text" && "text" in block && typeof block.text === "string") {
				rows.push(block.text);
			} else if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
				rows.push(block.thinking);
			}
		}
		return rows;
	}
}

class CrossProviderTool implements Component {
	constructor(readonly id: string) {}

	render(): string[] {
		return [`tool:${this.id}`];
	}
}

class CrossProviderUser implements Component {
	render(): string[] {
		return ["user"];
	}
}

class CrossProviderBuilder {
	readonly container = new CrossProviderContainer();
	expanded = false;

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	rebuild(entries: unknown): void {
		if (!Array.isArray(entries)) return;
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null || !("message" in entry)) continue;
			const message = entry.message;
			if (typeof message !== "object" || message === null || !("role" in message)) continue;
			if (message.role === "assistant") {
				this.container.addChild(new CrossProviderAssistant(message as CrossProviderMessage));
			} else if (message.role === "user") {
				this.container.addChild(new CrossProviderUser());
			}
		}
	}
	append(_entries: unknown): void {}
}

class CrossProviderEventController {
	readonly ctx: {
		readonly chatContainer: CrossProviderContainer;
		toolOutputExpanded: boolean;
		streamingComponent?: Component;
	} = {
		chatContainer: new CrossProviderContainer(),
		toolOutputExpanded: false,
	};

	async handleEvent(event: CrossProviderEvent): Promise<void> {
		if (event.type === "message_start" && event.message?.role === "assistant") {
			const component = new CrossProviderAssistant(event.message);
			this.ctx.streamingComponent = component;
			this.ctx.chatContainer.addChild(component);
			return;
		}
		if ((event.type === "message_update" || event.type === "message_end") && event.message !== undefined) {
			const component = this.ctx.streamingComponent;
			if (component instanceof CrossProviderAssistant) component.updateContent(event.message);
			return;
		}
		if (event.type === "tool_execution_start" && event.toolCallId !== undefined) {
			this.ctx.chatContainer.addChild(new CrossProviderTool(event.toolCallId));
		}
	}
}

class CrossProviderUiHelpers {
	addMessageToChat(_message: unknown, _options?: unknown): void {}
}

function renderCrossProviderRoots(container: CrossProviderContainer): string {
	return container.children.flatMap(child => child.render(100)).join("\n");
}

function setCrossProviderRootsExpanded(container: CrossProviderContainer, expanded: boolean): void {
	for (const child of container.children) {
		const setExpanded = Reflect.get(child, "setExpanded");
		if (typeof setExpanded === "function") Reflect.apply(setExpanded, child, [expanded]);
	}
}

describe("model-agnostic commentary collapse", () => {
	it("collapses an untagged tool turn, preserves its terminal answer, and composes native expansion", async () => {
		clearPatchManager();
		const api = {
			pi: {
				VERSION: "17.2.12",
				AssistantMessageComponent: CrossProviderAssistant,
				ChatTranscriptBuilder: CrossProviderBuilder,
				EventController: CrossProviderEventController,
				UserMessageComponent: CrossProviderUser,
				UiHelpers: CrossProviderUiHelpers,
			},
			logger: { warn(): void {} },
		} satisfies PresentationPatchApi;
		const patch = installPresentationPatch(api);
		if (!patch.compatible) throw new Error(patch.warning);
		patch.setEnabled(true);
		const controller = new CrossProviderEventController();
		const activity: CrossProviderMessage = {
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "Planning the tool call" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
			],
		};

		await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		await controller.handleEvent({ type: "message_end", message: activity });
		await controller.handleEvent({ type: "tool_execution_start", toolCallId: "tool-1" });
		await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		await controller.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Final answer" }],
			},
		});

		expect(controller.ctx.chatContainer.children[0]).toBeInstanceOf(TurnActivityGroup);
		expect(renderCrossProviderRoots(controller.ctx.chatContainer)).toBe("› 1 tool call, 0 messages\nFinal answer");

		setCrossProviderRootsExpanded(controller.ctx.chatContainer, true);
		expect(renderCrossProviderRoots(controller.ctx.chatContainer)).toBe(
			"Planning the tool call\ntool:tool-1\nFinal answer",
		);
		const assistants = controller.ctx.chatContainer.children.filter(
			(child): child is CrossProviderAssistant => child instanceof CrossProviderAssistant,
		);
		expect(assistants.map(assistant => assistant.nativeExpansionCalls)).toEqual([1, 1]);

		setCrossProviderRootsExpanded(controller.ctx.chatContainer, false);
		expect(renderCrossProviderRoots(controller.ctx.chatContainer)).toBe("› 1 tool call, 0 messages\nFinal answer");
		patch.dispose();
		clearPatchManager();
	});

	it("replaces the collapsed thinking descriptor and restores every descriptor when expanded", async () => {
		clearPatchManager();
		const api = {
			pi: {
				VERSION: "17.2.12",
				AssistantMessageComponent: CrossProviderAssistant,
				ChatTranscriptBuilder: CrossProviderBuilder,
				EventController: CrossProviderEventController,
				UserMessageComponent: CrossProviderUser,
				UiHelpers: CrossProviderUiHelpers,
			},
			logger: { warn(): void {} },
		} satisfies PresentationPatchApi;
		const patch = installPresentationPatch(api);
		if (!patch.compatible) throw new Error(patch.warning);
		patch.setEnabled(true);
		const controller = new CrossProviderEventController();
		const first: CrossProviderMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "**Clarifying CDP browser requirements**\n\n<!-- -->" }],
		};
		const second: CrossProviderMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "**Detailing browser connection options**\n\n<!-- -->" }],
		};

		await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		await controller.handleEvent({ type: "message_update", message: first });
		expect(renderCrossProviderRoots(controller.ctx.chatContainer)).toBe(
			"Clarifying CDP browser requirements  › 0 tool calls, 0 messages",
		);

		await controller.handleEvent({ type: "tool_execution_start", toolCallId: "tool-1" });
		await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		await controller.handleEvent({ type: "message_update", message: second });
		expect(renderCrossProviderRoots(controller.ctx.chatContainer)).toBe(
			"Detailing browser connection options  › 1 tool call, 0 messages",
		);

		setCrossProviderRootsExpanded(controller.ctx.chatContainer, true);
		expect(renderCrossProviderRoots(controller.ctx.chatContainer)).toBe(
			[
				"**Clarifying CDP browser requirements**",
				"",
				"<!-- -->",
				"tool:tool-1",
				"**Detailing browser connection options**",
				"",
				"<!-- -->",
			].join("\n"),
		);
		patch.dispose();
		clearPatchManager();
	});

	it("keeps one aggregate across agent-end pauses and provisional answers until the next user message", async () => {
		clearPatchManager();
		const api = {
			pi: {
				VERSION: "17.2.12",
				AssistantMessageComponent: CrossProviderAssistant,
				ChatTranscriptBuilder: CrossProviderBuilder,
				EventController: CrossProviderEventController,
				UserMessageComponent: CrossProviderUser,
				UiHelpers: CrossProviderUiHelpers,
			},
			logger: { warn(): void {} },
		} satisfies PresentationPatchApi;
		const patch = installPresentationPatch(api);
		if (!patch.compatible) throw new Error(patch.warning);
		patch.setEnabled(true);
		const controller = new CrossProviderEventController();
		const activity = (index: number): CrossProviderMessage => ({
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{
					type: "text",
					text: `Planning tool call ${index}`,
					textSignature: JSON.stringify({ v: 1, id: `commentary-${index}`, phase: "commentary" }),
				},
				{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: {} },
			],
		});

		for (const index of [1, 2]) {
			await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
			await controller.handleEvent({ type: "message_end", message: activity(index) });
			await controller.handleEvent({ type: "tool_execution_start", toolCallId: `tool-${index}` });
			await controller.handleEvent({ type: "agent_end" });
			if (index === 1) {
				await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
				await controller.handleEvent({
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "Planning the next tool call" }],
					},
				});
				await controller.handleEvent({ type: "agent_end" });
			}
		}
		await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		await controller.handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "Final answer" }],
			},
		});
		await controller.handleEvent({ type: "agent_end" });

		const groups = controller.ctx.chatContainer.children.filter(
			(child): child is TurnActivityGroup => child instanceof TurnActivityGroup,
		);
		expect(groups).toHaveLength(1);
		expect(renderCrossProviderRoots(controller.ctx.chatContainer)).toBe("› 2 tool calls, 3 messages\nFinal answer");

		await controller.handleEvent({ type: "message_start", message: { role: "user", content: [] } });
		await controller.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
		await controller.handleEvent({ type: "message_end", message: activity(3) });
		await controller.handleEvent({ type: "tool_execution_start", toolCallId: "tool-3" });

		const nextGroups = controller.ctx.chatContainer.children.filter(
			(child): child is TurnActivityGroup => child instanceof TurnActivityGroup,
		);
		expect(nextGroups).toHaveLength(2);
		expect(nextGroups.map(group => group.getCounts())).toEqual([
			{ toolCalls: 2, messages: 3 },
			{ toolCalls: 1, messages: 1 },
		]);
		patch.dispose();
		clearPatchManager();
	});

	it("rebuilds a saved user turn as one aggregate with only its last answer visible", () => {
		clearPatchManager();
		const api = {
			pi: {
				VERSION: "17.2.12",
				AssistantMessageComponent: CrossProviderAssistant,
				ChatTranscriptBuilder: CrossProviderBuilder,
				EventController: CrossProviderEventController,
				UserMessageComponent: CrossProviderUser,
				UiHelpers: CrossProviderUiHelpers,
			},
			logger: { warn(): void {} },
		} satisfies PresentationPatchApi;
		const patch = installPresentationPatch(api);
		if (!patch.compatible) throw new Error(patch.warning);
		patch.setEnabled(true);
		const builder = new CrossProviderBuilder();
		const activity = (index: number): CrossProviderMessage => ({
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{
					type: "text",
					text: `Commentary ${index}`,
					textSignature: JSON.stringify({ v: 1, id: `saved-commentary-${index}`, phase: "commentary" }),
				},
				{ type: "toolCall", id: `saved-tool-${index}`, name: "read", arguments: {} },
			],
		});
		builder.rebuild([
			{ message: { role: "user", content: [] } },
			{ message: activity(1) },
			{
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Planning the next saved tool call" }],
				},
			},
			{ message: activity(2) },
			{
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Saved final answer" }],
				},
			},
		]);

		expect(renderCrossProviderRoots(builder.container)).toBe("user\n› 2 tool calls, 3 messages\nSaved final answer");
		patch.dispose();
		clearPatchManager();
	});
});
