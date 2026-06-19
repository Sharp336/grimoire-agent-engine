import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { AudioContent, Context } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel<"google-generative-ai">("google", "gemini-2.0-flash");
if (!model) throw new Error("expected gemini-2.0-flash to be bundled");

/** A base64 string of the given length (ASCII 'A' repeated). */
function fakeBase64(length: number): string {
	return "A".repeat(length);
}

function ctxWithAudio(clips: AudioContent[]): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [
			{
				role: "user",
				content: clips,
				timestamp: Date.now(),
			},
		],
		tools: [],
	};
}

describe("convertMessages Gemini inline audio budget", () => {
	it("emits inlineData for a single clip under the per-block cap", () => {
		const clip: AudioContent = {
			type: "audio",
			data: fakeBase64(1024),
			mimeType: "audio/wav",
		};
		const contents = convertMessages(model, ctxWithAudio([clip]));
		const parts = contents[0]?.parts ?? [];
		const inline = parts.find(p => "inlineData" in p);
		expect(inline).toBeDefined();
	});

	it("omits a clip that individually exceeds the per-block cap", () => {
		const clip: AudioContent = {
			type: "audio",
			data: fakeBase64(11 * 1024 * 1024),
			mimeType: "audio/wav",
		};
		const contents = convertMessages(model, ctxWithAudio([clip]));
		const parts = contents[0]?.parts ?? [];
		const text = parts.find(p => "text" in p && typeof p.text === "string" && p.text.includes("exceeds"));
		expect(text).toBeDefined();
	});

	it("tracks the cumulative request budget across multiple clips", () => {
		// Each clip is under the 10 MiB per-block cap, but together they exceed the
		// 18 MiB cumulative request budget — the second must be omitted.
		const clipA: AudioContent = {
			type: "audio",
			data: fakeBase64(10 * 1024 * 1024),
			mimeType: "audio/wav",
		};
		const clipB: AudioContent = {
			type: "audio",
			data: fakeBase64(10 * 1024 * 1024),
			mimeType: "audio/wav",
		};
		const contents = convertMessages(model, ctxWithAudio([clipA, clipB]));
		const parts = contents[0]?.parts ?? [];
		const inlineParts = parts.filter(p => "inlineData" in p);
		const omittedText = parts.find(
			p => "text" in p && typeof p.text === "string" && p.text.includes("budget has been reached"),
		);
		// First clip emitted as inlineData, second omitted with a clear note.
		expect(inlineParts.length).toBe(1);
		expect(omittedText).toBeDefined();
	});
});
