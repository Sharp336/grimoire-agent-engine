import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const THINKING = "SECRET_REASONING_TRACE";
const ANSWER = "FINAL_ANSWER";

function makeMessage(stopReason: "stop" | "error" | "toolUse" = "stop"): AssistantMessage {
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
	return component.render(100).map(line => Bun.stripANSI(line)).join("\n");
}

describe("hideThinkingBlockOnComplete", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
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
		component.setHideThinkingOnFinalize(true);
		component.updateContent(makeMessage("stop"));
		const text = renderText(component);
		expect(text).toContain(THINKING);
		expect(text).toContain(ANSWER);
	});

	it("hides thinking once finalized on a normal stop, keeping the answer", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingOnFinalize(true);
		component.updateContent(makeMessage("stop"));
		component.markTranscriptBlockFinalized();
		const text = renderText(component);
		expect(text).not.toContain(THINKING);
		expect(text).toContain(ANSWER);
	});

	it("hides thinking once finalized on a tool-use turn", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingOnFinalize(true);
		component.updateContent(makeMessage("toolUse"));
		component.markTranscriptBlockFinalized();
		expect(renderText(component)).not.toContain(THINKING);
	});

	it("keeps thinking when the turn ended in error (diagnosis)", () => {
		const component = new AssistantMessageComponent(undefined, false);
		component.setHideThinkingOnFinalize(true);
		component.updateContent(makeMessage("error"));
		component.markTranscriptBlockFinalized();
		expect(renderText(component)).toContain(THINKING);
	});

	it("hides thinking for messages finalized at construction (transcript rebuild)", () => {
		const component = new AssistantMessageComponent(
			makeMessage("stop"),
			false,
			undefined,
			[],
			undefined,
			true,
			true,
		);
		const text = renderText(component);
		expect(text).not.toContain(THINKING);
		expect(text).toContain(ANSWER);
	});

	it("constructor flag and live setter wire identically", () => {
		const viaSetter = new AssistantMessageComponent(undefined, false);
		viaSetter.setHideThinkingOnFinalize(true);
		viaSetter.updateContent(makeMessage("stop"));
		viaSetter.markTranscriptBlockFinalized();

		const viaConstructor = new AssistantMessageComponent(
			undefined,
			false,
			undefined,
			[],
			undefined,
			true,
			true,
		);
		viaConstructor.updateContent(makeMessage("stop"));
		viaConstructor.markTranscriptBlockFinalized();

		expect(renderText(viaSetter)).toBe(renderText(viaConstructor));
	});
});
