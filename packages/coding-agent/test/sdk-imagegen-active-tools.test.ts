import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Core contract of the imagegen.enabled gate: the generate_image tool is
// registered unconditionally so it can toggle live, but its active membership
// is gated on the (default-off) setting. Default-off must drop it from the
// initial active set; enabling keeps it; and the disabled setting must survive
// any active-set replay (mode-restore snapshots / persisted revive) that tries
// to re-add it — the agent-session hard-gate enforces this.
describe("createAgentSession imagegen.enabled gate", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-imagegen-active-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function createSession(settings: Settings): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read", "generate_image"],
		});
		sessions.push(session);
		return session;
	}

	it("drops generate_image from the initial active set when the setting is off (default)", async () => {
		const session = await createSession(Settings.isolated({}));
		const names = session.getActiveToolNames();
		expect(names).toContain("read");
		expect(names).not.toContain("generate_image");
	});

	it("keeps generate_image active when the setting is on", async () => {
		const session = await createSession(Settings.isolated({ "imagegen.enabled": true }));
		const names = session.getActiveToolNames();
		expect(names).toContain("read");
		expect(names).toContain("generate_image");
	});

	it("refuses to re-activate generate_image via setActiveToolsByName while disabled", async () => {
		const session = await createSession(Settings.isolated({}));
		// Simulates a mode-restore snapshot or a persisted subagent revive replaying a
		// saved active list captured while imagegen was enabled: the hard-gate strips it.
		await session.setActiveToolsByName(["read", "generate_image"]);
		expect(session.getActiveToolNames()).not.toContain("generate_image");
	});
});
