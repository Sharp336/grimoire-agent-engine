/**
 * Integration coverage for the real AgentSession skill-discovery gate.
 *
 * The BM25 unit tests exercise hand-rolled mock sessions; they never touch the
 * actual `AgentSession.isSkillDiscoveryEnabled()` / `getDiscoverableTools()`
 * implementations. This file pins three integration seams at the class level:
 *
 *   (a) `isSkillDiscoveryEnabled()` returns false when the frozen
 *       `#deferredSkillEntries` set is empty — even when the live
 *       `skills.redactDescriptions` flag is true.
 *   (b) `getDiscoverableTools()` returns deferred skill entries even under
 *       `discoveryMode:"off"` (the effective default for an empty registry),
 *       and honors the `{ source: "skill" }` filter.
 *   (c) A mid-session toggle of `skills.redactDescriptions` changes the gate
 *       outcome (because the gate reads live settings) without mutating the
 *       frozen deferred set returned by `getDiscoverableTools()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { DiscoverableTool } from "@oh-my-pi/pi-coding-agent/tool-discovery/tool-index";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession skill discovery gate", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-skill-discovery-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	/**
	 * Build a real AgentSession with the supplied settings overrides and deferred
	 * skill entries. Each call gets its own `Settings` instance so runtime
	 * `override()` writes in one test cannot leak into siblings. The settings
	 * reference is returned so tests can mutate it mid-session.
	 */
	async function createSession(options: {
		settingsOverrides?: Partial<Record<"skills.redactDescriptions" | "tools.discoveryMode", unknown>>;
		deferredSkillEntries?: readonly DiscoverableTool[];
		skillsSettings?: { redactDescriptions?: boolean };
	}): Promise<{ session: AgentSession; settings: Settings }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: () => new AssistantMessageEventStream(),
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(options.settingsOverrides ?? {});
		const authStorage = await AuthStorage.create(path.join(tempDir, `testauth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, `models-${Snowflake.next()}.yml`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			deferredSkillEntries: options.deferredSkillEntries,
			skillsSettings: options.skillsSettings,
		});
		sessions.push(session);

		return { session, settings };
	}

	function makeDeferredSkill(overrides?: Partial<DiscoverableTool>): DiscoverableTool {
		return {
			name: "my-skill",
			label: "my-skill",
			summary: "test skill",
			source: "skill",
			schemaKeys: [],
			...overrides,
		};
	}

	it("isSkillDiscoveryEnabled returns false when deferredSkillEntries is empty", async () => {
		// The flag is genuinely on; the gate must still return false purely
		// because the frozen deferred set is empty.
		const { session } = await createSession({
			settingsOverrides: { "skills.redactDescriptions": true },
			deferredSkillEntries: [],
			skillsSettings: { redactDescriptions: true },
		});

		expect(session.settings.get("skills.redactDescriptions")).toBe(true);
		expect(session.isSkillDiscoveryEnabled()).toBe(false);
	});

	it("isSkillDiscoveryEnabled gate is driven by both the flag and a non-empty deferred set", async () => {
		// Guards against (a) being a tautology: prove the gate also reacts to the
		// flag and to a non-empty set, so the false result above is "false because
		// empty" rather than "always false".

		// flag true + non-empty deferred set → enabled.
		const enabled = await createSession({
			settingsOverrides: { "skills.redactDescriptions": true },
			deferredSkillEntries: [makeDeferredSkill()],
		});
		expect(enabled.session.isSkillDiscoveryEnabled()).toBe(true);

		// flag false + non-empty deferred set → disabled (flag gates it).
		const flagOff = await createSession({
			settingsOverrides: { "skills.redactDescriptions": false },
			deferredSkillEntries: [makeDeferredSkill()],
		});
		expect(flagOff.session.isSkillDiscoveryEnabled()).toBe(false);
	});

	it("getDiscoverableTools includes deferred skills even under discoveryMode:'off'", async () => {
		const deferredEntry = makeDeferredSkill();
		const { session } = await createSession({
			// Pin discoveryMode explicitly so the assertion does not depend on the
			// empty-registry auto-resolution path.
			settingsOverrides: { "tools.discoveryMode": "off" },
			deferredSkillEntries: [deferredEntry],
		});

		// Deferred entries are appended unconditionally; they must survive the
		// mode-gate that empties builtin/MCP tools under discoveryMode:"off".
		const tools = session.getDiscoverableTools();
		expect(tools.some(t => t.name === "my-skill")).toBe(true);

		// Source filter narrows to the skill entry only.
		const skillsOnly = session.getDiscoverableTools({ source: "skill" });
		expect(skillsOnly).toHaveLength(1);
		expect(skillsOnly[0].name).toBe("my-skill");
		expect(skillsOnly[0].source).toBe("skill");
	});

	it("mid-session redactDescriptions toggle flips the gate without mutating the frozen deferred set", async () => {
		const deferredEntry = makeDeferredSkill();
		// Start with the flag explicitly off so the initial assertion is meaningful.
		const { session, settings } = await createSession({
			settingsOverrides: { "skills.redactDescriptions": false, "tools.discoveryMode": "off" },
			deferredSkillEntries: [deferredEntry],
		});

		// Flag off + non-empty deferred set → gate closed; entries still surface.
		expect(session.isSkillDiscoveryEnabled()).toBe(false);
		const before = session.getDiscoverableTools();
		expect(before.some(t => t.name === "my-skill")).toBe(true);

		// Toggle the live flag on (runtime override, not persisted).
		settings.override("skills.redactDescriptions", true);

		// The gate reads live settings → now open.
		expect(session.isSkillDiscoveryEnabled()).toBe(true);

		// The deferred set is frozen at init; getDiscoverableTools never reads
		// redactDescriptions, so the discoverable set is unchanged by the toggle.
		const after = session.getDiscoverableTools();
		expect(after).toEqual(before);

		// Toggling back off re-closes the gate, still without touching the set.
		settings.override("skills.redactDescriptions", false);
		expect(session.isSkillDiscoveryEnabled()).toBe(false);
		expect(session.getDiscoverableTools()).toEqual(before);
	});
});
