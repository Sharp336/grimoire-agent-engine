import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

const QUOTA_RESET_MOCK_API_SOURCE = "agent-session-quota-reset-test";

// A fixed past date would fall through the hint sanity clamp (reset already
// elapsed → undefined), so stamp the reset moment ~3h17m into the future as
// Beijing wall-clock — the exact shape of Zhipu Coding Plan's 429 type=1308
// body, whose timestamp carries no explicit zone marker.
const RESET_AT_MS = Date.now() + (3 * 60 + 17) * 60 * 1000;
const QUOTA_RESET_RETRY_BUFFER_MS = 3_000;

function beijingWallClock(ms: number): string {
	// Manual formatting: Intl "sv-SE" emits `21.51.10` (dotted time) in some ICU
	// builds, which would not match the provider wording under test.
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(ms));
	const get = (type: string) => parts.find(part => part.type === type)?.value ?? "00";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

const ZHIPU_1308_ERROR = `429 已达到 5 小时的使用上限。您的限额将在 ${beijingWallClock(RESET_AT_MS)} 重置。 (type=1308)`;

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

/**
 * Contract: a usage-limit error body stating an absolute reset timestamp is
 * parsed into the exact wait-to-resume delay (stated moment +3s grace). The
 * wait still honors `retry.maxDelayMs`: operators who want multi-hour
 * auto-resume disable/raise the cap in their own config; with a tight cap the
 * fail-fast behavior is unchanged — there is no per-hint code exemption.
 */
describe("AgentSession quota-reset auto-resume", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-quota-reset-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(async () => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		await authStorage.remove("zhipu-coding-plan");
		authStorage.removeRuntimeApiKey("zhipu-coding-plan");
		authStorage.setRuntimeApiKey("zhipu-coding-plan", "zhipu-test-key");
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		unregisterCustomApis(QUOTA_RESET_MOCK_API_SOURCE);
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("sleeps until the stated reset time and resumes when retry.maxDelayMs is unlimited", async () => {
		const model = getBundledModel("zhipu-coding-plan", "glm-4.7");
		if (!model) {
			throw new Error("Expected bundled zhipu-coding-plan test model to exist");
		}

		// Mock responses: the 1308 error, then the post-reset recovery turn.
		const mock = createMockModel({
			provider: model.provider,
			responses: [
				{ throw: ZHIPU_1308_ERROR },
				{ content: [{ type: "text", text: "resumed after quota reset" }], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 0, // no cap: unattended auto-resume waits for the stated moment
			"retry.maxRetries": 3,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger zhipu quota exhaustion");
		await session.waitForIdle();

		// The stated reset moment (parsed as Beijing time) + 3s grace
		// (RESET_AT_BUFFER_MS) — not the credential store's default 60s
		// usage-limit block (AuthStorage.#defaultBackoffMs), and not a
		// fail-fast terminal.
		const delayMs = retryStartEvents[0].delayMs;
		const expectedDelta = RESET_AT_MS - Date.now() + QUOTA_RESET_RETRY_BUFFER_MS;
		// ±5s tolerance for when the turn ran relative to these assertions.
		expect(Math.abs(delayMs - expectedDelta)).toBeLessThan(5_000);
		expect(waitSpy.mock.calls.some(call => Math.abs((call[0] as number) - delayMs) < 5_000)).toBe(true);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "resumed after quota reset",
		});
		expect(session.isRetrying).toBe(false);
	});

	it("still fail-fasts on the same body when retry.maxDelayMs is tight", async () => {
		const model = getBundledModel("zhipu-coding-plan", "glm-4.7");
		if (!model) {
			throw new Error("Expected bundled zhipu-coding-plan test model to exist");
		}

		const mock = createMockModel({ provider: model.provider, handler: () => ({ throw: ZHIPU_1308_ERROR }) });
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 60_000,
			"retry.maxRetries": 3,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger quota reset error under a tight retry cap");
		await session.waitForIdle();

		// No code exemption: the parsed multi-hour wait exceeds the cap and
		// fails fast, exactly as before. Auto-resume is config-gated.
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(60_000);
		}
		expect(session.isRetrying).toBe(false);
	});
});
