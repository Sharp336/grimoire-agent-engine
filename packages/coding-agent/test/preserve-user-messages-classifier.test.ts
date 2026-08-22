import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	ApiKeyResolveContext,
	ApiKeyResolver,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { classifyPreservedUserMessages } from "@oh-my-pi/pi-coding-agent/session/preserve-user-messages-classifier";

function classifierModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
	return model;
}

function classifierSettings(model: Model) {
	return {
		get: () => undefined,
		getStorage: () => undefined,
		getModelRole: (role: string) => (role === "tiny" ? `${model.provider}/${model.id}` : undefined),
	} as never;
}

function classifierRegistry(model: Model) {
	const keyResolver: ApiKeyResolver = () => "test-api-key";
	return {
		getAvailable: () => [model],
		resolver: () => keyResolver,
	} as never;
}

function classifierResponse(model: Model, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("classifyPreservedUserMessages", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes obfuscated candidate text through the session completion transport with a reasoning-safe cap", async () => {
		const model = classifierModel();
		const secret = "CLASSIFIER_SECRET_TOKEN_12345";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		const sessionComplete: typeof ai.completeSimple = async (_requestModel, context, options) => {
			capturedContext = context;
			capturedOptions = options;
			return classifierResponse(model, "[0]");
		};
		const completeImpl = vi.fn(sessionComplete);
		const directComplete = vi.spyOn(ai, "completeSimple");

		const preserved = await classifyPreservedUserMessages(
			[{ id: "candidate-1", text: `Always authenticate with ${secret}.` }],
			{
				settings: classifierSettings(model),
				registry: classifierRegistry(model),
				sessionId: "classifier-secret-test",
				completeImpl,
				obfuscateTextForProvider: text => obfuscator.obfuscate(text),
			},
		);

		expect(preserved).toEqual(["candidate-1"]);
		expect(completeImpl).toHaveBeenCalledTimes(1);
		expect(directComplete).not.toHaveBeenCalled();
		const providerInput = JSON.stringify(capturedContext);
		expect(providerInput).toContain(placeholder);
		expect(providerInput).not.toContain(secret);
		expect(capturedOptions).toMatchObject({ maxTokens: 4096, disableReasoning: true });
	});

	it("uses the session-scoped auth resolver and forwards the classifier signal", async () => {
		const model = classifierModel();
		const controller = new AbortController();
		let resolvedContext: ApiKeyResolveContext | undefined;
		const keyResolver: ApiKeyResolver = context => {
			resolvedContext = context;
			return "rotating-test-key";
		};
		const resolver = vi.fn(() => keyResolver);
		const registry = {
			getAvailable: () => [model],
			resolver,
		} as never;
		const sessionComplete: typeof ai.completeSimple = async (_requestModel, _context, options) => {
			const apiKey = options?.apiKey;
			if (typeof apiKey !== "function") throw new Error("Expected the central API-key resolver");
			await apiKey({ lastChance: false, error: undefined, signal: options?.signal });
			return classifierResponse(model, "[0]");
		};

		const preserved = await classifyPreservedUserMessages([{ id: "candidate-1", text: "Keep this rule." }], {
			settings: classifierSettings(model),
			registry,
			sessionId: "classifier-auth-test",
			completeImpl: sessionComplete,
			obfuscateTextForProvider: text => text,
			signal: controller.signal,
		});

		expect(preserved).toEqual(["candidate-1"]);
		expect(resolver).toHaveBeenCalledWith(model, "classifier-auth-test");
		expect(resolvedContext).toEqual({ lastChance: false, error: undefined, signal: controller.signal });
	});

	it("cancels an in-flight session completion through the caller signal", async () => {
		const model = classifierModel();
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<never>();
		let completionSignal: AbortSignal | undefined;
		const sessionComplete: typeof ai.completeSimple = async (_requestModel, _context, options) => {
			const signal = options?.signal;
			if (!signal) throw new Error("Expected classifier cancellation signal");
			completionSignal = signal;
			signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
			started.resolve();
			signal.throwIfAborted();
			return aborted.promise;
		};
		const classification = classifyPreservedUserMessages([{ id: "candidate-1", text: "Keep this rule." }], {
			settings: classifierSettings(model),
			registry: classifierRegistry(model),
			sessionId: "classifier-cancellation-test",
			completeImpl: sessionComplete,
			obfuscateTextForProvider: text => text,
			signal: controller.signal,
		});
		await started.promise;
		const reason = new DOMException("classifier cancelled", "AbortError");
		controller.abort(reason);

		await expect(classification).rejects.toBe(reason);
		expect(completionSignal).toBe(controller.signal);
	});

	it("falls back when the provider returns an out-of-range verdict", async () => {
		const model = classifierModel();
		const sessionComplete: typeof ai.completeSimple = async () => classifierResponse(model, "[99]");

		const preserved = await classifyPreservedUserMessages([{ id: "candidate-1", text: "Keep this rule." }], {
			settings: classifierSettings(model),
			registry: classifierRegistry(model),
			sessionId: "classifier-invalid-index-test",
			completeImpl: sessionComplete,
			obfuscateTextForProvider: text => text,
		});

		expect(preserved).toBeUndefined();
	});

	it("batches more than 200 candidates without changing per-batch index semantics", async () => {
		const model = classifierModel();
		const batchSizes: number[] = [];
		const maxTokenCaps: Array<number | undefined> = [];
		const sessionComplete: typeof ai.completeSimple = async (_requestModel, context, options) => {
			const content = context.messages[0]?.content;
			if (typeof content !== "string") throw new Error("Expected classifier JSON input");
			const batch: unknown = JSON.parse(content);
			if (!Array.isArray(batch)) throw new Error("Expected classifier input array");
			batchSizes.push(batch.length);
			maxTokenCaps.push(options?.maxTokens);
			return classifierResponse(model, "[0]");
		};
		const candidates = Array.from({ length: 201 }, (_, index) => ({
			id: `candidate-${index}`,
			text: `Always retain instruction ${index}.`,
		}));

		const preserved = await classifyPreservedUserMessages(candidates, {
			settings: classifierSettings(model),
			registry: classifierRegistry(model),
			sessionId: "classifier-batching-test",
			completeImpl: sessionComplete,
			obfuscateTextForProvider: text => text,
		});

		expect(batchSizes).toEqual([200, 1]);
		expect(maxTokenCaps).toEqual([4096, 4096]);
		expect(preserved).toEqual(["candidate-0", "candidate-200"]);
	});
});
