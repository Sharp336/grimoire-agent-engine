import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { InspectImageTool } from "@oh-my-pi/pi-coding-agent/tools/inspect-image";
import { inspectImageToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/inspect-image-renderer";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { Value } from "@sinclair/typebox/value";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const visionModel: Model<"openai-responses"> = {
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const textOnlyModel: Model<"openai-responses"> = {
	...visionModel,
	id: "gpt-4.1",
	input: ["text"],
};

interface CreateSessionOptions {
	availableModels?: Model<"openai-responses">[];
	activeModel?: Model<"openai-responses">;
	configureVisionRole?: boolean;
}

function createSession(
	cwd: string,
	model: Model<"openai-responses">,
	apiKey: string | undefined = "test-key",
	settings = Settings.isolated(),
	options: CreateSessionOptions = {},
): ToolSession {
	const availableModels = options.availableModels ?? [model];
	const activeModel = options.activeModel ?? model;
	if (options.configureVisionRole !== false) {
		settings.setModelRole("vision", `${model.provider}/${model.id}`);
	}

	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getModelString: () => `${activeModel.provider}/${activeModel.id}`,
		getActiveModelString: () => `${activeModel.provider}/${activeModel.id}`,
		settings,
		modelRegistry: {
			getAvailable: () => availableModels,
			getApiKey: async () => apiKey,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	};
}

describe("InspectImageTool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-inspect-image-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("sends image and question to completeSimple and returns text-only result", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text: "Detected text: Settings" }],
		} as any);

		const tool = new InspectImageTool(createSession(testDir, visionModel));
		const result = await tool.execute("call-1", {
			path: imagePath,
			question: "Extract visible UI labels.",
		});

		expect(result.content).toEqual([{ type: "text", text: "Detected text: Settings" }]);
		expect((result.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(false);
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);

		const request = completeSimpleSpy.mock.calls[0]?.[1];
		const userMessage = request?.messages?.[0];
		const content = userMessage?.content;
		expect(Array.isArray(content)).toBe(true);
		const contentParts = (Array.isArray(content) ? content : []) as Array<{ type: string; text?: string }>;
		expect(contentParts[0]?.type).toBe("image");
		expect(contentParts[1]).toEqual({ type: "text", text: "Extract visible UI labels." });
	});

	it("sends question text unchanged", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text: "Looks clear" }],
		} as any);

		const tool = new InspectImageTool(createSession(testDir, visionModel));
		await tool.execute("call-1b", { path: imagePath, question: "What warning is shown?" });

		const request = completeSimpleSpy.mock.calls[0]?.[1];
		const userMessage = request?.messages?.[0];
		const content = userMessage?.content;
		const contentParts = (Array.isArray(content) ? content : []) as Array<{ type: string; text?: string }>;
		expect(contentParts[1]).toEqual({ type: "text", text: "What warning is shown?" });
	});

	it("registers custom renderer and shows question in terminal output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		expect(toolRenderers.inspect_image).toBeDefined();

		const callComponent = inspectImageToolRenderer.renderCall(
			{ path: "/tmp/screenshot.png", question: "What error text is visible?" },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const callOutput = sanitizeText(callComponent.render(100).join("\n"));
		expect(callOutput).toContain("Inspect Image");
		expect(callOutput).toContain("Question:");
		expect(callOutput).toContain("What error text is visible?");

		const resultComponent = inspectImageToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5" }],
				details: {
					model: "openai/gpt-4o",
					imagePath: "/tmp/screenshot.png",
					mimeType: "image/png",
				},
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ path: "/tmp/screenshot.png", question: "What error text is visible?" },
		);
		const resultOutput = sanitizeText(resultComponent.render(100).join("\n"));
		expect(resultOutput).toContain("Inspect Image");
		expect(resultOutput).toContain("image/png");
		expect(resultOutput).toContain("Question:");
		expect(resultOutput).toContain("What error text is visible?");
		expect(resultOutput).toContain("openai/gpt-4o");
		expect(resultOutput).toContain("more lines");
	});

	it("schema rejects unknown parameters", () => {
		const tool = new InspectImageTool(createSession(testDir, visionModel));
		expect(tool.strict).toBe(true);
		expect(Value.Check(tool.parameters, { path: "img.png", question: "What is visible?" })).toBe(true);
		expect(Value.Check(tool.parameters, { path: "img.png", question: "What is visible?", extra: "nope" })).toBe(
			false,
		);
	});

	it("fails when images.blockImages is enabled", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		const settings = Settings.isolated({ "images.blockImages": true });
		const tool = new InspectImageTool(createSession(testDir, visionModel, "test-key", settings));

		await expect(tool.execute("call-blocked", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/Image submission is disabled/i,
		);
		expect(completeSimpleSpy).not.toHaveBeenCalled();
	});

	it("falls back to pi/default when vision role is unset", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${visionModel.provider}/${visionModel.id}`);

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text: "Fallback default model used" }],
		} as any);

		const tool = new InspectImageTool(
			createSession(testDir, textOnlyModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [textOnlyModel, visionModel],
				activeModel: textOnlyModel,
			}),
		);

		const result = await tool.execute("call-1c", { path: imagePath, question: "What text is visible?" });
		expect(result.details?.model).toBe("openai/gpt-4o");
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const selectedModel = completeSimpleSpy.mock.calls[0]?.[0];
		expect(selectedModel?.id).toBe("gpt-4o");
	});

	it("fails with actionable error when resolved model does not support image input", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		const tool = new InspectImageTool(createSession(testDir, textOnlyModel));

		await expect(tool.execute("call-2", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/does not support image input/i,
		);
		expect(completeSimpleSpy).not.toHaveBeenCalled();
	});

	it("fails with actionable error when API key is missing", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		const tool = new InspectImageTool(createSession(testDir, visionModel, ""));

		await expect(tool.execute("call-3", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/No API key available/i,
		);
		expect(completeSimpleSpy).not.toHaveBeenCalled();
	});
});
