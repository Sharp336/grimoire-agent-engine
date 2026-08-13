import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent, type AgentHubRemote } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	type AgentRef,
	AgentRegistry,
	type AgentStatus,
	getAgentTombstonePath,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => initTheme());
beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});
afterEach(() => resetSettingsForTest());

function registerRef(registry: AgentRegistry, status: AgentStatus, inspectOnly: boolean): AgentRef {
	return registry.register({
		id: "CouncilChild",
		displayName: "member",
		kind: "sub",
		parentId: "Main",
		inspectOnly,
		session:
			status === "running" || status === "idle" ? ({ subscribe: () => () => {} } as unknown as AgentSession) : null,
		sessionFile: "/tmp/CouncilChild.jsonl",
		status,
	});
}

function remoteSpies() {
	return {
		chat: vi.fn(),
		kill: vi.fn(),
		revive: vi.fn(),
		readTranscript: async () => ({ text: "", newSize: 0 }),
	} satisfies AgentHubRemote;
}

function makeHub(registry: AgentRegistry, remote?: AgentHubRemote, focusAgent = vi.fn(async () => {})) {
	const ensureLive = vi.fn(async () => registry.get("CouncilChild")!.session!);
	const release = vi.fn(async () => true);
	const lifecycle = { ensureLive, release } as unknown as AgentLifecycleManager;
	const hub = new AgentHubOverlayComponent({
		settings: Settings.isolated(),
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry,
		irc: new IrcBus(registry, lifecycle),
		lifecycle,
		focusAgent,
		remote,
	});
	return { hub, ensureLive, release, focusAgent };
}

describe("inspect-only AgentRef capability", () => {
	it.each([
		["live", "running"],
		["settled", "idle"],
		["parked", "parked"],
		["failed or cancelled tombstone", "aborted"],
	] as const)("opens inspection but refuses revive and kill for %s refs", (_lifecycle, status) => {
		const registry = new AgentRegistry();
		registerRef(registry, status, true);
		const remote = remoteSpies();
		const focusAgent = vi.fn(async () => {});
		const { hub, ensureLive, release } = makeHub(registry, remote, focusAgent);

		hub.handleInput("\r");
		expect(focusAgent).not.toHaveBeenCalled();
		hub.handleInput("r");
		expect(Bun.stripANSI(hub.render(100).join("\n"))).toContain("inspect-only — cannot be revived");
		hub.handleInput("x");
		expect(Bun.stripANSI(hub.render(100).join("\n"))).toContain("inspect-only — cannot be killed");
		expect(remote.revive).not.toHaveBeenCalled();
		expect(remote.kill).not.toHaveBeenCalled();
		expect(ensureLive).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		hub.dispose();
	});

	it("creates no viewer editor or follow-up route while ordinary refs remain sendable", () => {
		const inspectRegistry = new AgentRegistry();
		registerRef(inspectRegistry, "parked", true);
		const inspectRemote = remoteSpies();
		const inspectViewer = new AgentTranscriptViewer({
			agentId: "CouncilChild",
			registry: inspectRegistry,
			remote: inspectRemote,
			ui: {} as TUI,
			cwd: "/repo",
			expandKeys: [],
			hubKeys: [],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});
		expect(Bun.stripANSI(inspectViewer.render(100).join("\n"))).not.toContain("Enter:send");
		inspectViewer.handleInput("follow up\r");
		expect(inspectRemote.chat).not.toHaveBeenCalled();
		inspectViewer.dispose();

		const ordinaryRegistry = new AgentRegistry();
		ordinaryRegistry.register({
			id: "Worker",
			displayName: "worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: null,
			status: "parked",
		});
		const ordinaryRemote = remoteSpies();
		const ordinaryViewer = new AgentTranscriptViewer({
			agentId: "Worker",
			registry: ordinaryRegistry,
			remote: ordinaryRemote,
			ui: {} as TUI,
			cwd: "/repo",
			expandKeys: [],
			hubKeys: [],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});
		expect(Bun.stripANSI(ordinaryViewer.render(100).join("\n"))).toContain("Enter:send");
		ordinaryViewer.handleInput("follow up");
		ordinaryViewer.handleInput("\r");
		expect(ordinaryRemote.chat).toHaveBeenCalledWith("Worker", "follow up");
		ordinaryViewer.dispose();
	});

	it("rejects IRC contact by capability while preserving ordinary delivery", async () => {
		const registry = new AgentRegistry();
		registerRef(registry, "idle", true);
		const bus = new IrcBus(registry);
		const refused = await bus.send({ from: "Main", to: "CouncilChild", body: "follow up" });
		expect(refused).toMatchObject({ outcome: "failed" });
		expect(refused.error).toContain("inspect-only");
	});

	it("restores inspectOnly from session_init for parked and tombstoned disk refs", async () => {
		using temp = TempDir.createSync("@omp-inspect-only-");
		const mainFile = temp.join("main.jsonl");
		const childFile = temp.join("main", "CouncilChild.jsonl");
		await Bun.write(mainFile, "");
		await Bun.write(
			childFile,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: path.resolve("."),
				}),
				JSON.stringify({
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: new Date().toISOString(),
					systemPrompt: "system",
					task: "task",
					tools: [],
					inspectOnly: true,
				}),
			].join("\n")}\n`,
		);
		const parkedRegistry = new AgentRegistry();
		await registerPersistedSubagents(parkedRegistry, mainFile);
		expect(parkedRegistry.get("CouncilChild")).toMatchObject({ inspectOnly: true, status: "parked" });

		await Bun.write(getAgentTombstonePath(childFile), "");
		const tombstoneRegistry = new AgentRegistry();
		await registerPersistedSubagents(tombstoneRegistry, mainFile);
		expect(tombstoneRegistry.get("CouncilChild")).toMatchObject({ inspectOnly: true, status: "aborted" });
	});
});
