import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	formatMCPReconnectNotice,
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Contract: with `mcp.reconnectNotices` enabled, the automatic reconnect path
// (transport close → backoff reconnect) emits user-visible status events:
// "reconnecting" when the connection drops and "reconnected" when it
// recovers. With the default (disabled), no reconnect events are emitted.
// Manual reconnects are excluded — they already have interactive UI feedback.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "crash-once-mcp.ts");

async function waitForEvent(
	events: McpConnectionStatusEvent[],
	type: McpConnectionStatusEvent["type"],
	deadlineMs = 15_000,
): Promise<McpConnectionStatusEvent | undefined> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const found = events.find(event => event.type === type);
		if (found) return found;
		await Bun.sleep(50);
	}
	return undefined;
}

describe("MCPManager reconnect notices", () => {
	let tempDir: string;
	let manager: MCPManager | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-mcp-reconnect-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (manager) {
			await manager.disconnectAll();
			manager = undefined;
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("emits reconnecting then reconnected when a server crashes and recovers", async () => {
		const events: McpConnectionStatusEvent[] = [];
		manager = new MCPManager(tempDir, null);
		manager.setOnConnectionStatus(event => events.push(event));
		manager.setReconnectNoticesEnabled(true);

		const marker = path.join(tempDir, "crashed.once");
		await manager.connectServers(
			{ crashy: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, marker] } },
			{},
		);
		expect(manager.getConnectionStatus("crashy")).toBe("connected");

		// The fixture exits 100ms after answering tools/list; the manager's
		// onClose handler then drives the automatic reconnect (backoff 500ms+).
		const reconnecting = await waitForEvent(events, "reconnecting");
		expect(reconnecting).toBeDefined();
		expect(reconnecting).toMatchObject({ serverName: "crashy" });

		const reconnected = await waitForEvent(events, "reconnected");
		expect(reconnected).toBeDefined();
		expect(reconnected).toMatchObject({ serverName: "crashy" });

		// Order matters: the drop must be announced before the recovery.
		const firstIdx = events.findIndex(event => event.type === "reconnecting");
		const secondIdx = events.findIndex(event => event.type === "reconnected");
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);

		expect(manager.getConnectionStatus("crashy")).toBe("connected");
	}, 25_000);

	it("emits nothing with notices disabled (default)", async () => {
		const events: McpConnectionStatusEvent[] = [];
		manager = new MCPManager(tempDir, null);
		manager.setOnConnectionStatus(event => events.push(event));
		// setReconnectNoticesEnabled never called — default is off.

		const marker = path.join(tempDir, "crashed.once");
		await manager.connectServers(
			{ crashy: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, marker] } },
			{},
		);
		expect(manager.getConnectionStatus("crashy")).toBe("connected");

		// Drive the crash + reconnect cycle by watching real connection state,
		// not wall-clock guesses: the 500ms reconnect backoff keeps the
		// "connecting" phase observable long enough for 50ms polls to catch.
		// (Fake timers are not an option — the backoff and the fixture
		// subprocess run against the platform clock by design.)
		const deadline = Date.now() + 15_000;
		while (manager.getConnectionStatus("crashy") !== "connecting" && Date.now() < deadline) {
			await Bun.sleep(50);
		}
		while (manager.getConnectionStatus("crashy") !== "connected" && Date.now() < deadline) {
			await Bun.sleep(50);
		}
		expect(manager.getConnectionStatus("crashy")).toBe("connected");
		expect(events.filter(event => event.type.startsWith("reconnect"))).toEqual([]);
	}, 25_000);

	it("emits a terminal failure when reconnect cannot start", async () => {
		const events: McpConnectionStatusEvent[] = [];
		manager = new MCPManager(tempDir, null);
		manager.setOnConnectionStatus(event => events.push(event));
		manager.setReconnectNoticesEnabled(true);

		expect(await manager.reconnectServer("missing")).toBeNull();
		expect(events.map(event => event.type)).toEqual(["reconnecting", "reconnect-failed"]);
		expect(events[1]).toMatchObject({
			serverName: "missing",
			error: "No saved server configuration is available.",
		});
	});

	it("adds and removes a listener without replacing the owner", async () => {
		const owner: McpConnectionStatusEvent[] = [];
		const shared: McpConnectionStatusEvent[] = [];
		manager = new MCPManager(tempDir, null);
		manager.setOnConnectionStatus(event => owner.push(event));
		const unsubscribe = manager.addConnectionStatusListener(event => shared.push(event));
		manager.setReconnectNoticesEnabled(true);

		await manager.reconnectServer("first");
		unsubscribe();
		await manager.reconnectServer("second");
		expect(owner).toHaveLength(4);
		expect(shared).toHaveLength(2);
	});

	it("keeps recovery notices on one line for unsafe server names", () => {
		const notice = formatMCPReconnectNotice({
			type: "reconnect-failed",
			serverName: "bad\tserver\nname",
			error: "offline",
		});
		expect(notice).not.toContain("\t");
		expect(notice).not.toContain("\n");
		expect(notice).toContain("Use /mcp to retry manually.");
		expect(notice).not.toContain("/mcp reconnect");
	});

	it("wires a supplied UI manager without replacing its owner", async () => {
		const owner: McpConnectionStatusEvent[] = [];
		const uiEvents: McpConnectionStatusEvent[] = [];
		manager = new MCPManager(tempDir, null);
		manager.setOnConnectionStatus(event => owner.push(event));
		const eventBus = new EventBus();
		const unsubscribe = eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event => {
			if (isMcpConnectionStatusEvent(event)) uiEvents.push(event);
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.reconnectNotices": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			eventBus,
			mcpManager: manager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			await manager.reconnectServer("during-session");
			expect(owner).toHaveLength(2);
			expect(uiEvents).toHaveLength(2);
		} finally {
			await session.dispose();
			unsubscribe();
			authStorage.close();
		}

		await manager.reconnectServer("after-dispose");
		expect(owner).toHaveLength(4);
		expect(uiEvents).toHaveLength(2);
	});
});
