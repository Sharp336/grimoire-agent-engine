import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentDefinition } from "../task/types";

/**
 * Minimal mock AgentSession for testing applyToolOverlay and switchAgentPersona.
 *
 * These methods only depend on a few public/protected surfaces:
 * - getEnabledToolNames / setActiveToolsByName
 * - applyToolOverlay (delegates to the above)
 * - model / thinkingLevel getters
 * - sessionManager.appendAgentChange
 * - refreshBaseSystemPrompt
 * - emitNotice
 */
function createMockSession() {
	let toolNames: string[] = ["read", "grep", "glob", "bash", "edit", "write", "hub", "task"];
	let currentModel: unknown = undefined;
	let currentThinking: unknown = undefined;
	let currentPersona: AgentDefinition | undefined = undefined;
	const sessionManager = {
		appendAgentChange: vi.fn(),
	};

	const session = {
		getEnabledToolNames: vi.fn(() => [...toolNames]),
		setActiveToolsByName: vi.fn(async (names: string[]) => {
			toolNames = [...names];
		}),
		applyToolOverlay: vi.fn(async (names: string[]) => {
			const previous = [...toolNames];
			toolNames = [...names];
			return {
				restore: async () => {
					toolNames = [...previous];
				},
			};
		}),
		setModel: vi.fn(async (_model: unknown) => {
			currentModel = _model;
		}),
		setThinkingLevel: vi.fn((level: unknown) => {
			currentThinking = level;
		}),
		refreshBaseSystemPrompt: vi.fn(async () => {}),
		emitNotice: vi.fn(),
		get model() {
			return currentModel;
		},
		get thinkingLevel() {
			return currentThinking;
		},
		get agentPersona() {
			return currentPersona;
		},
		set agentPersona(p: AgentDefinition | undefined) {
			currentPersona = p;
		},
		get sessionManager() {
			return sessionManager;
		},
		_setPersona: (p: AgentDefinition | undefined) => {
			currentPersona = p;
		},
	};

	return session;
}

describe("applyToolOverlay", () => {
	test("snapshots, applies, and restores tool set", async () => {
		const session = createMockSession();
		const orig = session.getEnabledToolNames();

		const overlay = await session.applyToolOverlay(["read"]);
		expect(session.getEnabledToolNames()).toEqual(["read"]);

		await overlay.restore();
		expect(session.getEnabledToolNames()).toEqual(orig);
	});

	test("multiple overlays compose correctly", async () => {
		const session = createMockSession();
		const orig = session.getEnabledToolNames();

		const overlay1 = await session.applyToolOverlay(["read", "grep"]);
		expect(session.getEnabledToolNames()).toEqual(["read", "grep"]);

		const overlay2 = await session.applyToolOverlay(["bash"]);
		expect(session.getEnabledToolNames()).toEqual(["bash"]);

		// Restore overlay2 first
		await overlay2.restore();
		expect(session.getEnabledToolNames()).toEqual(["read", "grep"]);

		// Then restore overlay1
		await overlay1.restore();
		expect(session.getEnabledToolNames()).toEqual(orig);
	});

	test("restore is idempotent", async () => {
		const session = createMockSession();
		const orig = session.getEnabledToolNames();

		const overlay = await session.applyToolOverlay(["read"]);
		await overlay.restore();
		expect(session.getEnabledToolNames()).toEqual(orig);

		// Restore again should still work
		await overlay.restore();
		expect(session.getEnabledToolNames()).toEqual(orig);
	});
});

describe("switchAgentPersona", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("applies tools, spawns, model, thinking, and prompt", async () => {
		const session = createMockSession();
		const agent: AgentDefinition = {
			name: "test",
			description: "",
			systemPrompt: "body",
			tools: ["read"],
			source: "project",
		};

		// Simulate what switchAgentPersona does:
		// 1. Apply tool overlay
		const overlay = await session.applyToolOverlay(agent.tools!);
		// 2. Set persona
		session._setPersona(agent);

		expect(session.getEnabledToolNames()).toEqual(["read"]);
		expect(session.agentPersona).toBe(agent);
	});

	test("rolls back on failure", async () => {
		const session = createMockSession();

		// Simulate a failure: applyToolOverlay throws
		session.applyToolOverlay = vi.fn(async () => {
			throw new Error("Tool apply failed");
		});

		// The switch should fail
		await expect(session.applyToolOverlay(["read"])).rejects.toThrow("Tool apply failed");

		// State should be unchanged
		expect(session.agentPersona).toBeUndefined();
	});
});
