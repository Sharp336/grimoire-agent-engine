import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const THINKING = "SECRET_REASONING_TRACE";
const ANSWER = "FINAL_ANSWER";
const RENDER_WIDTH = 120;

function makeMessage(stopReason: "stop" | "error" | "aborted" | "length" | "toolUse" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THINKING },
			{ type: "text", text: ANSWER },
		],
		stopReason,
		usage: { input: 10, output: 20, reasoning: 5 },
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function renderText(component: AssistantMessageComponent): string {
	return component
		.render(RENDER_WIDTH)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

describe("hideThinkingBlockOnComplete", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps thinking visible after finalize when the flag is off (status quo)", () => {
		const component = new AssistantMessageComponent(makeMessage("stop"), false);
		component.markTranscriptBlockFinalized();
		const text = renderText(component);
		expect(text).toContain(THINKING);
		expect(text).toContain(ANSWER);
	});

	it("keeps thinking visible while the block is still streaming", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingBlockOnComplete(true);
		component.updateContent(makeMessage("stop"));
		const text = renderText(component);
		expect(text).toContain(THINKING);
		expect(text).toContain(ANSWER);
	});

	it("hides thinking once finalized on a normal stop, keeping the answer", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingBlockOnComplete(true);
		component.updateContent(makeMessage("stop"));
		component.markTranscriptBlockFinalized();
		const text = renderText(component);
		expect(text).not.toContain(THINKING);
		expect(text).toContain(ANSWER);
	});

	it("hides thinking once finalized on a tool-use turn", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingBlockOnComplete(true);
		component.updateContent(makeMessage("toolUse"));
		component.markTranscriptBlockFinalized();
		expect(renderText(component)).not.toContain(THINKING);
	});

	it("early tool-call seal is not completion: thinking stays until message_end", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingBlockOnComplete(true);
		component.updateContent(makeMessage("toolUse"));
		// event-controller seals for scrollback as soon as a toolCall appears,
		// while tool arguments still stream — reasoning must stay visible.
		component.markTranscriptBlockFinalized(false);
		expect(renderText(component)).toContain(THINKING);
		component.markTranscriptBlockFinalized();
		expect(renderText(component)).not.toContain(THINKING);
	});

	it("keeps thinking when the turn ended abnormally, on every re-render", () => {
		for (const reason of ["error", "aborted", "length"] as const) {
			// Live path: update → finalize → post-finalize re-render (late tool
			// images, cache invalidation, error-pin refresh all re-run updateContent).
			const live = new AssistantMessageComponent(undefined, false);
			live.setHideThinkingBlockOnComplete(true);
			live.updateContent(makeMessage(reason));
			live.markTranscriptBlockFinalized();
			live.updateContent(makeMessage(reason));
			expect(renderText(live)).toContain(THINKING);

			// Rebuild path: transcripts resumed/compacted reconstruct the message
			// as already-finalized at construction time.
			const rebuilt = new AssistantMessageComponent(
				makeMessage(reason),
				false,
				undefined,
				[],
				undefined,
				true,
				true,
			);
			expect(renderText(rebuilt)).toContain(THINKING);
		}
	});

	it("hides thinking for messages finalized at construction (transcript rebuild)", () => {
		const component = new AssistantMessageComponent(makeMessage("stop"), false, undefined, [], undefined, true, true);
		const text = renderText(component);
		expect(text).not.toContain(THINKING);
		expect(text).toContain(ANSWER);
	});

	it("reveal setter re-renders reconstructed completed messages", () => {
		// Builder/factory reconstruct completed messages with the constructor,
		// then apply the reveal afterwards — the setter must rebuild on its own.
		const component = new AssistantMessageComponent(makeMessage("stop"), false, undefined, [], undefined, true, true);
		expect(renderText(component)).not.toContain(THINKING);
		component.setUserRevealedThinking(true);
		expect(renderText(component)).toContain(THINKING);
	});

	it("explicit reveal while streaming survives finalization", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingBlockOnComplete(true);
		component.updateContent(makeMessage("stop"));
		// User reveals mid-stream: reasoning stays visible through finalize.
		component.setUserRevealedThinking(true);
		component.markTranscriptBlockFinalized();
		expect(renderText(component)).toContain(THINKING);
		// And it is no longer retractable: nothing to pin or defer.
		expect(component.isNativeScrollbackLiveRegionPinned()).toBe(false);
	});

	it("explicit user reveal (Ctrl+T visible) beats hide-on-complete", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingBlockOnComplete(true);
		component.updateContent(makeMessage("stop"));
		component.markTranscriptBlockFinalized();
		// Completed turn with auto-hide on: hidden by default.
		expect(renderText(component)).not.toContain(THINKING);

		// Ctrl+T → visible: completed reasoning comes back (re-render like the
		// toggle's resetDisplay replay).
		component.setUserRevealedThinking(true);
		component.updateContent(makeMessage("stop"));
		expect(renderText(component)).toContain(THINKING);

		// Ctrl+T → hidden: the global toggle wins and the default is restored.
		component.setHideThinkingBlock(true);
		component.setUserRevealedThinking(false);
		component.updateContent(makeMessage("stop"));
		expect(renderText(component)).not.toContain(THINKING);
	});

	it("pins the live region while retractable thinking is visible", () => {
		// Flag on, still streaming with visible reasoning: pinned, so scrolled
		// rows never freeze into native scrollback before the hide rebuild.
		const live = new AssistantMessageComponent(undefined, false);
		live.setHideThinkingBlockOnComplete(true);
		live.updateContent(makeMessage("stop"));
		expect(live.isNativeScrollbackLiveRegionPinned()).toBe(true);

		// Once finalized, the block settles as-is (thinking already hidden):
		// no pin needed.
		live.markTranscriptBlockFinalized();
		expect(live.isNativeScrollbackLiveRegionPinned()).toBe(false);

		// Flag off: nothing is retracted, nothing to pin.
		const off = new AssistantMessageComponent(undefined, false);
		off.updateContent(makeMessage("stop"));
		expect(off.isNativeScrollbackLiveRegionPinned()).toBe(false);

		// Global hide wins: no visible thinking to retract, no pin.
		const globalHide = new AssistantMessageComponent(undefined, true);
		globalHide.setHideThinkingBlockOnComplete(true);
		globalHide.updateContent(makeMessage("stop"));
		expect(globalHide.isNativeScrollbackLiveRegionPinned()).toBe(false);

		// No thinking in the message: nothing to pin.
		const noThinking = new AssistantMessageComponent(undefined, false);
		noThinking.setHideThinkingBlockOnComplete(true);
		const message = makeMessage("stop");
		message.content = [{ type: "text", text: ANSWER }];
		noThinking.updateContent(message);
		expect(noThinking.isNativeScrollbackLiveRegionPinned()).toBe(false);
	});
});
