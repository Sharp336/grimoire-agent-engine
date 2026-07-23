/**
 * Contract: `createSettingsAwareStreamFn` layers session provider settings
 * (`providers.openrouterVariant`, `providers.antigravityEndpoint`,
 * `providers.stream*TimeoutSeconds`, `providers.maxInFlightRequests`,
 * `model.loopGuard.*`, `textVerbosity` for Responses-family requests)
 * options win — the same wiring the main agent and the advisor agent share so
 * OpenRouter sticky-routing / response caching behaves the same on advisor turns
 * (can1357/oh-my-pi#3639).
 */
import { describe, expect, it, type Mock, vi } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, RateLimitRotationOptions, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildRateLimitRotationOptions,
	createSettingsAwareStreamFn,
	type StreamRotationBinding,
} from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";

function captureBase(): { fn: StreamFn; calls: Array<{ options?: SimpleStreamOptions }> } {
	const calls: Array<{ options?: SimpleStreamOptions }> = [];
	const fn: StreamFn = (_model, _context, options) => {
		calls.push({ options });
		return new AssistantMessageEventStream();
	};
	return { fn, calls };
}

const stubModel = {} as unknown as Model;
const stubCodexModel = { api: "openai-codex-responses" } as unknown as Model;
const stubResponsesModel = { api: "openai-responses" } as unknown as Model;
const stubContext = { messages: [], tools: [], systemPrompt: [] } as unknown as Context;

describe("createSettingsAwareStreamFn", () => {
	it("applies provider settings to the forwarded options when caller omits them", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
			"model.loopGuard.checkAssistantContent": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, { apiKey: "k" });

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("floor");
		expect(options?.antigravityEndpointMode).toBe("sandbox");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 4 });
		expect(options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
		// caller's own option is preserved
		expect(options?.apiKey).toBe("k");
	});

	it("keeps assistant prose loop scanning at its configured default", () => {
		const settings = Settings.isolated({});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
	});

	it("keeps thinking summaries visible unless configured otherwise", () => {
		const settings = Settings.isolated({});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(false);
	});

	it("forwards configured hidden thinking summaries", () => {
		const settings = Settings.isolated({ omitThinking: true });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(true);
	});

	it("applies Responses-family text verbosity from settings while preserving caller overrides", () => {
		const settings = Settings.isolated({ textVerbosity: "low" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubCodexModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, { textVerbosity: "medium" });

		expect(calls[0]?.options?.textVerbosity).toBe("low");
		expect(calls[1]?.options?.textVerbosity).toBe("low");
		expect(calls[2]?.options?.textVerbosity).toBe("medium");
	});

	it("forwards configured stream watchdog budgets while preserving caller overrides", () => {
		const settings = Settings.isolated({
			"providers.streamFirstEventTimeoutSeconds": 600,
			"providers.streamIdleTimeoutSeconds": 300,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, {
			streamFirstEventTimeoutMs: 15_000,
			streamIdleTimeoutMs: 10_000,
		});

		expect(calls[0]?.options?.streamFirstEventTimeoutMs).toBe(600_000);
		expect(calls[0]?.options?.streamIdleTimeoutMs).toBe(300_000);
		expect(calls[1]?.options?.streamFirstEventTimeoutMs).toBe(15_000);
		expect(calls[1]?.options?.streamIdleTimeoutMs).toBe(10_000);
	});

	it("treats the default openrouterVariant as absent so the base call carries no variant", () => {
		const settings = Settings.isolated({ "providers.openrouterVariant": "default" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.openrouterVariant).toBeUndefined();
	});

	it("lets caller-supplied options override the session settings", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, {
			openrouterVariant: "nitro",
			antigravityEndpointMode: "production",
			maxInFlightRequests: { openrouter: 1 },
			loopGuard: { enabled: false },
			hideThinkingSummary: false,
		});

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("nitro");
		expect(options?.antigravityEndpointMode).toBe("production");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 1 });
		// Loop guard merges per-field: caller wins on `enabled`, settings fill
		// the rest (the inline closure the main agent used has the same shape).
		expect(options?.loopGuard?.enabled).toBe(false);
		expect(options?.loopGuard?.checkAssistantContent).toBe(true);
		expect(options?.hideThinkingSummary).toBe(false);
	});
	describe("providers.anthropic.serverSideFallback (opt-in)", () => {
		const stubFableModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-fable-5",
		} as unknown as Model;
		const stubOpusModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4-8",
		} as unknown as Model;

		it("stays off by default: no fallbacks injected on any model", () => {
			const settings = Settings.isolated({});
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("injects Opus 4.8 fallback for Fable when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
		});

		it("does NOT inject fallbacks on non-Fable/Mythos Anthropic models even when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubOpusModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("caller-supplied fallbacks always win over the settings default", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, {
				apiKey: "k",
				fallbacks: [{ model: "claude-sonnet-5" }],
			});

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-sonnet-5" }]);
		});
	});

	describe("retry.rotateOnRateLimit (opt-in rate-limit rotation)", () => {
		const stubOpenAIModel = { provider: "openai", id: "gpt-5-mini" } as unknown as Model;
		const stubAnthropicModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as unknown as Model;
		const resolverApiKey = () => "resolved-key";

		function binding(): StreamRotationBinding & {
			authStorage: { hasUsableSibling: Mock<(provider: string, sessionId?: string) => boolean> };
		} {
			return {
				authStorage: { hasUsableSibling: vi.fn(() => true) },
				getSessionId: () => "session-42",
			};
		}

		it("binds hasUsableSibling to each call's resolved model provider", async () => {
			const settings = Settings.isolated({ "retry.rotateOnRateLimit": true, "retry.rotateMinSleepMs": 750 });
			const { fn: base, calls } = captureBase();
			const rotationBinding = binding();
			const wrapped = createSettingsAwareStreamFn(settings, base, rotationBinding);

			wrapped(stubOpenAIModel, stubContext, { apiKey: resolverApiKey });
			wrapped(stubAnthropicModel, stubContext, { apiKey: resolverApiKey });

			const first = calls[0]?.options?.rateLimitRotation;
			const second = calls[1]?.options?.rateLimitRotation;
			expect(first).toMatchObject({ enabled: true, provider: "openai", minSleepMs: 750 });
			expect(second).toMatchObject({ enabled: true, provider: "anthropic", minSleepMs: 750 });

			// The sibling probe closes over the per-call provider — a mid-run model
			// switch must re-bind it (R4).
			await first?.hasUsableSibling();
			await second?.hasUsableSibling();
			expect(rotationBinding.authStorage.hasUsableSibling.mock.calls).toEqual([
				["openai", "session-42"],
				["anthropic", "session-42"],
			]);
		});

		it("probes the session the resolver was built with, not the binding's session", async () => {
			// The wrapper is shared by the main agent, the advisor, and the autolearn
			// capture agent; the advisor's resolver stickies under its own provider
			// session id. The sibling probe must read THAT session's pool — the
			// binding's getSessionId (main session) only covers resolvers that don't
			// carry their own id.
			const settings = Settings.isolated({ "retry.rotateOnRateLimit": true });
			const { fn: base, calls } = captureBase();
			const rotationBinding = binding();
			rotationBinding.getSessionId = () => "main-1";
			const wrapped = createSettingsAwareStreamFn(settings, base, rotationBinding);
			const advisorResolver = Object.assign(() => "resolved-key", { sessionId: "advisor-7" });

			wrapped(stubOpenAIModel, stubContext, { apiKey: advisorResolver });

			await calls[0]?.options?.rateLimitRotation?.hasUsableSibling();
			expect(rotationBinding.authStorage.hasUsableSibling.mock.calls).toEqual([["openai", "advisor-7"]]);
		});

		it("falls back to the binding's session id for a resolver that carries none", async () => {
			const settings = Settings.isolated({ "retry.rotateOnRateLimit": true });
			const { fn: base, calls } = captureBase();
			const rotationBinding = binding();
			rotationBinding.getSessionId = () => "main-1";
			const wrapped = createSettingsAwareStreamFn(settings, base, rotationBinding);

			wrapped(stubOpenAIModel, stubContext, { apiKey: resolverApiKey });

			await calls[0]?.options?.rateLimitRotation?.hasUsableSibling();
			expect(rotationBinding.authStorage.hasUsableSibling.mock.calls).toEqual([["openai", "main-1"]]);
		});

		it("stays dormant when the flag is off, the key is static, or no binding exists", () => {
			const { fn: base, calls } = captureBase();

			// Flag off (default) with binding + resolver key.
			createSettingsAwareStreamFn(Settings.isolated({}), base, binding())(stubOpenAIModel, stubContext, {
				apiKey: resolverApiKey,
			});
			// Flag on but static string key: a surfaced marker would be terminal.
			createSettingsAwareStreamFn(Settings.isolated({ "retry.rotateOnRateLimit": true }), base, binding())(
				stubOpenAIModel,
				stubContext,
				{ apiKey: "static-key" },
			);
			// Flag on with resolver key but no rotation binding (2-arg call).
			createSettingsAwareStreamFn(Settings.isolated({ "retry.rotateOnRateLimit": true }), base)(
				stubOpenAIModel,
				stubContext,
				{ apiKey: resolverApiKey },
			);

			expect(calls).toHaveLength(3);
			for (const call of calls) {
				expect(call.options?.rateLimitRotation).toBeUndefined();
			}
		});

		it("clamps a corrupt rotateMinSleepMs back to the 2000 default", () => {
			const { fn: base, calls } = captureBase();

			// A negative threshold would make every transient 429 rotation-eligible
			// (delayMs < negative is never true), defeating the long-wait intent.
			createSettingsAwareStreamFn(
				Settings.isolated({ "retry.rotateOnRateLimit": true, "retry.rotateMinSleepMs": -5 }),
				base,
				binding(),
			)(stubOpenAIModel, stubContext, { apiKey: resolverApiKey });
			// NaN slips past a bare `type: number` schema just as easily.
			createSettingsAwareStreamFn(
				Settings.isolated({ "retry.rotateOnRateLimit": true, "retry.rotateMinSleepMs": Number.NaN }),
				base,
				binding(),
			)(stubOpenAIModel, stubContext, { apiKey: resolverApiKey });

			expect(calls[0]?.options?.rateLimitRotation?.minSleepMs).toBe(2000);
			expect(calls[1]?.options?.rateLimitRotation?.minSleepMs).toBe(2000);
		});

		describe("buildRateLimitRotationOptions (shared oneshot builder)", () => {
			it("returns undefined when the flag is off or the binding is absent", () => {
				expect(
					buildRateLimitRotationOptions(Settings.isolated({}), binding(), "openai", () => "session-42"),
				).toBeUndefined();
				expect(
					buildRateLimitRotationOptions(
						Settings.isolated({ "retry.rotateOnRateLimit": true }),
						undefined,
						"openai",
						() => "session-42",
					),
				).toBeUndefined();
			});

			it("binds the sibling probe to the caller's provider and session id, not the binding's", async () => {
				const settings = Settings.isolated({ "retry.rotateOnRateLimit": true, "retry.rotateMinSleepMs": 750 });
				const rotationBinding = binding(); // its own getSessionId says "session-42"
				const onRotated = vi.fn();
				rotationBinding.onRotated = onRotated;

				// Compaction/title oneshots resolve credentials under their own session
				// id (e.g. the advisor provider session) — the probe must read THAT
				// session's sticky, or it answers for the wrong credential pool.
				const options = buildRateLimitRotationOptions(settings, rotationBinding, "openai", () => "advisor-7");
				expect(options).toMatchObject({ enabled: true, provider: "openai", minSleepMs: 750 });
				expect(options?.onRotated).toBe(onRotated);

				await options?.hasUsableSibling();
				expect(rotationBinding.authStorage.hasUsableSibling.mock.calls).toEqual([["openai", "advisor-7"]]);
			});

			it("sanitizes a corrupt rotateMinSleepMs back to the 2000 default", () => {
				const settings = Settings.isolated({ "retry.rotateOnRateLimit": true, "retry.rotateMinSleepMs": -5 });
				expect(buildRateLimitRotationOptions(settings, binding(), "openai", () => undefined)?.minSleepMs).toBe(
					2000,
				);
			});
		});

		it("lets a caller-supplied rateLimitRotation win over the settings binding", () => {
			const settings = Settings.isolated({ "retry.rotateOnRateLimit": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base, binding());
			const callerRotation: RateLimitRotationOptions = {
				enabled: true,
				provider: "custom",
				minSleepMs: 1,
				hasUsableSibling: () => false,
			};

			wrapped(stubOpenAIModel, stubContext, { apiKey: resolverApiKey, rateLimitRotation: callerRotation });

			expect(calls[0]?.options?.rateLimitRotation).toBe(callerRotation);
		});
	});
});
