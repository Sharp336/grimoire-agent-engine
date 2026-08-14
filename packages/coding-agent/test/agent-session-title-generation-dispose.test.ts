import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

interface TitleHarness {
	session: AgentSession;
	providerSessionId: string;
	/** Resolves once the provider request is entered. */
	started: Promise<void>;
	/** The signal actually handed to the provider request. */
	requestSignal: () => AbortSignal | undefined;
	getApiKey: Mock<ModelRegistry["getApiKey"]>;
	resolver: Mock<ModelRegistry["resolver"]>;
}

/**
 * Live session whose title requests are intercepted: the request only settles when its signal
 * aborts, so a test can prove cancellation reaches the provider rather than merely abandoning it.
 */
async function titleHarness(): Promise<TitleHarness> {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const providerSessionId = "provider-session";
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"providers.tinyModel": "online",
	});
	settings.overrideModelRoles({ smol: `${model.provider}/${model.id}` });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
	});
	const modelRegistry = new ModelRegistry(authStorage);
	const getApiKey = vi.spyOn(modelRegistry, "getApiKey");
	const resolver = vi.spyOn(modelRegistry, "resolver");
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
		providerSessionId,
	});
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<ai.AssistantMessage>();
	let requestSignal: AbortSignal | undefined;
	vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
		requestSignal = options?.signal;
		requestSignal?.addEventListener("abort", () => response.resolve(createAssistantMessage("")), { once: true });
		started.resolve();
		return response.promise;
	});
	return {
		session,
		providerSessionId,
		started: started.promise,
		requestSignal: () => requestSignal,
		getApiKey,
		resolver,
	};
}

describe("AgentSession title generation disposal", () => {
	it("uses the active provider session and aborts an in-flight title request during disposal", async () => {
		const harness = await titleHarness();

		const generation = harness.session.generateTitle("Investigate shutdown");
		await harness.started;
		expect(harness.getApiKey.mock.calls[0]?.[1]).toBe(harness.providerSessionId);
		expect(harness.resolver.mock.calls[0]?.[1]).toBe(harness.providerSessionId);
		harness.session.beginDispose();

		expect(harness.requestSignal()?.aborted).toBe(true);
		expect(await generation).toBeNull();
	});

	it("aborts the provider request when a caller-supplied signal fires", async () => {
		const harness = await titleHarness();
		const caller = new AbortController();

		// Council names its plan file through this path and gives up after a budget; abandoning the
		// promise would leave the request streaming and billing a title nobody reads.
		const generation = harness.session.generateTitle("Name the council plan", caller.signal);
		await harness.started;
		expect(harness.requestSignal()?.aborted).toBe(false);

		caller.abort();

		expect(harness.requestSignal()?.aborted).toBe(true);
		expect(await generation).toBeNull();
	});
});
