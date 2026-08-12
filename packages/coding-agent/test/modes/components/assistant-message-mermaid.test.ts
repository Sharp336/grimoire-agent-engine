import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantThinkingRenderer } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { clearMermaidCache } from "@oh-my-pi/pi-coding-agent/modes/theme/mermaid-cache";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, Text } from "@oh-my-pi/pi-tui";

const originalImageProtocol = TERMINAL.imageProtocol;

function createAssistantMessage(markdown: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: markdown }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderAssistantMessage(markdown: string, renderers: readonly AssistantThinkingRenderer[] = []): string {
	const component = new AssistantMessageComponent(createAssistantMessage(markdown), false, undefined, renderers);
	return Bun.stripANSI(component.render(120).join("\n"))
		.split("\n")
		.map(line => line.trimEnd())
		.join("\n");
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	clearMermaidCache();
	setTerminalImageProtocol(null);
});

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	clearMermaidCache();
});

describe("AssistantMessageComponent mermaid markdown", () => {
	it("renders fenced Mermaid ASCII without terminal image protocol", () => {
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  Start-->Stop\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("Start");
		expect(rendered).toContain("Start--");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("flowchart TD");
	});

	it("aligns box borders for CJK labels in display columns", () => {
		// Defends the first-party vendored Mermaid ASCII renderer's CJK/East-Asian
		// display-width handling (packages/utils/src/vendor/mermaid-ascii): Hangul is 2
		// terminal columns wide, so every row of a single-node diagram must
		// measure the same display width or the right border drifts.
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  A[수집 스케줄러]\n```");
		const displayCols = (line: string): number => {
			let width = 0;
			for (const ch of line) {
				const code = ch.codePointAt(0) ?? 0;
				const wide =
					(code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
					(code >= 0x2e80 && code <= 0x9fff) || // CJK radicals/ideographs
					(code >= 0xff00 && code <= 0xff60); // fullwidth forms
				width += wide ? 2 : 1;
			}
			return width;
		};
		const boxRows = rendered.split("\n").filter(line => /[┌│└]/.test(line));
		expect(boxRows.length).toBeGreaterThanOrEqual(3);
		expect(new Set(boxRows.map(displayCols)).size).toBe(1);
	});

	it("falls back to the fenced code block when Mermaid rendering fails", () => {
		const rendered = renderAssistantMessage("```mermaid\nthis is not mermaid\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("```mermaid");
		expect(rendered).toContain("this is not mermaid");
	});
});

describe("AssistantMessageComponent settled-row commit boundary", () => {
	function renderStreamingMarkdown(markdown: string): AssistantMessageComponent {
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage(markdown), { transient: true });
		component.render(80);
		return component;
	}

	it("exposes frozen paragraph rows for streaming prose", () => {
		const component = renderStreamingMarkdown(
			"First paragraph is already byte-stable.\n\nSecond paragraph is still streaming tokens",
		);

		expect(component.getTranscriptBlockSettledRows()).toBeGreaterThan(0);
	});

	it("exposes zero settled rows for Mermaid while streaming", () => {
		for (const markdown of [
			"Here is the flow:\n\n```mermaid\nflowchart TD\n  A-->B",
			"```mermaid\nflowchart TD\n  A-->B\n```",
		]) {
			const component = renderStreamingMarkdown(markdown);

			expect(component.getTranscriptBlockSettledRows()).toBe(0);
		}
	});

	it("keeps a streaming table in the unsettled tail", () => {
		const component = renderStreamingMarkdown("Results:\n\n| Name | Score |\n| --- | --- |\n| a | 1 |");
		const renderedRows = component.render(80);
		const settledRows = component.getTranscriptBlockSettledRows();

		expect(settledRows).toBeGreaterThan(0);
		expect(settledRows).toBeLessThan(renderedRows.length);
		expect(Bun.stripANSI(renderedRows.slice(settledRows).join("\n"))).toContain("Name");
	});

	it("exposes zero settled rows after a reflowing block finalizes", () => {
		for (const markdown of [
			"```mermaid\nflowchart TD\n  A-->B\n```",
			"| Name | Score |\n| --- | --- |\n| a | 1 |\n| b | 2 |",
		]) {
			const component = renderStreamingMarkdown(markdown);
			component.markTranscriptBlockFinalized();

			expect(component.getTranscriptBlockSettledRows()).toBe(0);
		}
	});
});

describe("AssistantMessageComponent thinking renderers", () => {
	it("renders all extension outputs below visible thinking blocks in registration order", () => {
		const contexts: Array<{
			message: { timestamp: number; responseId?: string; api: string; provider: string; model: string };
			content: { itemId?: string; thinkingSignature?: string };
			contentIndex: number;
			thinkingIndex: number;
			text: string;
		}> = [];
		const message = {
			...createAssistantMessage(""),
			responseId: "resp-1",
			content: [
				{
					type: "thinking" as const,
					thinking: "I should inspect the input.",
					itemId: "item-1",
					thinkingSignature: "sig-1",
				},
			],
		};
		const component = new AssistantMessageComponent(message, false, undefined, [
			context => {
				contexts.push({
					message: context.message,
					content: context.content,
					contentIndex: context.contentIndex,
					thinkingIndex: context.thinkingIndex,
					text: context.text,
				});
				return new Text("first note", 1, 0);
			},
			() => new Text("second note", 1, 0),
		]);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("I should inspect the input.");
		expect(rendered.indexOf("I should inspect the input.")).toBeLessThan(rendered.indexOf("first note"));
		expect(rendered.indexOf("first note")).toBeLessThan(rendered.indexOf("second note"));
		expect(contexts).toEqual([
			{
				message: {
					timestamp: message.timestamp,
					responseId: "resp-1",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
				},
				content: {
					itemId: "item-1",
					thinkingSignature: "sig-1",
				},
				contentIndex: 0,
				thinkingIndex: 0,
				text: "I should inspect the input.",
			},
		]);
	});

	it("preserves legacy component returns that define structured result fields", () => {
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			undefined,
			[
				() =>
					Object.assign(new Text("legacy component with structured fields", 1, 0), {
						type: "replace",
						component: new Text("wrong structured replacement", 1, 0),
					}),
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("I should inspect the input.");
		expect(rendered).toContain("legacy component with structured fields");
		expect(rendered).not.toContain("wrong structured replacement");
	});

	it("lets extension renderers replace the default thinking block while preserving appenders", () => {
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "Sensitive chain of thought." }],
			},
			false,
			undefined,
			[
				() => ({ type: "append", component: new Text("early audit note", 1, 0) }),
				() => ({ type: "replace", component: new Text("redacted outline", 1, 0) }),
				() => new Text("legacy appended note", 1, 0),
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).not.toContain("Sensitive chain of thought.");
		expect(rendered).toContain("redacted outline");
		expect(rendered).toContain("early audit note");
		expect(rendered).toContain("legacy appended note");
		expect(rendered.indexOf("redacted outline")).toBeLessThan(rendered.indexOf("early audit note"));
		expect(rendered.indexOf("early audit note")).toBeLessThan(rendered.indexOf("legacy appended note"));
	});

	it("uses the first replacement renderer when multiple extensions try to replace thinking", () => {
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "Original thinking." }],
			},
			false,
			undefined,
			[
				() => ({ type: "replace", component: new Text("first replacement", 1, 0) }),
				() => ({ type: "replace", component: new Text("second replacement", 1, 0) }),
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).not.toContain("Original thinking.");
		expect(rendered).toContain("first replacement");
		expect(rendered).not.toContain("second replacement");
	});

	it("keeps original thinking visible when an extension renderer throws", () => {
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			undefined,
			[
				() => {
					throw new Error("renderer failed");
				},
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("I should inspect the input.");
		expect(rendered).not.toContain("renderer failed");
	});

	it("keeps async renderer components mounted when they request a render", async () => {
		let renderRequests = 0;
		let rendererCalls = 0;
		let mountedNote: Text | undefined;
		let requestRender: (() => void) | undefined;
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			() => {
				renderRequests += 1;
			},
			[
				context => {
					rendererCalls += 1;
					requestRender = context.requestRender;
					const note = new Text("translation loading", 1, 0);
					mountedNote ??= note;
					return note;
				},
			],
		);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("translation loading");
		mountedNote?.setText("translation ready");
		requestRender?.();
		await Promise.resolve();

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(renderRequests).toBe(1);
		expect(rendererCalls).toBe(1);
		expect(rendered).toContain("translation ready");
		expect(rendered).not.toContain("translation loading");
	});

	it("preserves mounted renderer components while later answer text streams", () => {
		let rendererCalls = 0;
		let mountedNote: Text | undefined;
		const componentMessage: AssistantMessage = {
			...createAssistantMessage(""),
			content: [{ type: "thinking", thinking: "Stable thinking." }],
		};
		const component = new AssistantMessageComponent(componentMessage, false, undefined, [
			() => {
				rendererCalls += 1;
				const note = new Text("translation loading", 1, 0);
				mountedNote ??= note;
				return note;
			},
		]);

		mountedNote?.setText("translation ready");
		const nextMessage = createAssistantMessage("Answer");
		component.updateContent({
			...nextMessage,
			timestamp: componentMessage.timestamp,
			content: [
				{ type: "thinking", thinking: "Stable thinking." },
				{ type: "text", text: "Answer" },
			],
		});

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendererCalls).toBe(1);
		expect(rendered).toContain("translation ready");
		expect(rendered).not.toContain("translation loading");
	});

	it("reruns renderers when provider metadata arrives without a text change", () => {
		const signatures: Array<string | undefined> = [];
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "Stable thinking." }],
			},
			false,
			undefined,
			[
				context => {
					signatures.push(context.content.thinkingSignature);
					return new Text(context.content.thinkingSignature ?? "pending signature", 1, 0);
				},
			],
		);

		component.updateContent({
			...createAssistantMessage(""),
			responseId: "response-final",
			content: [
				{
					type: "thinking",
					thinking: "Stable thinking.",
					itemId: "reasoning-item",
					thinkingSignature: "signature-final",
				},
			],
		});

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(signatures).toEqual([undefined, "signature-final"]);
		expect(rendered).toContain("signature-final");
		expect(rendered).not.toContain("pending signature");
	});

	it("mounts a replacement when an async renderer becomes ready after streaming stops", async () => {
		let ready = false;
		let renderRequests = 0;
		let rendererCalls = 0;
		let requestRender: (() => void) | undefined;
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "Sensitive async thinking." }],
			},
			false,
			() => {
				renderRequests += 1;
			},
			[
				context => {
					rendererCalls += 1;
					requestRender = context.requestRender;
					if (!ready) return undefined;
					return { type: "replace", component: new Text(`redacted ${context.text.length}`, 1, 0) };
				},
			],
		);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Sensitive async thinking.");
		expect(rendererCalls).toBe(1);

		ready = true;
		requestRender?.();
		await Promise.resolve();

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(renderRequests).toBe(1);
		expect(rendererCalls).toBe(2);
		expect(rendered).toContain("redacted 25");
		expect(rendered).not.toContain("Sensitive async thinking.");
	});

	it("does not invoke extension renderers when thinking is hidden", () => {
		let rendererCalled = false;
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			true,
			undefined,
			[
				() => {
					rendererCalled = true;
					return new Text("hidden note", 1, 0);
				},
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).not.toContain("I should inspect the input.");
		expect(rendered).not.toContain("hidden note");
		expect(rendererCalled).toBe(false);
	});
});

describe("AssistantMessageComponent images", () => {
	it("renders native assistant images in content order and honors image visibility", () => {
		const message: AssistantMessage = {
			...createAssistantMessage(""),
			content: [
				{ type: "text", text: "Before image" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				{ type: "text", text: "After image" },
			],
		};
		const component = new AssistantMessageComponent(message);

		const rendered = Bun.stripANSI(component.render(80).join("\n"));
		expect(rendered.indexOf("Before image")).toBeLessThan(rendered.indexOf("[Image: image/png]"));
		expect(rendered.indexOf("[Image: image/png]")).toBeLessThan(rendered.indexOf("After image"));
		component.setImagesVisible(false);
		expect(Bun.stripANSI(component.render(80).join("\n"))).not.toContain("[Image: image/png]");
	});

	it("converts WebP tool images for Kitty terminal rendering", async () => {
		const webpBase64 = Buffer.from(
			await Bun.file(path.join(import.meta.dir, "../../../../../assets/python.webp")).arrayBuffer(),
		).toBase64();
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const converted = Promise.withResolvers<void>();
		const component = new AssistantMessageComponent(createAssistantMessage("done"), false, () => converted.resolve());
		component.setToolResultImages("read-1", [{ type: "image", data: webpBase64, mimeType: "image/webp" }]);

		await converted.promise;
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("\x1b_G");
		expect(rendered).not.toContain("[Image: image/webp]");
	});
});
