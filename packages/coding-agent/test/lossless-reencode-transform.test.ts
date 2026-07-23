import { describe, expect, it } from "bun:test";
import { countTokens } from "@oh-my-pi/pi-agent-core";
import type { Context, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	decodeLosslessJsonTable,
	encodeLosslessJsonTable,
	LOSSLESS_REENCODE_SAVINGS_MARGIN,
	transformLosslessToolResults,
} from "@oh-my-pi/pi-coding-agent/session/lossless-reencode";
import { SnapcompactInlineTransformer } from "@oh-my-pi/pi-coding-agent/session/snapcompact-inline";

function structuredJson(rows = 180): string {
	return JSON.stringify(
		Array.from({ length: rows }, (_, id) => ({
			id,
			endpoint: "/api/v1/orders",
			status: id % 7 === 0 ? 201 : 200,
			region: `region_${id % 4}`,
			latency_ms: 40 + (id % 9),
			ok: true,
		})),
	);
}

function highEntropyJson(rows = 80, width = 300): string {
	return JSON.stringify(
		Array.from({ length: rows }, (_, id) => ({
			id,
			payload: Array.from({ length: width }, (_, i) => ((id * 131 + i * 17) % 36).toString(36)).join(""),
		})),
	);
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function userMessage(text = "go"): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function encodedText(message: Message): string {
	if (message.role !== "toolResult" || message.content[0]?.type !== "text")
		throw new Error("Expected text tool result");
	return message.content[0].text;
}

function toolResultContent(message: Message): ToolResultMessage["content"] {
	if (message.role !== "toolResult") throw new Error("Expected tool result");
	return message.content;
}

function encodedBody(marked: string): string {
	const newline = marked.indexOf("\n");
	if (newline < 0) throw new Error("Expected marker line");
	return marked.slice(newline + 1);
}

function makeVisionModel() {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

describe("lossless request-time transform", () => {
	it("re-encodes eligible historical tool results oldest-first and skips the newest result", () => {
		const first = toolResult("first", structuredJson());
		const second = toolResult("second", structuredJson());
		const newest = toolResult("newest", structuredJson());
		const context: Context = { messages: [userMessage(), first, second, newest] };

		const result = transformLosslessToolResults(context);

		expect(result).not.toBe(context);
		for (const [index, source] of [
			[1, first],
			[2, second],
		] as const) {
			const text = encodedText(result.messages[index]);
			expect(text).toMatch(/^\[lossless-reencode v1 schema\+csv; original=\d+B]\n/);
			expect(decodeLosslessJsonTable(encodedBody(text))).toEqual(JSON.parse(encodedText(source)));
		}
		expect(result.messages[3]).toBe(newest);
		expect(encodedText(newest)).toBe(structuredJson());
	});

	it("uses the exact 3k-token lower gate and 50 KiB UTF-8 upper gate", () => {
		const below = toolResult("below", '[{"id":1},{"id":2}]');
		const overText = highEntropyJson(250, 220);
		expect(Buffer.byteLength(overText, "utf8")).toBeGreaterThan(50 * 1024);
		const over = toolResult("over", overText);
		const tail = toolResult("tail", '[{"id":1},{"id":2}]');
		const context: Context = { messages: [userMessage(), below, over, tail] };

		const result = transformLosslessToolResults(context);

		expect(result).toBe(context);
		expect(result.messages[1]).toBe(below);
		expect(result.messages[2]).toBe(over);
	});

	it("requires the marked replacement to save at least 10% of estimated tokens", () => {
		const text = highEntropyJson();
		expect(countTokens(text)).toBeGreaterThanOrEqual(3000);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
		const candidate = toolResult("candidate", text);
		const context: Context = {
			messages: [userMessage(), candidate, toolResult("tail", '[{"id":1},{"id":2}]')],
		};

		const result = transformLosslessToolResults(context);

		expect(result).toBe(context);
		expect(result.messages[1]).toBe(candidate);
	});

	it("rejects a byte-saving replacement that misses the token margin at the estimator rounding boundary", () => {
		// In tests countTokens is ceil(UTF-8 bytes / 4), but the ceiling still
		// makes byte and token margins non-equivalent. Production can additionally
		// select the accurate native tokenizer via PI_TOKENIZER_ACCURATE=1.
		const text = JSON.stringify(
			Array.from({ length: 89 }, (_, id) => ({
				id,
				payload: "x".repeat(158),
			})),
		);
		const encoded = encodeLosslessJsonTable(text);
		if (!encoded) throw new Error("Expected eligible rounding fixture");
		const originalBytes = Buffer.byteLength(text, "utf8");
		const replacement = `[lossless-reencode v1 schema+csv; original=${originalBytes}B]\n${encoded}`;

		expect(Buffer.byteLength(replacement, "utf8")).toBeLessThanOrEqual(
			originalBytes * LOSSLESS_REENCODE_SAVINGS_MARGIN,
		);
		expect(countTokens(replacement)).toBeGreaterThan(countTokens(text) * LOSSLESS_REENCODE_SAVINGS_MARGIN);

		const candidate = toolResult("candidate", text);
		const context: Context = {
			messages: [userMessage(), candidate, toolResult("tail", '[{"id":1},{"id":2}]')],
		};
		expect(transformLosslessToolResults(context)).toBe(context);
	});

	it("marks the format and exact original UTF-8 size", () => {
		const original = structuredJson().replace("/api/v1/orders", "/api/v1/東京");
		const candidate = toolResult("candidate", original);
		const context: Context = {
			messages: [userMessage(), candidate, toolResult("tail", '[{"id":1},{"id":2}]')],
		};

		const result = transformLosslessToolResults(context);
		const marker = encodedText(result.messages[1]).split("\n", 1)[0];

		expect(marker).toBe(`[lossless-reencode v1 schema+csv; original=${Buffer.byteLength(original, "utf8")}B]`);
	});

	it("preserves non-text blocks and existing artifact references untouched", () => {
		const jsonBlock = { type: "text" as const, text: structuredJson() };
		const artifactBlock = { type: "text" as const, text: "Original available at artifact://fixture-123" };
		const imageBlock = { type: "image" as const, data: "aGk=", mimeType: "image/png" as const };
		const candidate: ToolResultMessage = {
			...toolResult("candidate", "unused"),
			content: [jsonBlock, artifactBlock, imageBlock],
		};
		const context: Context = {
			messages: [userMessage(), candidate, toolResult("tail", '[{"id":1},{"id":2}]')],
		};

		const result = transformLosslessToolResults(context);
		const transformed = result.messages[1];
		const transformedContent = toolResultContent(transformed);

		expect(transformed).not.toBe(candidate);
		expect(transformedContent[0]).not.toBe(jsonBlock);
		expect(transformedContent[1]).toBe(artifactBlock);
		expect(transformedContent[2]).toBe(imageBlock);
		const retainedArtifact = transformedContent[1];
		if (retainedArtifact.type !== "text") throw new Error("Expected artifact text block");
		expect(retainedArtifact.text).toContain("artifact://fixture-123");
	});

	it("does not mutate persisted context and returns the same object when every result passes through", () => {
		const small = toolResult("small", '[{"id":1},{"id":2}]');
		const context: Context = { systemPrompt: ["system"], messages: [userMessage(), small] };
		const messages = context.messages;
		const content = small.content;

		const result = transformLosslessToolResults(context);

		expect(result).toBe(context);
		expect(context.messages).toBe(messages);
		expect(small.content).toBe(content);
		expect(context.systemPrompt).toEqual(["system"]);
	});

	it("produces byte-identical output on every whole-context re-run", () => {
		const context: Context = {
			messages: [userMessage(), toolResult("candidate", structuredJson()), toolResult("tail", "tail")],
		};

		const turnOne = JSON.stringify(transformLosslessToolResults(context));
		const turnTwo = JSON.stringify(transformLosslessToolResults(context));

		expect(turnTwo).toBe(turnOne);
	});

	it("deterministically removes a compacted result from downstream snapcompact eligibility", async () => {
		const original = structuredJson();
		expect(countTokens(original)).toBeGreaterThanOrEqual(3000);
		const context: Context = {
			messages: [userMessage(), toolResult("candidate", original), toolResult("tail", "tail")],
		};
		const snapcompact = new SnapcompactInlineTransformer({
			renderSystemPrompt: "none",
			renderToolResults: true,
			shape: "6x12-dim",
		});

		const snapcompactOnly = await snapcompact.transform(context, makeVisionModel());
		expect(toolResultContent(snapcompactOnly.messages[1]).some(block => block.type === "image")).toBe(true);

		const reencoded = transformLosslessToolResults(context);
		const compactedText = encodedText(reencoded.messages[1]);
		expect(countTokens(compactedText)).toBeLessThan(3000);
		const combined = await snapcompact.transform(reencoded, makeVisionModel());

		expect(combined).toBe(reencoded);
		expect(toolResultContent(combined.messages[1])).toEqual([{ type: "text", text: compactedText }]);
		expect(JSON.stringify(await snapcompact.transform(reencoded, makeVisionModel()))).toBe(JSON.stringify(combined));
	});
});
