import { describe, expect, it } from "bun:test";
import {
	type InputItem,
	type RequestBody,
	transformRequestBody,
} from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ResponseInput, ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	adaptResponsesReplayItemsForModel,
	buildResponsesInput,
	processResponsesStream,
	repairOrphanResponsesToolCalls,
	repairOrphanResponsesToolOutputs,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	OpenAIComputerSafetyCheck,
	Tool,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel } from "./helpers";

const safetyChecks: OpenAIComputerSafetyCheck[] = [{ id: "safe-1", code: null, message: "Confirm navigation" }];

const computerTool: Tool = {
	name: "computer",
	description: "Control the computer",
	parameters: { type: "object", properties: {} },
	openaiNativeTool: "computer",
};

function createResponsesModel(
	id = "gpt-5.4",
	provider = "openai",
	baseUrl = "https://api.openai.com/v1",
	input: Array<"text" | "image"> = ["text", "image"],
): Model<"openai-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl,
		contextWindow: 128_000,
		maxTokens: 8_192,
		input,
		reasoning: false,
		compat: { supportsToolChoice: true, supportsForcedToolChoice: true },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function createOutput(api: "openai-responses" | "openai-codex-responses" = "openai-responses"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider: api === "openai-responses" ? "openai" : "openai-codex",
		model: "gpt-computer-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function* responseEvents(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) yield event as ResponseStreamEvent;
}

function computerAssistant(model: Model<"openai-responses">): AssistantMessage {
	return {
		...createOutput(),
		model: model.id,
		content: [
			{
				type: "toolCall",
				id: "call-computer|cu-computer",
				name: "computer",
				arguments: { actions: [{ type: "screenshot" }], pendingSafetyChecks: safetyChecks },
				openaiComputer: { pendingSafetyChecks: safetyChecks },
			},
		],
		stopReason: "toolUse",
	};
}

function computerResult(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-computer|cu-computer",
		toolName: "computer",
		content: [{ type: "image", mimeType: "image/png", data: "png-base64-original" }],
		openaiComputer: { acknowledgedSafetyChecks: safetyChecks },
		isError: false,
		timestamp: 2,
		...overrides,
	};
}

function buildComputerHistory(model: Model<"openai-responses">, result: ToolResultMessage): ResponseInput {
	return buildResponsesInput({
		model,
		context: { messages: [computerAssistant(model), result], tools: [computerTool] },
		strictResponsesPairing: true,
		supportsImageDetailOriginal: true,
		nativeHistory: { replay: false, filterReasoning: false },
		repairOrphanOutputs: true,
	});
}

function createCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
	).toBase64();
	return `header.${payload}.signature`;
}

function createSse(events: unknown[]): Response {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAI native computer request protocol", () => {
	it("emits native tools and forced choice for standard Responses and Codex", async () => {
		const model = createResponsesModel();
		const context: Context = {
			messages: [{ role: "user", content: "inspect", timestamp: 0 }],
			tools: [computerTool],
		};
		const standard = buildParams(
			model,
			context,
			{ toolChoice: { type: "function", name: "computer" } },
			undefined,
		).params;
		expect(standard.tools).toEqual([{ type: "computer" }]);
		expect(standard.tool_choice).toEqual({ type: "computer" });

		const codexModel = createCodexModel("gpt-5.4");
		const codex = await buildTransformedCodexRequestBody(codexModel, context, {
			toolChoice: { type: "function", name: "computer" },
		});
		expect(codex.tools).toEqual([{ type: "computer" }]);
		expect(codex.tool_choice).toEqual({ type: "computer" });
	});
});

describe("OpenAI computer function fallback", () => {
	it("uses ordinary function tools for older official Responses and Codex models", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "inspect", timestamp: 0 }],
			tools: [computerTool],
		};
		const standard = buildParams(
			createResponsesModel("gpt-5.3"),
			context,
			{ toolChoice: { type: "function", name: "computer" } },
			undefined,
		).params;
		expect(standard.tools).toEqual([
			{
				type: "function",
				name: "computer",
				description: "Control the computer",
				parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
				strict: true,
			},
		]);
		expect(standard.tool_choice).toEqual({ type: "function", name: "computer" });

		const codex = await buildTransformedCodexRequestBody(createCodexModel("gpt-5.3-codex"), context, {
			toolChoice: { type: "function", name: "computer" },
		});
		expect(JSON.parse(JSON.stringify(codex.tools))).toEqual([
			{
				type: "function",
				name: "computer",
				description: "Control the computer",
				parameters: { type: "object", properties: {} },
			},
		]);
		expect(codex.tool_choice).toEqual({ type: "function", name: "computer" });
	});

	it("uses an ordinary function tool on third-party Responses providers", () => {
		const model = createResponsesModel("gpt-5.4", "xai-oauth", "https://api.x.ai/v1", ["text"]);
		const params = buildParams(
			model,
			{ messages: [{ role: "user", content: "inspect", timestamp: 0 }], tools: [computerTool] },
			{ toolChoice: { type: "function", name: "computer" } },
			undefined,
		).params;
		const serializedTools: unknown = JSON.parse(JSON.stringify(params.tools));
		expect(serializedTools).toEqual([
			{
				type: "function",
				name: "computer",
				description: "Control the computer",
				parameters: { type: "object", properties: {} },
			},
		]);
		expect(params.tool_choice).toEqual({ type: "function", name: "computer" });
	});

	it("downgrades native history with file and missing screenshot references safely", () => {
		const model = createResponsesModel("gpt-5.3");
		const call: ResponseInput[number] = {
			type: "computer_call",
			id: "cu-file",
			call_id: "call-file",
			status: "completed",
			actions: [{ type: "screenshot" }],
			pending_safety_checks: safetyChecks,
		};
		const fileFallback = adaptResponsesReplayItemsForModel(
			[
				call,
				{
					type: "computer_call_output",
					call_id: "call-file",
					output: { type: "computer_screenshot", file_id: "file-screenshot" },
				},
			],
			model,
			[computerTool],
		);
		expect(fileFallback.map(item => item.type ?? ("role" in item ? item.role : undefined))).toEqual([
			"function_call",
			"function_call_output",
			"user",
		]);
		expect(fileFallback[0]).toEqual({
			type: "function_call",
			call_id: "call-file",
			name: "computer",
			arguments: JSON.stringify({ actions: [{ type: "screenshot" }], pendingSafetyChecks: safetyChecks }),
		});
		expect(fileFallback[1]).toEqual({
			type: "function_call_output",
			call_id: "call-file",
			output: "(see attached image)",
		});
		expect(fileFallback[2]).toEqual({
			role: "user",
			content: [
				{ type: "input_text", text: "Attached image(s) from tool result:" },
				{ type: "input_image", detail: "auto", file_id: "file-screenshot" },
			],
		});

		const missingScreenshot = adaptResponsesReplayItemsForModel(
			[
				call,
				{
					type: "computer_call_output",
					call_id: "call-file",
					output: { type: "computer_screenshot" },
				},
			],
			model,
			[computerTool],
		);
		expect(missingScreenshot).toEqual([
			fileFallback[0],
			{ type: "function_call_output", call_id: "call-file", output: "" },
		]);
	});
});

describe("OpenAI native computer receive normalization", () => {
	it("prefers GA actions and preserves pending checks on the standard Responses stream", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();
		const call = {
			type: "computer_call",
			id: "cu-standard",
			call_id: "call-standard",
			status: "completed",
			actions: [{ type: "click", button: "left", x: 10, y: 20 }],
			action: { type: "wait" },
			pending_safety_checks: safetyChecks,
		};
		await processResponsesStream(
			responseEvents([
				{ type: "response.output_item.added", output_index: 0, item: call },
				{ type: "response.output_item.done", output_index: 0, item: call },
				{ type: "response.completed", response: { id: "resp-standard", status: "completed" } },
			]),
			output,
			stream,
			createResponsesModel(),
		);

		const block = output.content[0];
		if (block?.type !== "toolCall") throw new Error("expected computer tool call");
		expect(block.name).toBe("computer");
		expect(block.arguments).toEqual({
			actions: [{ type: "click", button: "left", x: 10, y: 20 }],
			pendingSafetyChecks: safetyChecks,
		});
		expect(block.openaiComputer).toEqual({ pendingSafetyChecks: safetyChecks });
	});

	it("normalizes a legacy single action on the Codex stream", async () => {
		const call = {
			type: "computer_call",
			id: "cu-codex",
			call_id: "call-codex",
			status: "completed",
			action: { type: "keypress", keys: ["CTRL", "L"] },
			pending_safety_checks: safetyChecks,
		};
		const fetchMock: FetchImpl = async () =>
			createSse([
				{ type: "response.output_item.added", output_index: 0, item: call },
				{ type: "response.output_item.done", output_index: 0, item: call },
				{
					type: "response.completed",
					response: {
						id: "resp-codex",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		const result = await streamOpenAICodexResponses(
			createCodexModel("gpt-5.4", { baseUrl: "https://chatgpt.com/backend-api" }),
			{ systemPrompt: ["You are helpful."], messages: [{ role: "user", content: "inspect", timestamp: 0 }] },
			{ apiKey: createCodexToken(), preferWebsockets: false, fetch: fetchMock },
		).result();

		const block = result.content[0];
		if (block?.type !== "toolCall") throw new Error("expected computer tool call");
		expect(block.arguments).toEqual({
			actions: [{ type: "keypress", keys: ["CTRL", "L"] }],
			pendingSafetyChecks: safetyChecks,
		});
		expect(block.openaiComputer).toEqual({ pendingSafetyChecks: safetyChecks });
	});
});

describe("OpenAI native computer history", () => {
	it("serializes a successful screenshot with its original data URL and acknowledged checks", () => {
		const input = buildComputerHistory(createResponsesModel(), computerResult());
		const call = input.find(item => item.type === "computer_call");
		const result = input.find(item => item.type === "computer_call_output");
		expect(call).toMatchObject({
			type: "computer_call",
			id: expect.stringMatching(/^cu_/),
			call_id: "call-computer",
			actions: [{ type: "screenshot" }],
			pending_safety_checks: safetyChecks,
		});
		expect(result).toEqual({
			type: "computer_call_output",
			call_id: "call-computer",
			output: { type: "computer_screenshot", image_url: "data:image/png;base64,png-base64-original" },
			acknowledged_safety_checks: safetyChecks,
		});
		expect(input.some(item => item.type === "function_call_output")).toBe(false);
	});

	it("keeps function-tool computer history paired as function items after a provider switch", () => {
		const model = createResponsesModel();
		const assistant: AssistantMessage = {
			...createOutput(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			content: [
				{
					type: "toolCall",
					id: "call-function-computer",
					name: "computer",
					arguments: { action: "screenshot" },
				},
			],
			stopReason: "toolUse",
		};
		const result = computerResult({
			toolCallId: "call-function-computer",
			content: [{ type: "text", text: "function computer result" }],
		});
		const input = buildResponsesInput({
			model,
			context: { messages: [assistant, result], tools: [computerTool] },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: false, filterReasoning: false },
			repairOrphanOutputs: true,
		});

		const functionCall = input.find(item => item.type === "function_call");
		if (!functionCall) throw new Error("expected function computer call");
		expect(functionCall).toMatchObject({
			type: "function_call",
			name: "computer",
		});
		expect(input.find(item => item.type === "function_call_output")).toEqual({
			type: "function_call_output",
			call_id: functionCall.call_id,
			output: "function computer result",
		});
		expect(input.some(item => item.type === "computer_call")).toBe(false);
		expect(input.some(item => item.type === "computer_call_output")).toBe(false);
	});

	it("preserves native computer items in standard and Codex provider history", () => {
		const model = createResponsesModel();
		const nativeCall = {
			type: "computer_call",
			id: "cu-native",
			call_id: "call-native",
			status: "completed",
			actions: [{ type: "wait" }],
			pending_safety_checks: safetyChecks,
		};
		const assistant: AssistantMessage = {
			...computerAssistant(model),
			content: [
				{
					type: "toolCall",
					id: "call-native|cu-native",
					name: "computer",
					arguments: { actions: [{ type: "wait" }], pendingSafetyChecks: safetyChecks },
					openaiComputer: { pendingSafetyChecks: safetyChecks },
				},
			],
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [nativeCall],
			},
		};
		const result = computerResult({ toolCallId: "call-native|cu-native" });
		const context: Context = { messages: [assistant, result], tools: [computerTool] };
		const standard = buildResponsesInput({
			model,
			context,
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		expect(standard.find(item => item.type === "computer_call")).toMatchObject({
			call_id: "call-native",
			actions: [{ type: "wait" }],
		});
		expect(standard.some(item => item.type === "computer_call_output")).toBe(true);

		const codexModel = createCodexModel("gpt-5.4");
		const codexAssistant: AssistantMessage = {
			...assistant,
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: codexModel.id,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai-codex",
				dt: true,
				items: [nativeCall],
			},
		};
		const codex = convertCodexResponsesMessages(codexModel, {
			messages: [codexAssistant, result],
			tools: [computerTool],
		});
		expect(codex.find(item => item.type === "computer_call")).toMatchObject({
			call_id: "call-native",
			actions: [{ type: "wait" }],
		});
		expect(codex.some(item => item.type === "computer_call_output")).toBe(true);
	});

	it("assigns a stable cu item id when a native computer turn is re-encoded across models", () => {
		const source = createResponsesModel();
		const target = createResponsesModel("gpt-5.5");
		const assistant: AssistantMessage = {
			...computerAssistant(source),
			content: [
				{
					type: "toolCall",
					id: "call-switch|fc-native",
					name: "computer",
					arguments: { actions: [{ type: "screenshot" }], pendingSafetyChecks: safetyChecks },
					openaiComputer: { pendingSafetyChecks: safetyChecks },
				},
			],
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				dt: true,
				items: [
					{
						type: "computer_call",
						id: "fc-native",
						call_id: "call-switch",
						status: "completed",
						actions: [{ type: "screenshot" }],
						pending_safety_checks: safetyChecks,
					},
				],
			},
		};
		const context: Context = {
			messages: [assistant, computerResult({ toolCallId: "call-switch|fc-native" })],
			tools: [computerTool],
		};
		const encode = () =>
			buildResponsesInput({
				model: target,
				context,
				strictResponsesPairing: true,
				supportsImageDetailOriginal: true,
				nativeHistory: { replay: true, filterReasoning: false },
			});
		const first = encode();
		const firstCall = first.find(item => item.type === "computer_call");
		const secondCall = encode().find(item => item.type === "computer_call");
		if (!firstCall || !secondCall) throw new Error("expected re-encoded computer call");
		expect(firstCall).toMatchObject({ type: "computer_call", call_id: "call-switch" });
		expect(firstCall.id).toMatch(/^cu_/);
		expect(secondCall.id).toBe(firstCall.id);
		expect(first.some(item => item.type === "computer_call_output" && item.call_id === "call-switch")).toBe(true);
		expect(first.some(item => item.type === "function_call" || item.type === "function_call_output")).toBe(false);
	});

	it("downgrades native history after a model switch, including Codex payload replay", () => {
		const sourceModel = createResponsesModel();
		const assistant = computerAssistant(sourceModel);
		const result = computerResult();
		const target = createResponsesModel("gpt-5.3");
		const standard = buildResponsesInput({
			model: target,
			context: { messages: [assistant, result], tools: [computerTool] },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const standardCall = standard.find(item => item.type === "function_call");
		expect(standardCall).toMatchObject({
			type: "function_call",
			name: "computer",
			arguments: JSON.stringify({
				actions: [{ type: "screenshot" }],
				pendingSafetyChecks: safetyChecks,
			}),
		});
		expect(standard.find(item => item.type === "function_call_output")).toEqual({
			type: "function_call_output",
			call_id: "call-computer",
			output: "(see attached image)",
		});
		expect(standard.find(item => item.type === undefined && "role" in item && item.role === "user")).toEqual({
			role: "user",
			content: [
				{ type: "input_text", text: "Attached image(s) from tool result:" },
				{
					type: "input_image",
					detail: "auto",
					image_url: "data:image/png;base64,png-base64-original",
				},
			],
		});
		expect(standard.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);

		const codexTarget = createCodexModel("gpt-5.3-codex", { input: ["text", "image"] });
		const codexAssistant: AssistantMessage = {
			...assistant,
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: codexTarget.id,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai-codex",
				dt: true,
				items: [
					{
						type: "computer_call",
						id: "cu-computer",
						call_id: "call-computer",
						status: "completed",
						actions: [{ type: "screenshot" }],
						pending_safety_checks: safetyChecks,
					},
				],
			},
		};
		const codex = convertCodexResponsesMessages(codexTarget, {
			messages: [codexAssistant, result],
			tools: [computerTool],
		});
		expect(codex.map(item => item.type ?? ("role" in item ? item.role : undefined))).toEqual([
			"function_call",
			"function_call_output",
			"user",
		]);
		expect(codex.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
	});

	it("folds orphan calls and outputs into assistant recovery notes", () => {
		const orphanCall = repairOrphanResponsesToolCalls([
			{
				type: "computer_call",
				id: "cu-orphan",
				call_id: "call-orphan",
				status: "completed",
				actions: [{ type: "wait" }],
				pending_safety_checks: [],
			},
		]);
		expect(orphanCall.some(item => item.type === "computer_call")).toBe(false);
		expect(orphanCall.some(item => item.type === "computer_call_output")).toBe(false);
		expect(orphanCall[0]).toMatchObject({ type: "message", role: "assistant" });

		const orphanOutput = repairOrphanResponsesToolOutputs([
			{
				type: "computer_call_output",
				call_id: "missing-call",
				output: { type: "computer_screenshot", image_url: "data:image/png;base64,x" },
			},
		]);
		expect(orphanOutput.some(item => item.type === "computer_call_output")).toBe(false);
		expect(orphanOutput[0]).toMatchObject({ type: "message", role: "assistant" });
	});

	it("repairs mismatched call and output kinds instead of treating their shared id as paired", () => {
		const repairedOutputs = repairOrphanResponsesToolOutputs([
			{
				type: "function_call",
				call_id: "call-mismatched",
				name: "computer",
				arguments: "{}",
			},
			{
				type: "computer_call_output",
				call_id: "call-mismatched",
				output: { type: "computer_screenshot", image_url: "data:image/png;base64,x" },
			},
		]);
		expect(repairedOutputs.some(item => item.type === "computer_call_output")).toBe(false);
		expect(repairedOutputs.some(item => item.type === "message" && item.role === "assistant")).toBe(true);

		const repairedCalls = repairOrphanResponsesToolCalls(repairedOutputs);
		expect(repairedCalls.some(item => item.type === "function_call")).toBe(true);
		expect(
			repairedCalls.some(item => item.type === "function_call_output" && item.call_id === "call-mismatched"),
		).toBe(true);
	});

	it("repairs output-before-call ordering for function, custom, and computer items", () => {
		const repaired = repairOrphanResponsesToolCalls(
			repairOrphanResponsesToolOutputs([
				{ type: "function_call_output", call_id: "call-function-early", output: "early" },
				{ type: "function_call", call_id: "call-function-early", name: "computer", arguments: "{}" },
				{ type: "custom_tool_call_output", call_id: "call-custom-early", output: "early" },
				{ type: "custom_tool_call", call_id: "call-custom-early", name: "apply_patch", input: "" },
				{
					type: "computer_call_output",
					call_id: "call-computer-early",
					output: { type: "computer_screenshot", image_url: "data:image/png;base64,x" },
				},
				{
					type: "computer_call",
					id: "cu-computer-early",
					call_id: "call-computer-early",
					status: "completed",
					actions: [{ type: "wait" }],
					pending_safety_checks: [],
				},
			]),
		);

		expect(
			repaired.filter(item => "call_id" in item && item.call_id === "call-function-early").map(item => item.type),
		).toEqual(["function_call", "function_call_output"]);
		expect(
			repaired.filter(item => "call_id" in item && item.call_id === "call-custom-early").map(item => item.type),
		).toEqual(["custom_tool_call", "custom_tool_call_output"]);
		expect(repaired.some(item => "call_id" in item && item.call_id === "call-computer-early")).toBe(false);
		for (const callId of ["call-function-early", "call-custom-early", "call-computer-early"]) {
			expect(
				repaired.some(
					item =>
						item.type === "message" &&
						item.role === "assistant" &&
						typeof item.content === "string" &&
						item.content.includes(callId),
				),
			).toBe(true);
		}
	});

	it("removes standard protocol items with missing, empty, or non-string call ids", () => {
		const malformed: unknown = [
			{ type: "function_call", name: "read", arguments: "{}" },
			{ type: "custom_tool_call", call_id: null, name: "apply_patch", input: "" },
			{ type: "computer_call", call_id: 42, actions: [{ type: "wait" }], pending_safety_checks: [] },
			{ type: "function_call_output", call_id: "", output: "bad" },
			{ type: "custom_tool_call_output", call_id: false, output: "bad" },
			{ type: "computer_call_output", output: { type: "computer_screenshot", image_url: "x" } },
		];
		const repaired = repairOrphanResponsesToolCalls(repairOrphanResponsesToolOutputs(malformed as ResponseInput));
		const protocolTypes = new Set([
			"function_call",
			"custom_tool_call",
			"computer_call",
			"function_call_output",
			"custom_tool_call_output",
			"computer_call_output",
		]);
		expect(repaired.some(item => typeof item.type === "string" && protocolTypes.has(item.type))).toBe(false);
		expect(repaired.filter(item => item.type === "message" && item.role === "assistant")).toHaveLength(6);
	});

	it("folds errors and no-image results without emitting any tool output", () => {
		for (const result of [
			computerResult({ content: [{ type: "text", text: "browser crashed" }], isError: true }),
			computerResult({ content: [{ type: "text", text: "screenshot unavailable" }] }),
		]) {
			const input = buildComputerHistory(createResponsesModel(), result);
			expect(input.some(item => item.type === "computer_call")).toBe(false);
			expect(input.some(item => item.type === "computer_call_output")).toBe(false);
			expect(input.some(item => item.type === "function_call_output")).toBe(false);
			expect(input.some(item => item.type === "message" && item.role === "assistant")).toBe(true);
		}
	});
});

describe("OpenAI Codex computer request pairing repair", () => {
	it("pairs function, custom, and computer outputs only with the same call kind", async () => {
		const cases: Array<{
			id: string;
			call: InputItem;
			mismatchedOutput: InputItem;
			expectedWireTypes: string[];
		}> = [
			{
				id: "call-function-mismatch",
				call: { type: "function_call", call_id: "call-function-mismatch", name: "computer", arguments: "{}" },
				mismatchedOutput: {
					type: "computer_call_output",
					call_id: "call-function-mismatch",
					output: { type: "computer_screenshot", image_url: "data:image/png;base64,x" },
				},
				expectedWireTypes: ["function_call", "function_call_output"],
			},
			{
				id: "call-custom-mismatch",
				call: { type: "custom_tool_call", call_id: "call-custom-mismatch", name: "apply_patch" },
				mismatchedOutput: {
					type: "function_call_output",
					call_id: "call-custom-mismatch",
					output: "mismatched result",
				},
				expectedWireTypes: ["custom_tool_call", "custom_tool_call_output"],
			},
			{
				id: "call-computer-mismatch",
				call: { type: "computer_call", call_id: "call-computer-mismatch" },
				mismatchedOutput: {
					type: "function_call_output",
					call_id: "call-computer-mismatch",
					output: "mismatched result",
				},
				expectedWireTypes: [],
			},
		];

		for (const testCase of cases) {
			const body: RequestBody = {
				model: "gpt-5.4",
				input: [testCase.call, testCase.mismatchedOutput],
			};
			const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
			const input = transformed.input ?? [];
			expect(input.filter(item => item.call_id === testCase.id).map(item => item.type)).toEqual(
				testCase.expectedWireTypes,
			);
			expect(
				input.some(
					item =>
						item.type === "message" &&
						item.role === "assistant" &&
						typeof item.content === "string" &&
						item.content.includes(testCase.id),
				),
			).toBe(true);
		}
	});

	it("repairs output-before-call ordering for every Codex tool call kind", async () => {
		const cases: Array<{ id: string; call: InputItem; output: InputItem; expectedWireTypes: string[] }> = [
			{
				id: "call-function-early-codex",
				call: { type: "function_call", call_id: "call-function-early-codex", name: "computer", arguments: "{}" },
				output: { type: "function_call_output", call_id: "call-function-early-codex", output: "early" },
				expectedWireTypes: ["function_call", "function_call_output"],
			},
			{
				id: "call-custom-early-codex",
				call: { type: "custom_tool_call", call_id: "call-custom-early-codex", name: "apply_patch" },
				output: { type: "custom_tool_call_output", call_id: "call-custom-early-codex", output: "early" },
				expectedWireTypes: ["custom_tool_call", "custom_tool_call_output"],
			},
			{
				id: "call-computer-early-codex",
				call: { type: "computer_call", call_id: "call-computer-early-codex" },
				output: {
					type: "computer_call_output",
					call_id: "call-computer-early-codex",
					output: { type: "computer_screenshot", image_url: "data:image/png;base64,x" },
				},
				expectedWireTypes: [],
			},
		];

		for (const testCase of cases) {
			const body: RequestBody = { model: "gpt-5.4", input: [testCase.output, testCase.call] };
			const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
			const input = transformed.input ?? [];
			expect(input.filter(item => item.call_id === testCase.id).map(item => item.type)).toEqual(
				testCase.expectedWireTypes,
			);
			expect(
				input.some(
					item =>
						item.type === "message" &&
						item.role === "assistant" &&
						typeof item.content === "string" &&
						item.content.includes(testCase.id),
				),
			).toBe(true);
		}
	});

	it("removes Codex protocol items with missing, empty, or non-string call ids", async () => {
		const malformed: unknown = [
			{ type: "function_call", name: "read", arguments: "{}" },
			{ type: "custom_tool_call", call_id: null, name: "apply_patch" },
			{ type: "computer_call", call_id: 42 },
			{ type: "function_call_output", call_id: "", output: "bad" },
			{ type: "custom_tool_call_output", call_id: false, output: "bad" },
			{ type: "computer_call_output", output: { type: "computer_screenshot", image_url: "x" } },
		];
		const body: RequestBody = { model: "gpt-5.4", input: malformed as InputItem[] };
		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});
		const protocolTypes = new Set([
			"function_call",
			"custom_tool_call",
			"computer_call",
			"function_call_output",
			"custom_tool_call_output",
			"computer_call_output",
		]);
		expect(transformed.input?.some(item => protocolTypes.has(item.type ?? ""))).toBe(false);
		expect(transformed.input?.filter(item => item.type === "message" && item.role === "assistant")).toHaveLength(6);
	});
});
