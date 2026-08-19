import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type BlockState,
	handleServerMessage,
	processInteractionUpdate,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import { cursorWritePayload } from "@oh-my-pi/pi-ai/providers/cursor-pi-args";
import { cursorProjectFolder } from "@oh-my-pi/pi-ai/providers/cursor/workspace";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentServerMessageSchema,
	type ExecServerMessage,
	ExecServerMessageSchema,
	GenerateImageArgsSchema,
	GenerateImageErrorSchema,
	GenerateImageResultSchema,
	GenerateImageSuccessSchema,
	GenerateImageToolCallSchema,
	type ToolCall,
	ToolCallSchema,
	WriteArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a]);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-imagine-"));
	tempDirs.push(dir);
	return dir;
}

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-grok-4.6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(overrides: Partial<BlockState> = {}): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		...overrides,
	};
}

function generateImageToolCall(options: {
	filePath: string;
	imageData?: string;
	error?: string;
	description?: string;
}) {
	const result = options.error
		? create(GenerateImageResultSchema, {
				result: { case: "error", value: create(GenerateImageErrorSchema, { error: options.error }) },
			})
		: create(GenerateImageResultSchema, {
				result: {
					case: "success",
					value: create(GenerateImageSuccessSchema, {
						filePath: options.filePath,
						imageData: options.imageData ?? "",
					}),
				},
			});
	const wire = create(ToolCallSchema, {
		tool: {
			case: "generateImageToolCall",
			value: create(GenerateImageToolCallSchema, {
				args: create(GenerateImageArgsSchema, {
					description: options.description ?? "a dog",
					filePath: options.filePath,
				}),
				result,
			}),
		},
	});
	return fromBinary(ToolCallSchema, toBinary(ToolCallSchema, wire));
}

function runGenerateImage(toolCall: ToolCall, workspacePaths: string[]) {
	const output = cursorAssistantMessage();
	const stream = new AssistantMessageEventStream();
	const results: ToolResultMessage[] = [];
	const state = newBlockState({
		workspacePaths,
		onToolResult: toolResult => {
			results.push(toolResult);
			return toolResult;
		},
	});
	processInteractionUpdate(
		{ message: { case: "toolCallStarted", value: { callId: "img-1", toolCall } } },
		output,
		stream,
		state,
		{ sawTokenDelta: false },
	);
	processInteractionUpdate(
		{ message: { case: "toolCallCompleted", value: { callId: "img-1", toolCall } } },
		output,
		stream,
		state,
		{ sawTokenDelta: false },
	);
	return { output, results, state };
}

describe("Cursor hosted GenerateImage", () => {
	it("writes GenerateImageSuccess.imageData to file_path instead of a 0-byte stub", () => {
		const dir = tempDir();
		const target = path.join(dir, "assets", "dog.png");
		const { output, results } = runGenerateImage(
			generateImageToolCall({
				filePath: target,
				imageData: Buffer.from(PNG).toString("base64"),
			}),
			[dir],
		);

		const block = output.content.find((c): c is ToolCallState => c.type === "toolCall");
		expect(block?.name).toBe("generate_image");
		expect(block?.[kCursorExecResolved]).toBe(true);
		expect(results[0]?.isError).toBe(false);
		expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG);
	});

	it("relocates Imagine files from ~/.cursor/projects/<slug> into the session cwd", () => {
		const dir = tempDir();
		const artifact = path.join(cursorProjectFolder(dir), "assets", "cat.png");
		const relocated = path.join(dir, "assets", "cat.png");
		const { results } = runGenerateImage(
			generateImageToolCall({
				filePath: artifact,
				imageData: Buffer.from(PNG).toString("base64"),
			}),
			[dir],
		);
		expect(results[0]?.isError).toBe(false);
		expect(new Uint8Array(fs.readFileSync(relocated))).toEqual(PNG);
		expect(fs.existsSync(artifact)).toBe(false);
	});

	it("does not write when image_data is empty", () => {
		const dir = tempDir();
		const target = path.join(dir, "empty.png");
		const { results } = runGenerateImage(generateImageToolCall({ filePath: target, imageData: "" }), [dir]);
		expect(results[0]?.isError).toBe(true);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("refuses an empty WriteArgs for an image path so it cannot clobber a real PNG", async () => {
		const dir = tempDir();
		const target = path.join(dir, "dog.png");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(target, PNG);

		const frames: Uint8Array[] = [];
		let writeHandlerCalls = 0;
		const h2Request = {
			write: (bytes: Uint8Array) => {
				frames.push(bytes);
			},
		};
		const execMsg = create(ExecServerMessageSchema, {
			id: 1,
			execId: "write-1",
			message: {
				case: "writeArgs",
				value: create(WriteArgsSchema, {
					path: target,
					fileText: "",
					fileBytes: new Uint8Array(),
					toolCallId: "w1",
				}),
			},
		}) as ExecServerMessage;

		await handleServerMessage(
			create(AgentServerMessageSchema, {
				message: { case: "execServerMessage", value: execMsg },
			}),
			cursorAssistantMessage(),
			new AssistantMessageEventStream(),
			newBlockState({ workspacePaths: [dir] }),
			new Map(),
			h2Request as never,
			{
				write: async () => {
					writeHandlerCalls += 1;
					throw new Error("empty image write must not reach the write handler");
				},
			},
			undefined,
			{ sawTokenDelta: false },
			[],
			undefined,
			[dir],
		);

		expect(writeHandlerCalls).toBe(0);
		expect(new Uint8Array(fs.readFileSync(target))).toEqual(PNG);
		expect(cursorWritePayload({ fileText: "", fileBytes: new Uint8Array() }).mode).toBe("text");
		expect(frames.length).toBeGreaterThan(0);
	});
});
