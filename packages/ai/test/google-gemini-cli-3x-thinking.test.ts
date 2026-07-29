import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { applyGeneratedModelPolicies } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import agyGemini36FlashHigh from "./fixtures/antigravity-gemini-3.6-flash-thinking.json" with { type: "json" };

interface GeminiCliThinkingConfig {
	thinkingLevel?: string;
	thinkingBudget?: number;
	includeThoughts?: boolean;
}

interface CapturedRequestBody {
	request?: {
		generationConfig?: {
			thinkingConfig?: GeminiCliThinkingConfig;
		};
		labels?: { model_enum?: string };
	};
}

function createModel(id: string): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function createAntigravityGemini36FlashModel(): Model<"google-gemini-cli"> {
	const models: ModelSpec<"google-gemini-cli">[] = [
		{
			id: "gemini-3.6-flash",
			name: "Gemini 3.6 Flash",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			requestModelId: "gemini-3.6-flash-low",
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				requiresEffort: true,
				effortRouting: {
					[Effort.Minimal]: "gemini-3.6-flash-low",
					[Effort.Low]: "gemini-3.6-flash-low",
					[Effort.Medium]: "gemini-3.6-flash-medium",
					[Effort.High]: "gemini-3.6-flash-high",
				},
			},
		},
	];
	applyGeneratedModelPolicies(models);
	return buildModel(models[0]!);
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function extractThinking(bodyText: string | undefined): GeminiCliThinkingConfig | undefined {
	if (!bodyText) return undefined;
	const parsed = JSON.parse(bodyText) as CapturedRequestBody;
	return parsed.request?.generationConfig?.thinkingConfig;
}

describe("google-gemini-cli Gemini 3.x thinking mapping", () => {
	const createFetchMock =
		(capture: (body: string | undefined) => void): FetchImpl =>
		(_input, init) => {
			capture(typeof init?.body === "string" ? init.body : undefined);
			return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
		};
	it("uses thinkingLevel for gemini-3.1-pro-preview when the effort is supported", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-pro-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("HIGH");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("keeps Cloud Code Assist reasoning enabled when only summaries are hidden", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-pro-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
			hideThinkingSummary: true,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.includeThoughts).toBe(false);
		expect(thinking?.thinkingLevel).toBe("HIGH");
	});

	it("rejects unsupported gemini-3.1-pro-preview efforts instead of promoting them", () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		expect(() =>
			streamSimple(createModel("gemini-3.1-pro-preview"), context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				reasoning: Effort.Medium,
				fetch: fetchMock,
			}),
		).toThrow(/Supported efforts: low, high/);
		expect(requestBody).toBeUndefined();
	});

	it("uses thinkingLevel for gemini-3.1-flash-preview", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-flash-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("MEDIUM");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("keeps thinkingBudget for gemini-2.5-pro", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-2.5-pro"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBeUndefined();
		expect(thinking?.thinkingBudget).toBeDefined();
	});

	it("matches agy's captured Gemini 3.6 Flash high-effort Cloud Code Assist payload", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createAntigravityGemini36FlashModel(), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
			fetch: fetchMock,
		});
		await stream.result();

		const request = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(request.request?.generationConfig?.thinkingConfig).toEqual(
			agyGemini36FlashHigh.generationConfig.thinkingConfig,
		);
		expect(request.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBeUndefined();
		expect(request.request?.labels?.model_enum).toBe(agyGemini36FlashHigh.labels.model_enum);
	});
});
