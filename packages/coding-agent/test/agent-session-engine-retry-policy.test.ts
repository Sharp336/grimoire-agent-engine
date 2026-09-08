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

	describe("profile provider routes", () => {
		function routeModels() {
			const models = [
				getBundledModel("anthropic", "claude-sonnet-4-5"),
				getBundledModel("openai", "gpt-4o-mini"),
				getBundledModel("google", "gemini-2.5-flash"),
			];
			if (models.some(model => !model)) throw new Error("Expected bundled route models");
			return models as NonNullable<(typeof models)[number]>[];
		}

		function createRouteSession(
			responses: MockResponse[],
			tools: AgentTool[] = [],
			ordered = false,
			routeOrder: readonly number[] = [0, 1, 2],
			maxRetries = ENGINE_POLICY.delaysMs.length,
		) {
			const models = routeModels();
			const selectors = routeOrder.map(index => `${models[index]!.provider}/${models[index]!.id}`);
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
					delaysMs: ENGINE_POLICY.delaysMs.slice(0, maxRetries),
					...(ordered
						? { orderedRouteFallback: { selectors } }
						: {
								sameModelRouteFallback: {
									modelIdentityId: "test-logical-model",
									selectors,
								},
							}),
				},
			});
			sessions.push(session);
			const events: AgentSessionEvent[] = [];
			session.subscribe(event => events.push(event));
			return { session, sessionManager, mock, requested, events };
		}

		it("follows an explicitly ordered mixed-model chain and never restarts it after exhaustion", async () => {
			const { session, requested, events } = createRouteSession(
				[
					{ throw: "503 route one" },
					{ throw: "503 route two" },
					{ throw: "503 route three" },
					{ throw: "503 route three again" },
				],
				[],
				true,
				[0, 1, 0, 2, 1],
			);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			await session.prompt("ordered chain");
			await session.waitForIdle();
			expect(requested).toEqual([...routeModels(), routeModels()[2]!].map(model => `${model.provider}/${model.id}`));
			expect(events.filter(event => event.type === "retry_fallback_applied")).toHaveLength(2);
			expect(events.filter(event => event.type === "profile_route_exhausted")).toEqual([
				{ type: "profile_route_exhausted", reason: "retry_budget" },
			]);
			expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
		});

		it("distinguishes an untried route at the retry budget from all routes being unavailable", async () => {
			const { session, requested, events } = createRouteSession(
				[{ throw: "503 primary" }, { throw: "503 fallback" }],
				[],
				true,
				[0, 1, 2],
				1,
			);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			await session.prompt("bounded chain");
			await session.waitForIdle();
			expect(requested).toHaveLength(2);
			expect(events.filter(event => event.type === "profile_route_exhausted")).toEqual([
				{ type: "profile_route_exhausted", reason: "retry_budget" },
			]);
		});

		it("reports a last-slot auth failure without dispatching another request", async () => {
			const { session, requested, events } = createRouteSession([{ throw: "401 Unauthorized" }], [], true, [0]);
			await session.prompt("one unavailable slot");
			await session.waitForIdle();
			expect(requested).toHaveLength(1);
			expect(events.filter(event => event.type === "profile_route_exhausted")).toEqual([
				{ type: "profile_route_exhausted", reason: "routes_unavailable" },
			]);
		});

		it.each(["503 service unavailable", "engine_provider_retry_deferred: stream retry; retry-after-ms=500"])(
			"recovers a single-slot transient failure inside the Engine budget: %s",
			async failure => {
				const { session, requested, events } = createRouteSession(
					[{ throw: failure }, { content: ["same route recovered"], stopReason: "stop" }],
					[],
					true,
					[0],
				);
				const waits: number[] = [];
				vi.spyOn(scheduler, "wait").mockImplementation(async delay => {
					waits.push(Number(delay));
				});
				await session.prompt("single slot transient");
				await session.waitForIdle();
				expect(requested).toEqual(Array(2).fill(`${routeModels()[0]!.provider}/${routeModels()[0]!.id}`));
				expect(waits.filter(delay => delay >= 3000)).toEqual([3000]);
				expect(session.getLastAssistantText()).toBe("same route recovered");
				expect(events.some(event => event.type === "profile_route_exhausted")).toBe(false);
			},
		);

		it("skips a fallback whose credential was revoked instead of hiding the next authorized model", async () => {
			const { session, requested } = createRouteSession(
				[{ throw: "503 primary" }, { content: ["third route answered"], stopReason: "stop" }],
				[],
				true,
			);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
				if (model.provider === routeModels()[1]!.provider) throw new Error("connection revoked");
				return "test-key";
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			await session.prompt("skip revoked route");
			await session.waitForIdle();
			expect(requested).toEqual(
				[routeModels()[0]!, routeModels()[2]!].map(model => `${model.provider}/${model.id}`),
			);
			expect(session.getLastAssistantText()).toBe("third route answered");
		});

		it.each([
			"OpenAI completions stream closed before a finish_reason was received",
			"engine_provider_retry_deferred: stream retry; retry-after-ms=500",
		])("does not replay committed partial output: %s", async failure => {
			const { session, requested, events } = createRouteSession(
				[
					{
						content: ["already visible"],
						stopReason: "error",
						errorMessage: failure,
					},
					{ content: ["must not run"], stopReason: "stop" },
				],
				[],
				true,
			);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			await session.prompt("partial ordered");
			await session.waitForIdle();
			expect(requested).toEqual([`${routeModels()[0]!.provider}/${routeModels()[0]!.id}`]);
			expect(events.some(event => event.type === "retry_fallback_applied")).toBe(false);
		});

		it("does not replay a failed turn containing an unresolved tool call on a different model", async () => {
			const { session, requested, events } = createRouteSession(
				[
					{
						content: [{ type: "toolCall", id: "unresolved", name: "write", arguments: {} }],
						stopReason: "error",
						errorMessage: "503 stream failed",
					},
					{ content: ["must not run"], stopReason: "stop" },
				],
				[],
				true,
			);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			await session.prompt("unresolved tool");
			await session.waitForIdle();
			expect(requested).toEqual([`${routeModels()[0]!.provider}/${routeModels()[0]!.id}`]);
			expect(events.some(event => event.type === "retry_fallback_applied")).toBe(false);
		});

		it("does not apply a route if the user stops while credentials are resolving", async () => {
			const { session, requested, events } = createRouteSession(
				[{ throw: "503 primary" }, { content: ["must not run"], stopReason: "stop" }],
				[],
				true,
			);
			const started = Promise.withResolvers<void>();
			const released = Promise.withResolvers<string>();
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
				if (model.provider !== routeModels()[1]!.provider) return "test-key";
				started.resolve();
				return released.promise;
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const prompt = session.prompt("cancel while resolving");
			await started.promise;
			const stop = session.abort({ reason: "Stop" });
			released.resolve("test-key");
			await Promise.all([prompt, stop]);
			expect(requested).toEqual([`${routeModels()[0]!.provider}/${routeModels()[0]!.id}`]);
			expect(events.some(event => event.type === "retry_fallback_applied")).toBe(false);
			expect(events.some(event => event.type === "profile_route_exhausted")).toBe(false);
		});

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

		it("spends remaining transient retries on the last eligible route without restarting the chain", async () => {
			const { session, requested } = createRouteSession([
				{ throw: "503 route one" },
				{ throw: "503 route two" },
				{ throw: "503 route three" },
				{ throw: "503 route three again" },
			]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

			await session.prompt("all down");
			await session.waitForIdle();

			expect(requested).toEqual([...routeModels(), routeModels()[2]!].map(model => `${model.provider}/${model.id}`));
		});

		it.each([false, true])(
			"continues after a settled tool boundary without repeating the side effect (ordered=%s)",
			async ordered => {
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
					ordered,
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
			},
		);

		it.each([{ routeOrder: [0] }, { routeOrder: [0, 1, 2] }])(
			"cancels route backoff without another provider request: %j",
			async ({ routeOrder }) => {
				const { session, requested } = createRouteSession(
					[{ throw: "503 service unavailable" }, { content: ["must not run"], stopReason: "stop" }],
					[],
					true,
					routeOrder,
				);
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
			},
		);
	});
});
