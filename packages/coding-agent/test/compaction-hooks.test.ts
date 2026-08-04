/**
 * Tests for compaction hook events (before_compact / compact).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
	SessionEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Compaction hooks", () => {
	let session: AgentSession;
	let tempDir: string;
	let capturedEvents: SessionEvent[];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `omp-compaction-hooks-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		capturedEvents = [];
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	function createHook(
		onBeforeCompact?: (event: SessionBeforeCompactEvent) => SessionBeforeCompactResult | undefined,
		onCompact?: (event: SessionCompactEvent) => void,
	): ExtensionFactory {
		return pi => {
			pi.on("session_before_compact", event => {
				capturedEvents.push(event);
				return onBeforeCompact?.(event);
			});
			pi.on("session_compact", event => {
				capturedEvents.push(event);
				onCompact?.(event);
			});
		};
	}

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
			initialState: {
				model,
				systemPrompt: ["You are a helpful assistant. Be concise."],
				tools,
			},
		});

		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);

		const extensionRuntime = new ExtensionRuntime();
		const eventBus = new EventBus();
		const extensions = await Promise.all(
			extensionFactories.map((factory, index) =>
				loadExtensionFromFactory(factory, tempDir, eventBus, extensionRuntime, `test-hook-${index}`),
			),
		);
		const extensionRunner = new ExtensionRunner(extensions, extensionRuntime, tempDir, sessionManager, modelRegistry);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			extensionRunner,
			modelRegistry,
		});

		return session;
	}

	it("should emit before_compact and compact events", async () => {
		const hook = createHook();
		await createSession([hook]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const beforeCompactEvents = capturedEvents.filter(
			(e): e is SessionBeforeCompactEvent => e.type === "session_before_compact",
		);
		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");

		expect(beforeCompactEvents.length).toBe(1);
		expect(compactEvents.length).toBe(1);

		const beforeEvent = beforeCompactEvents[0];
		expect(beforeEvent.preparation).toBeDefined();
		expect(beforeEvent.preparation.messagesToSummarize).toBeDefined();
		expect(beforeEvent.preparation.turnPrefixMessages).toBeDefined();
		expect(typeof beforeEvent.preparation.isSplitTurn).toBe("boolean");
		expect(beforeEvent.branchEntries).toBeDefined();
		// sessionManager, modelRegistry, and model are now on ctx, not event

		const afterEvent = compactEvents[0];
		expect(afterEvent.compactionEntry).toBeDefined();
		expect(afterEvent.fromExtension).toBe(false);
	}, 120000);

	it("should allow hooks to cancel compaction", async () => {
		const hook = createHook(() => ({ cancel: true }));
		await createSession([hook]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await expect(session.compact()).rejects.toThrow("Compaction cancelled");

		const compactEvents = capturedEvents.filter(e => e.type === "session_compact");
		expect(compactEvents.length).toBe(0);
	}, 120000);

	it("should allow hooks to provide custom compaction", async () => {
		const customSummary = "Custom summary from hook";

		const hook = createHook(event => {
			if (event.type === "session_before_compact") {
				return {
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}
			return undefined;
		});
		await createSession([hook]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);

		const compactEvents = capturedEvents.filter(e => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		const afterEvent = compactEvents[0];
		if (afterEvent.type === "session_compact") {
			expect(afterEvent.compactionEntry.summary).toBe(customSummary);
			expect(afterEvent.fromExtension).toBe(true);
		}
	}, 120000);

	it("should include entries in compact event after compaction is saved", async () => {
		const hook = createHook();
		await createSession([hook]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		const compactEvents = capturedEvents.filter(e => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);

		const afterEvent = compactEvents[0];
		if (afterEvent.type === "session_compact") {
			// sessionManager is now on ctx, use session.sessionManager directly
			const entries = session.sessionManager.getEntries();
			const hasCompactionEntry = entries.some((e: { type: string }) => e.type === "compaction");
			expect(hasCompactionEntry).toBe(true);
		}
	}, 120000);

	it("should continue with default compaction if hook throws error", async () => {
		const throwingHook: ExtensionFactory = pi => {
			pi.on("session_before_compact", event => {
				capturedEvents.push(event);
				throw new Error("Hook intentionally throws");
			});
			pi.on("session_compact", event => {
				capturedEvents.push(event);
			});
		};

		await createSession([throwingHook]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBeDefined();

		const compactEvents = capturedEvents.filter((e): e is SessionCompactEvent => e.type === "session_compact");
		expect(compactEvents.length).toBe(1);
		expect(compactEvents[0].fromExtension).toBe(false);
	}, 120000);

	it("should call multiple hooks in order", async () => {
		const callOrder: string[] = [];

		const hook1: ExtensionFactory = pi => {
			pi.on("session_before_compact", () => {
				callOrder.push("hook1-before");
			});
			pi.on("session_compact", () => {
				callOrder.push("hook1-after");
			});
		};

		const hook2: ExtensionFactory = pi => {
			pi.on("session_before_compact", () => {
				callOrder.push("hook2-before");
			});
			pi.on("session_compact", () => {
				callOrder.push("hook2-after");
			});
		};

		await createSession([hook1, hook2]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(callOrder).toEqual(["hook1-before", "hook2-before", "hook1-after", "hook2-after"]);
	}, 120000);

	it("should pass correct data in before_compact event", async () => {
		let capturedBeforeEvent: SessionBeforeCompactEvent | null = null;

		const hook = createHook(event => {
			capturedBeforeEvent = event;
			return undefined;
		});
		await createSession([hook]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.compact();

		expect(capturedBeforeEvent).not.toBeNull();
		const event = capturedBeforeEvent!;
		expect(typeof event.preparation.isSplitTurn).toBe("boolean");
		expect(event.preparation.firstKeptEntryId).toBeDefined();

		expect(Array.isArray(event.preparation.messagesToSummarize)).toBe(true);
		expect(Array.isArray(event.preparation.turnPrefixMessages)).toBe(true);

		expect(typeof event.preparation.tokensBefore).toBe("number");

		expect(Array.isArray(event.branchEntries)).toBe(true);

		// sessionManager, modelRegistry, and model are now on ctx, not event
		// Verify they're accessible via session
		expect(typeof session.sessionManager.getEntries).toBe("function");
		expect(typeof session.modelRegistry.getApiKey).toBe("function");
	}, 120000);

	it("should use hook compaction even with different values", async () => {
		const customSummary = "Custom summary with modified values";

		const hook = createHook(event => {
			if (event.type === "session_before_compact") {
				return {
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: 999,
					},
				};
			}
			return undefined;
		});
		await createSession([hook]);

		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		const result = await session.compact();

		expect(result.summary).toBe(customSummary);
		expect(result.tokensBefore).toBe(999);
	}, 120000);
});
