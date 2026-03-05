import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession handoff", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-handoff-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry,
		});

		session.subscribe(event => {
			events.push(event);
		});

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("does not run auto-compaction after handoff turn completes", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const handoffText = "## Goal\nContinue from here";
		const handoffAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: handoffText }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const promptSpy = vi.spyOn(session, "prompt").mockImplementation(async () => {
			session.agent.replaceMessages([handoffAssistant]);
			session.agent.emitExternalEvent({ type: "message_end", message: handoffAssistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [handoffAssistant] });
		});

		const result = await session.handoff();
		await Bun.sleep(20);

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("uses handoff strategy for threshold-triggered auto maintenance", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).toHaveBeenCalledWith(expect.stringContaining("Threshold-triggered maintenance"));
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", aborted: false, willRetry: false });
	});

	it("emits auto_compaction_end error when handoff strategy returns no document", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue(undefined);

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({
			type: "auto_compaction_end",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("saves handoff document to disk when enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const handoffText = "## Goal\nContinue from here";
		const handoffAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: handoffText }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		vi.spyOn(session, "prompt").mockImplementation(async () => {
			session.agent.replaceMessages([handoffAssistant]);
			session.agent.emitExternalEvent({ type: "message_end", message: handoffAssistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [handoffAssistant] });
		});

		const result = await session.handoff();
		expect(result?.savedPath).toBeDefined();
		if (!result?.savedPath) throw new Error("Expected handoff document path");
		expect(result.savedPath.endsWith(".md")).toBe(true);
		const savedText = await Bun.file(result.savedPath).text();
		expect(savedText).toContain(handoffText);
	});
});
