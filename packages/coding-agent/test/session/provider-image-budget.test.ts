import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const context: Context = {
			systemPrompt: ["system"],
			tools: [],
			messages: Array.from({ length: 31 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 21}`));
		expect(textData(clamped)).toEqual(Array.from({ length: 31 }, (_, index) => `text-${index}`));
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "inspect_image",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});

	it("compensates for undroppable assistant images by dropping extra droppable ones", () => {
		// 1 assistant image (oldest) + 11 user images = 12 total, cap 10.
		// The assistant image cannot be rewritten, so 2 droppable user images
		// must be dropped to land the retained total exactly at the cap.
		const assistantUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [image("assistant-image")],
					timestamp: 0,
					stopReason: "stop",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: assistantUsage,
				},
				...Array.from({ length: 11 }, (_, index) => ({
					role: "user" as const,
					content: [image(`image-${index}`)],
					timestamp: index + 1,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		// Assistant image retained untouched; the 2 oldest user images dropped.
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(imageData(clamped)).toEqual([
			"assistant-image",
			...Array.from({ length: 9 }, (_, index) => `image-${index + 2}`),
		]);
	});
});

const ANTHROPIC_MODEL = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "claude-sonnet-4-20250514",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 16384,
});

const COMPUTER_MODEL = buildModel({
	id: "gpt-5.4",
	name: "gpt-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com",
	reasoning: true,
	input: ["text", "image"],
	supportsComputerUse: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 16384,
});

/** Create an ImageContent whose decoded byte size (Math.floor(data.length * 3 / 4)) equals `decodedBytes`. */
function imageOfDecodedBytes(decodedBytes: number): ImageContent {
	const len = Math.ceil((decodedBytes * 4) / 3);
	return { type: "image", data: "A".repeat(len), mimeType: "image/png" };
}

/** Create a `data:<mime>;base64,<payload>` URL whose decoded byte size (accounting for padding) equals `decodedBytes`. */
function dataUrlOfDecodedBytes(decodedBytes: number): string {
	const len = Math.ceil((decodedBytes * 4) / 3);
	return `data:image/png;base64,${"A".repeat(len)}`;
}

const MIB = 1024 * 1024;

describe("transport image byte budget", () => {
	it("retains the newest image even when it alone exceeds the 24 MiB budget", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [imageOfDecodedBytes(25 * MIB)], timestamp: 1 }],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});

	it("elides oldest images first when aggregate exceeds budget", () => {
		// 3 images × 10 MiB = 30 MiB > 24 MiB budget. Oldest should be elided.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("msg-0"), imageOfDecodedBytes(10 * MIB)], timestamp: 0 },
				{ role: "user", content: [text("msg-1"), imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
				{ role: "user", content: [text("msg-2"), imageOfDecodedBytes(10 * MIB)], timestamp: 2 },
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);

		// Oldest image elided, replaced with placeholder.
		const first = result.messages[0];
		expect(first?.role).toBe("user");
		if (first?.role === "user") {
			expect(first.content).toEqual([
				text("msg-0"),
				{ type: "text", text: "[image omitted: transport image budget]" },
			]);
		}
		// Newer images retained.
		expect(imageData(result).length).toBe(2);
		// Text preserved.
		expect(textData(result)).toContain("msg-0");
		expect(textData(result)).toContain("msg-1");
		expect(textData(result)).toContain("msg-2");
	});

	it("excludes assistant image bytes from the transport byte budget", () => {
		// user 5 MiB (oldest) + assistant 20 MiB + user 10 MiB (newest).
		// Assistant image blocks are never re-serialized by the provider, so their
		// bytes must not count: only the 15 MiB of real user images is budgeted,
		// which fits under 24 MiB and elides nothing. (Counting the assistant
		// bytes would total 35 MiB and wrongly elide the oldest user image.)
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 0 },
				{
					role: "assistant",
					content: [imageOfDecodedBytes(20 * MIB)],
					timestamp: 1,
					stopReason: "stop",
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
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 2 },
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		// Nothing elided: assistant bytes are excluded, so the user images fit.
		expect(result).toBe(context);
		expect(imageData(result).length).toBe(3);
	});

	it("composes count cap and byte cap", () => {
		// UMANS_MODEL has count cap 10. 12 images × 4 MiB = 48 MiB.
		// Count clamp drops 2 oldest → 10 remain (40 MiB).
		// Byte budget: newest to oldest accumulates 4,8,12,16,20,24,28>24 → elides 4 more.
		// Final: 6 images remain.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 12 }, (_, i) => ({
				role: "user" as const,
				content: [text(`t-${i}`), imageOfDecodedBytes(4 * MIB)],
				timestamp: i,
			})),
		};

		const result = clampProviderContextImages(context, UMANS_MODEL);
		expect(imageData(result).length).toBe(6);
		// All text preserved.
		expect(textData(result).filter(t => t.startsWith("t-")).length).toBe(12);
	});

	it("collapses consecutive placeholders within one content array", () => {
		// 3 × 12 MiB in one message + 1 MiB newest elsewhere. Total = 37 MiB > 24 MiB.
		// Newest (1 MiB) retained; walking older: acc=1, +12=13, +12=25>24 → elided, +12=37>24 → elided.
		// Two consecutive images in the same message elided → collapse to one placeholder.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [
						text("before"),
						imageOfDecodedBytes(12 * MIB),
						imageOfDecodedBytes(12 * MIB),
						imageOfDecodedBytes(12 * MIB),
						text("after"),
					],
					timestamp: 0,
				},
				{ role: "user", content: [imageOfDecodedBytes(1 * MIB)], timestamp: 1 },
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const first = result.messages[0];
		expect(first?.role).toBe("user");
		if (first?.role === "user") {
			const parts = first.content as (TextContent | ImageContent)[];
			const placeholders = parts.filter(
				p => p.type === "text" && p.text === "[image omitted: transport image budget]",
			);
			expect(placeholders.length).toBe(1);
			const images = parts.filter(p => p.type === "image");
			expect(images.length).toBe(1);
		}
	});

	it("leaves non-image content byte-identical", () => {
		const context: Context = {
			systemPrompt: ["system prompt"],
			tools: [],
			messages: [
				{ role: "user", content: [text("hello"), text("world")], timestamp: 0 },
				{
					role: "assistant",
					content: [text("response")],
					timestamp: 1,
					stopReason: "stop",
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
				},
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});

	it("returns the same object graph when under budget", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 0 },
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 1 },
			],
		};
		// 10 MiB total < 24 MiB budget.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});

	it("replaces elided tool-result images with the transport placeholder", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "inspect_image",
					content: [imageOfDecodedBytes(20 * MIB)],
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
			],
		};
		// Total: 30 MiB > 24 MiB. Newest = 10 MiB (retained). Oldest = 20 MiB: acc = 10 + 20 = 30 > 24 → elided.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const first = result.messages[0];
		expect(first?.role).toBe("toolResult");
		if (first?.role === "toolResult") {
			expect(first.content).toEqual([{ type: "text", text: "[image omitted: transport image budget]" }]);
		}
		expect(imageData(result).length).toBe(1);
	});
	it("elides native computer screenshots under the byte budget", () => {
		// A computer tool result duplicates its screenshot in providerMetadata
		// (uploaded as computer_call_output) and in content (dropped by the
		// serializer). On a computer-capable model only the screenshot counts.
		const big = dataUrlOfDecodedBytes(20 * MIB);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "computer",
					content: [imageOfDecodedBytes(20 * MIB)],
					isError: false,
					timestamp: 0,
					providerMetadata: {
						type: "computer",
						screenshot: { type: "computer_screenshot", image_url: big },
						acknowledgedSafetyChecks: [],
					},
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
			],
		};
		// One 20 MiB screenshot (not double-counted with the content copy) + 10 MiB
		// user image = 30 MiB > 24 MiB → screenshot elided, content copy untouched.

		const result = clampProviderContextImages(context, COMPUTER_MODEL);
		const first = result.messages[0];
		expect(first?.role).toBe("toolResult");
		if (first?.role === "toolResult" && first.providerMetadata?.type === "computer") {
			const screenshot = first.providerMetadata.screenshot;
			expect(typeof screenshot.image_url === "string" && screenshot.image_url).not.toBe(big);
			// Collapsed to a tiny placeholder, shedding the original payload bytes.
			if (typeof screenshot.image_url === "string") {
				expect(screenshot.image_url.length).toBeLessThan(big.length);
			}
		}
		// The duplicated content copy is not budgeted on a computer-capable model,
		// so it is left byte-identical (not elided) even though the screenshot was.
		const toolResultMsg = result.messages[0];
		if (toolResultMsg?.role === "toolResult") {
			expect(toolResultMsg.content).toEqual([imageOfDecodedBytes(20 * MIB)]);
		}
	});

	it("accounts for base64 padding in the decoded-byte budget", () => {
		// Two images whose decoded sizes (padding-aware) sit just under the budget,
		// but whose base64 carries `==` padding so the old floor(len*3/4) math
		// over-counted them past it. Both must be retained.
		const oldest = image(`${"A".repeat(33554430)}==`); // 25165822 decoded bytes (2 padding)
		const newest = image("AA=="); // 1 decoded byte (2 padding)
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [oldest], timestamp: 0 },
				{ role: "user", content: [newest], timestamp: 1 },
			],
		};
		// Decoded total 25165823 ≤ 25165824 (24 MiB) once padding is subtracted;
		// the encoded-length estimate (25165827) would have elided the oldest.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});

	it("counts and elides native replay payload images", () => {
		// A user turn can store its image only in providerPayload.items (as a
		// data-URL input_image) while content stays plain text; the Responses
		// serializer uploads the payload items unchanged, bypassing content.
		const big = dataUrlOfDecodedBytes(20 * MIB);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: "describe this",
					timestamp: 0,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "anthropic",
						items: [{ type: "input_image", detail: "auto", image_url: big }],
					},
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
			],
		};
		// 20 MiB replay image + 10 MiB content image = 30 MiB > 24 MiB.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const first = result.messages[0];
		expect(first?.role).toBe("user");
		if (first?.role === "user" && first.providerPayload) {
			const item = first.providerPayload.items[0] as { image_url?: string; type?: string; detail?: string };
			expect(item.image_url).not.toBe(big);
			expect(item.image_url?.length).toBeLessThan(big.length);
			// Non-image fields preserved.
			expect(item).toMatchObject({ type: "input_image", detail: "auto" });
		}
		expect(imageData(result).length).toBe(1);
	});

	it("retains smaller older images once a larger one is elided", () => {
		// oldest → newest: 3 MiB, 3 MiB, 20 MiB, 5 MiB. Adding the 20 MiB image to
		// the 5 MiB newest would cross the budget, so it is elided; its bytes are
		// then skipped and the two 3 MiB images fit. The pre-fix accumulator kept
		// elided bytes, cascading elision past them (only the newest survived).
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [imageOfDecodedBytes(3 * MIB)], timestamp: 0 },
				{ role: "user", content: [imageOfDecodedBytes(3 * MIB)], timestamp: 1 },
				{ role: "user", content: [imageOfDecodedBytes(20 * MIB)], timestamp: 2 },
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 3 },
			],
		};

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		// Newest (5 MiB) + both 3 MiB images retained (11 MiB); only 20 MiB elided.
		expect(imageData(result).length).toBe(3);
		const elided = result.messages[2];
		if (elided?.role === "user") {
			expect(elided.content).toEqual([{ type: "text", text: "[image omitted: transport image budget]" }]);
		}
	});
	it("does not double-budget a single under-budget computer screenshot", () => {
		// The same 13 MiB screenshot lives in both content and providerMetadata.
		// Pre-fix it was counted twice (26 MiB > 24 MiB) and one copy was wrongly
		// elided; only the representation the serializer uploads is counted, so a
		// single 13 MiB screenshot + 5 MiB user image (18 MiB) fits untouched.
		const big = dataUrlOfDecodedBytes(13 * MIB);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "computer",
					content: [imageOfDecodedBytes(13 * MIB)],
					isError: false,
					timestamp: 0,
					providerMetadata: {
						type: "computer",
						screenshot: { type: "computer_screenshot", image_url: big },
						acknowledgedSafetyChecks: [],
					},
				},
				{ role: "user", content: [imageOfDecodedBytes(5 * MIB)], timestamp: 1 },
			],
		};

		const result = clampProviderContextImages(context, COMPUTER_MODEL);
		expect(result).toBe(context);
		if (result.messages[0]?.role === "toolResult" && result.messages[0].providerMetadata?.type === "computer") {
			expect(result.messages[0].providerMetadata.screenshot.image_url).toBe(big);
		}
	});

	it("applies every nested replay-image elision within one item", () => {
		// One replay `message` item carries two nested input_image data URLs.
		// Both are over budget relative to a newer image, so both must be elided —
		// pre-fix only the first matching elision was rewritten.
		const bigA = dataUrlOfDecodedBytes(20 * MIB);
		const bigB = dataUrlOfDecodedBytes(20 * MIB);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: "describe these",
					timestamp: 0,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "anthropic",
						items: [
							{
								type: "message",
								role: "user",
								content: [
									{ type: "input_image", detail: "auto", image_url: bigA },
									{ type: "input_text", text: "and" },
									{ type: "input_image", detail: "auto", image_url: bigB },
								],
							},
						],
					},
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
			],
		};
		// Two 20 MiB replay images + 10 MiB content image. Newest (10 MiB)
		// retained; each 20 MiB image crosses 24 MiB on its own → both elided.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const first = result.messages[0];
		if (first?.role === "user" && first.providerPayload) {
			const item = first.providerPayload.items[0] as {
				content?: Array<{ type: string; image_url?: string; text?: string }>;
			};
			const nested = item.content ?? [];
			const images = nested.filter(p => p.type === "input_image");
			expect(images.length).toBe(2);
			for (const part of images) {
				expect(part.image_url).not.toBe(bigA);
				expect(part.image_url).not.toBe(bigB);
				expect(part.image_url?.length).toBeLessThan(bigA.length);
			}
			// The non-image part between them is preserved.
			expect(nested.some(p => p.type === "input_text" && p.text === "and")).toBe(true);
		}
	});

	it("removes count-dropped replay images instead of shrinking them", () => {
		// UMANS cap is 10. 12 top-level replay input_image items exceed it; the 2
		// oldest must be removed (not shrunk to a placeholder that still counts).
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 12 }, (_, i) => ({
				role: "user" as const,
				content: `msg-${i}`,
				timestamp: i,
				providerPayload: {
					type: "openaiResponsesHistory" as const,
					provider: "umans",
					items: [{ type: "input_image", detail: "auto", image_url: dataUrlOfDecodedBytes(1 * MIB) }],
				},
			})),
		};

		const result = clampProviderContextImages(context, UMANS_MODEL);
		// The 2 oldest items are dropped entirely; 10 remain.
		const first = result.messages[0];
		if (first?.role === "user" && first.providerPayload) {
			expect(first.providerPayload.items.length).toBe(0);
		}
		const survivor = result.messages[2];
		if (survivor?.role === "user" && survivor.providerPayload) {
			expect(survivor.providerPayload.items.length).toBe(1);
		}
	});

	it("budgets images carried in a same-model assistant snapshot payload", () => {
		// The Responses serializer replays same-model assistant providerPayload
		// items verbatim; an input_image data URL in that snapshot must be counted
		// and elided, not bypass the budget.
		const big = dataUrlOfDecodedBytes(20 * MIB);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [],
					timestamp: 0,
					stopReason: "stop",
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai",
						items: [{ type: "input_image", detail: "auto", image_url: big }],
					},
				},
				{ role: "user", content: [imageOfDecodedBytes(10 * MIB)], timestamp: 1 },
			],
		};
		// 20 MiB assistant-snapshot image + 10 MiB user image = 30 MiB > 24 MiB.

		const result = clampProviderContextImages(context, COMPUTER_MODEL);
		const assistant = result.messages[0];
		if (assistant?.role === "assistant" && assistant.providerPayload) {
			const item = assistant.providerPayload.items[0] as { image_url?: string };
			expect(item.image_url).not.toBe(big);
			expect(item.image_url?.length).toBeLessThan(big.length);
		}
		expect(imageData(result).length).toBe(1);
	});

	it("does not let a zero-byte assistant image steal the newest-retention slot", () => {
		// A 25 MiB user image is the only uploaded image; an assistant display
		// image follows it. Provider serializers never upload the assistant image,
		// so it must not claim the unconditional newest-retention slot and force
		// the real 25 MiB image to be elided.
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [imageOfDecodedBytes(25 * MIB)], timestamp: 0 },
				{
					role: "assistant",
					content: [imageOfDecodedBytes(1 * MIB)],
					timestamp: 1,
					stopReason: "stop",
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
				},
			],
		};
		// Pre-fix the assistant image set seenNewest, so the 25 MiB user image was
		// elided even though it is the sole uploaded image and fits the budget.

		const result = clampProviderContextImages(context, ANTHROPIC_MODEL);
		expect(result).toBe(context);
	});
});
