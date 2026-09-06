import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TurnRetryPolicy } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	createProviderRetryBudgetHook,
	withProviderRetryBudget,
} from "@oh-my-pi/pi-coding-agent/session/provider-retry-budget";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const ENGINE_POLICY: TurnRetryPolicy = {
	delaysMs: [3_000, 15_000, 30_000],
	sharedFallbackBudget: true,
	transientOnly: true,
	exactSchedule: true,
	allowRetryAfterBeyondMaxDelay: true,
	deferNestedProviderRetries: true,
};

describe("Engine bounded turn retry policy", () => {
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-engine-retry-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
		authStorage.setRuntimeApiKey("openai", "test-key");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		authStorage.removeRuntimeApiKey("anthropic");
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	function createSession(responses: MockResponse[]): {
		session: AgentSession;
		mock: ReturnType<typeof createMockModel>;
		events: AgentSessionEvent[];
	} {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ responses });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"retry.maxDelayMs": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			turnRetryPolicy: ENGINE_POLICY,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		sessions.push(session);
		return { session, mock, events };
	}

	it("uses exactly three retries at 3/15/30 seconds and reports exhaustion", async () => {
		const { session, mock, events } = createSession([
			{ throw: "503 service unavailable" },
			{ throw: "503 service unavailable" },
			{ throw: "503 service unavailable" },
			{ throw: "503 service unavailable" },
		]);
		const waits: number[] = [];
		vi.spyOn(scheduler, "wait").mockImplementation(async delay => {
			waits.push(Number(delay));
		});

		await session.prompt("retry");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(waits.filter(delay => delay >= 3_000)).toEqual([3_000, 15_000, 30_000]);
		expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(3);
		const end = events.findLast(event => event.type === "auto_retry_end");
		expect(end).toMatchObject({ type: "auto_retry_end", success: false, attempt: 3 });
		expect(session.getLastAssistantMessage()?.errorMessage).toContain("Retry budget exhausted after 3 retries");
	});

	it("keeps model fallback inside the same three-retry budget", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const models = [
			getBundledModel("anthropic", "claude-sonnet-4-5"),
			getBundledModel("openai", "gpt-4o-mini"),
			getBundledModel("openai", "gpt-4o"),
			getBundledModel("anthropic", "claude-haiku-4-5"),
			getBundledModel("anthropic", "claude-opus-4-1"),
		];
		if (models.some(model => !model)) throw new Error("Expected bundled fallback models");
		const [primary, ...fallbacks] = models as NonNullable<(typeof models)[number]>[];
		const requested: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				mock.push({ throw: "503 service unavailable" });
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: fallbacks.map(model => `${model.provider}/${model.id}`) },
			"retry.maxDelayMs": 1,
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			turnRetryPolicy: ENGINE_POLICY,
		});
		sessions.push(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("fallback");
		await session.waitForIdle();

		expect(requested).toEqual(models.slice(0, 4).map(model => `${model!.provider}/${model!.id}`));
		expect(requested).not.toContain(`${fallbacks[3]!.provider}/${fallbacks[3]!.id}`);
		expect(session.getLastAssistantMessage()?.errorMessage).toContain("Retry budget exhausted after 3 retries");
	});

	it("keeps scheduled recovery to four physical calls with a fresh per-request budget", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		let physicalRequests = 0;
		const hook = createProviderRetryBudgetHook();
		const mock = createMockModel({
			handler: async () => {
				const fetch = hook.wrapFetch(model, async () => {
					physicalRequests += 1;
					return new Response("busy", { status: 503 });
				});
				const error = await fetch("https://example.invalid/provider").catch(reason => reason);
				return { throw: String(error) };
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"retry.maxDelayMs": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) =>
				withProviderRetryBudget(4, () => mock.stream(requestedModel, context, options)),
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			turnRetryPolicy: ENGINE_POLICY,
		});
		sessions.push(session);
		const waits: number[] = [];
		vi.spyOn(scheduler, "wait").mockImplementation(async delay => {
			waits.push(Number(delay));
		});

		await session.prompt("physical budget");
		await session.waitForIdle();

		expect(physicalRequests).toBe(4);
		expect(waits.filter(delay => delay >= 3_000)).toEqual([3_000, 15_000, 30_000]);
		expect(session.getLastAssistantMessage()?.errorMessage).toContain("Retry budget exhausted after 3 retries");
	});

	it("resets the physical budget across more than four successful tool turns", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const noopTool: AgentTool = {
			name: "noop",
			label: "No-op",
			description: "Completes a test tool turn",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		};
		const responses: MockResponse[] = Array.from({ length: 6 }, (_, index) => ({
			content: [{ type: "toolCall" as const, id: `noop-${index}`, name: "noop", arguments: {} }],
			stopReason: "toolUse" as const,
		}));
		responses.push({ content: ["done"], stopReason: "stop" });
		const mock = createMockModel({ responses });
		const hook = createProviderRetryBudgetHook();
		const physicalCalls: Promise<Response>[] = [];
		let physicalRequests = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [noopTool], messages: [] },
			streamFn: (requestedModel, context, options) =>
				withProviderRetryBudget(4, () => {
					const fetch = hook.wrapFetch(requestedModel, async () => {
						physicalRequests += 1;
						return new Response("ok");
					});
					physicalCalls.push(fetch("https://example.invalid/provider"));
					return mock.stream(requestedModel, context, options);
				}),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.modelFallback": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			turnRetryPolicy: ENGINE_POLICY,
		});
		sessions.push(session);

		await session.prompt("run six tools");
		await session.waitForIdle();
		await Promise.all(physicalCalls);

		expect(mock.calls).toHaveLength(7);
		expect(physicalRequests).toBe(7);
		expect(session.getLastAssistantText()).toBe("done");
	});

	it("treats Retry-After as a lower bound beyond the interactive delay ceiling", async () => {
		const { session } = createSession([
			{ throw: "503 service unavailable retry-after-ms=9000" },
			{ content: ["ok"], stopReason: "stop" },
		]);
		const waits: number[] = [];
		vi.spyOn(scheduler, "wait").mockImplementation(async delay => {
			waits.push(Number(delay));
		});

		await session.prompt("retry-after");
		await session.waitForIdle();

		expect(waits.filter(delay => delay >= 3_000)).toEqual([9_000]);
		expect(session.getLastAssistantText()).toBe("ok");
	});

	it("does not retry authentication or account policy failures", async () => {
		for (const failure of ["401 Unauthorized", "This content was blocked by account policy (code=cyber_policy)"]) {
			const { session, mock, events } = createSession([{ throw: failure }]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			await session.prompt(failure);
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(1);
			expect(events.some(event => event.type === "auto_retry_start")).toBe(false);
		}
	});

	it("aborts a pending delay without issuing the late retry", async () => {
		const { session, mock, events } = createSession([
			{ throw: "503 service unavailable" },
			{ content: ["must not run"], stopReason: "stop" },
		]);
		const waiting = Promise.withResolvers<void>();
		vi.spyOn(scheduler, "wait").mockImplementation((delay, options) => {
			if (Number(delay) < 3_000) return Promise.resolve();
			waiting.resolve();
			return new Promise((_, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		});

		const prompt = session.prompt("cancel");
		await waiting.promise;
		await session.abort({ reason: "Stop" });
		await prompt;

		expect(mock.calls).toHaveLength(1);
		expect(events.findLast(event => event.type === "auto_retry_end")).toMatchObject({
			type: "auto_retry_end",
			success: false,
			finalError: "Retry cancelled",
		});
	});

	describe("same-model provider routes", () => {
		function routeModels() {
			const models = [
				getBundledModel("anthropic", "claude-sonnet-4-5"),
				getBundledModel("openai", "gpt-4o-mini"),
				getBundledModel("google", "gemini-2.5-flash"),
			];
			if (models.some(model => !model)) throw new Error("Expected bundled route models");
			return models as NonNullable<(typeof models)[number]>[];
		}

		function createRouteSession(responses: MockResponse[], tools: AgentTool[] = []) {
			const models = routeModels();
			for (const model of models) authStorage.setRuntimeApiKey(model.provider, "test-key");
			const requested: string[] = [];
			const mock = createMockModel({ responses });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: models[0], systemPrompt: ["Test"], tools, messages: [] },
				convertToLlm,
				streamFn: (model, context, options) => {
					requested.push(`${model.provider}/${model.id}`);
					return mock.stream(model, context, options);
				},
			});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.modelFallback": false,
				"retry.maxDelayMs": 1,
			});
			const sessionManager = SessionManager.inMemory();
			const session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry,
				turnRetryPolicy: {
					...ENGINE_POLICY,
					sameModelRouteFallback: {
						modelIdentityId: "test-logical-model",
						selectors: models.map(model => `${model.provider}/${model.id}`),
					},
				},
			});
			sessions.push(session);
			return { session, sessionManager, mock, requested };
		}

		it("moves to the next configured route before any output and never cycles", async () => {
			const { session, requested } = createRouteSession([
				{ throw: "503 service unavailable" },
				{ content: ["ok"], stopReason: "stop" },
			]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("route");
			await session.waitForIdle();

			expect(requested).toEqual(
				routeModels()
					.slice(0, 2)
					.map(model => `${model.provider}/${model.id}`),
			);
			expect(session.getLastAssistantText()).toBe("ok");
		});

		it("uses the next provider instead of retrying an account-scoped authentication failure", async () => {
			const { session, requested } = createRouteSession([
				{ throw: "401 Unauthorized" },
				{ content: ["authenticated"], stopReason: "stop" },
			]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("auth route");
			await session.waitForIdle();

			expect(requested).toEqual(
				routeModels()
					.slice(0, 2)
					.map(model => `${model.provider}/${model.id}`),
			);
			expect(session.getLastAssistantText()).toBe("authenticated");
		});

		it("preserves partial text behind a hidden developer continuation boundary", async () => {
			const { session, sessionManager, mock, requested } = createRouteSession([
				{
					content: ["preserved prefix"],
					stopReason: "error",
					errorMessage: "OpenAI completions stream closed before a finish_reason was received",
				},
				{ content: ["continued suffix"], stopReason: "stop" },
			]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("partial");
			await session.waitForIdle();

			expect(requested).toEqual(
				routeModels()
					.slice(0, 2)
					.map(model => `${model.provider}/${model.id}`),
			);
			const retryContext = mock.calls[1]?.context.messages ?? [];
			expect(retryContext.some(message => message.role === "assistant")).toBe(true);
			expect(JSON.stringify(retryContext.findLast(message => message.role === "developer")?.content)).toContain(
				"resume where stopped",
			);
			expect(retryContext.filter(message => message.role === "user")).toHaveLength(1);
			expect(session.getLastAssistantText()).toBe("continued suffix");
			const rebuilt = sessionManager.buildSessionContext().messages;
			expect(
				rebuilt.some(
					message =>
						message.role === "assistant" &&
						message.retryRecovery?.recovery === "route" &&
						message.retryRecovery.preserveInContext === true,
				),
			).toBe(true);
		});

		it("routes a reasonless partial abort while preserving its history boundary", async () => {
			const { session, mock, requested } = createRouteSession([
				{
					content: ["abort prefix"],
					stopReason: "aborted",
					errorMessage: "Request was aborted.",
				},
				{ content: ["abort suffix"], stopReason: "stop" },
			]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("reasonless abort");
			await session.waitForIdle();

			expect(requested).toEqual(
				routeModels()
					.slice(0, 2)
					.map(model => `${model.provider}/${model.id}`),
			);
			const retryContext = mock.calls[1]?.context.messages ?? [];
			expect(retryContext.some(message => message.role === "assistant")).toBe(true);
			expect(retryContext.filter(message => message.role === "user")).toHaveLength(1);
		});

		it("stops after the last eligible route", async () => {
			const { session, requested } = createRouteSession([
				{ throw: "503 route one" },
				{ throw: "503 route two" },
				{ throw: "503 route three" },
			]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("all down");
			await session.waitForIdle();

			expect(requested).toEqual(routeModels().map(model => `${model.provider}/${model.id}`));
		});

		it("continues after a settled tool boundary without repeating the side effect", async () => {
			let executions = 0;
			const tool: AgentTool = {
				name: "settle_once",
				label: "Settle once",
				description: "Records one deterministic side effect",
				parameters: type({}),
				execute: async () => {
					executions += 1;
					return { content: [{ type: "text", text: "settled" }] };
				},
			};
			const { session, mock, requested } = createRouteSession(
				[
					{
						content: [{ type: "toolCall", id: "settled-call", name: "settle_once", arguments: {} }],
						stopReason: "toolUse",
					},
					{ throw: "503 after the settled tool boundary" },
					{ content: ["done"], stopReason: "stop" },
				],
				[tool],
			);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("tool boundary");
			await session.waitForIdle();

			expect(requested).toEqual([
				`${routeModels()[0]!.provider}/${routeModels()[0]!.id}`,
				`${routeModels()[0]!.provider}/${routeModels()[0]!.id}`,
				`${routeModels()[1]!.provider}/${routeModels()[1]!.id}`,
			]);
			expect(executions).toBe(1);
			const retryContext = mock.calls[2]?.context.messages ?? [];
			expect(retryContext.some(message => message.role === "toolResult")).toBe(true);
			expect(retryContext.filter(message => message.role === "user")).toHaveLength(1);
		});

		it("cancels route backoff without calling the next provider", async () => {
			const { session, requested } = createRouteSession([
				{ throw: "503 service unavailable" },
				{ content: ["must not run"], stopReason: "stop" },
			]);
			const waiting = Promise.withResolvers<void>();
			vi.spyOn(scheduler, "wait").mockImplementation((delay, options) => {
				if (Number(delay) < 3_000) return Promise.resolve();
				waiting.resolve();
				return new Promise((_, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				});
			});

			const prompt = session.prompt("cancel route");
			await waiting.promise;
			await session.abort({ reason: "Stop" });
			await prompt;

			expect(requested).toEqual([`${routeModels()[0]!.provider}/${routeModels()[0]!.id}`]);
		});
	});
});
