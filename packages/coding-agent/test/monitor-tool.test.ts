import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MonitorTool, monitorSchema, monitorToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/monitor";
import { HubTool } from "../src/tools/hub";

const managers: AsyncJobManager[] = [];

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Missing dark theme");
	uiTheme = loaded;
});
function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	return manager;
}

function createSession(
	manager: AsyncJobManager | undefined,
	overrides: Partial<ToolSession> = {},
	settingsOverrides: Parameters<typeof Settings.isolated>[0] = {},
): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		skipPythonPreflight: true,
		settings: Settings.isolated({
			"async.enabled": true,
			"monitor.enabled": true,
			"async.pollWaitDuration": "5s",
			...settingsOverrides,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => "monitor-test-session",
		getAgentId: () => "Main",
		agentKind: "main",
		asyncJobManager: manager,
		...overrides,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

async function waitForTerminal(manager: AsyncJobManager, jobId: string): Promise<void> {
	await manager.waitForAll();
	await manager.drainDeliveries({ timeoutMs: 5_000 });
	if (manager.getJob(jobId)?.status === "running") throw new Error(`Monitor job ${jobId} did not settle`);
}

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
});

describe("monitor schema", () => {
	it("accepts exactly one validated source with an object-root wire schema", () => {
		const wire = toolWireSchema({ name: "monitor", description: "", parameters: monitorSchema });
		expect(wire).toMatchObject({ type: "object", oneOf: [{ required: ["command"] }, { required: ["ws"] }] });
		expect(validateJsonSchemaValue(wire, { description: "logs", command: "printf 'ok\\n'" }).success).toBe(true);
		expect(validateJsonSchemaValue(wire, { description: "socket", ws: "ws://127.0.0.1/events" }).success).toBe(true);
		expect(
			validateJsonSchemaValue(wire, {
				description: "both",
				command: "true",
				ws: "ws://127.0.0.1/events",
			}).success,
		).toBe(false);
		expect(validateJsonSchemaValue(wire, { description: "neither" }).success).toBe(false);
		expect(
			validateJsonSchemaValue(wire, {
				description: "secret",
				ws: "ws://user:pass@127.0.0.1/events",
			}).success,
		).toBe(false);
		expect(
			validateJsonSchemaValue(wire, {
				description: "protocols",
				ws: "ws://127.0.0.1",
				protocols: ["events", "events"],
			}).success,
		).toBe(false);
		expect(
			validateJsonSchemaValue(wire, {
				description: "command protocols",
				command: "printf ok",
				protocols: ["events"],
			}).success,
		).toBe(false);
	});
});

describe("monitor availability and approval", () => {
	it("requires both settings, a manager, and the main-agent depth", async () => {
		const manager = createManager();
		const available = (await createTools(createSession(manager), ["monitor"])).map(tool => tool.name);
		const optInRequired = (
			await createTools(createSession(manager, { settings: Settings.isolated({ "async.enabled": true }) }), [
				"monitor",
			])
		).map(tool => tool.name);
		const noManager = (await createTools(createSession(undefined), ["monitor"])).map(tool => tool.name);
		const disabled = (await createTools(createSession(manager, {}, { "monitor.enabled": false }), ["monitor"])).map(
			tool => tool.name,
		);
		const asyncDisabled = (
			await createTools(createSession(manager, {}, { "async.enabled": false }), ["monitor"])
		).map(tool => tool.name);
		const bashDisabled = (await createTools(createSession(manager, {}, { "bash.enabled": false }), ["monitor"])).map(
			tool => tool.name,
		);
		const subagent = (await createTools(createSession(manager, { taskDepth: 1 }), ["monitor"])).map(
			tool => tool.name,
		);
		const clone = (await createTools(createSession(manager, { agentKind: "sub", taskDepth: 0 }), ["monitor"])).map(
			tool => tool.name,
		);

		expect(available).toContain("monitor");
		expect(optInRequired).not.toContain("monitor");
		expect(noManager).not.toContain("monitor");
		expect(disabled).not.toContain("monitor");
		expect(asyncDisabled).not.toContain("monitor");
		expect(bashDisabled).toContain("monitor");
		expect(subagent).not.toContain("monitor");
		expect(clone).not.toContain("monitor");
	});

	it("reuses Bash critical-command approval for command sources", () => {
		const tool = new MonitorTool(createSession(createManager()));
		expect(tool.approval?.({ description: "danger", command: "rm -rf /" })).toMatchObject({
			tier: "exec",
			override: true,
			reason: "Critical pattern detected",
		});
		expect(tool.approval?.({ description: "safe", command: "printf ok" })).toBe("exec");
		expect(tool.approval?.({ description: "socket", ws: "ws://127.0.0.1" })).toBe("exec");
		const approvalDetails = tool.formatApprovalDetails?.({
			description: "socket",
			ws: "ws://user:password@127.0.0.1/events",
		});
		expect(approvalDetails?.join("\n")).toContain("credentialed WebSocket URL rejected");
		expect(approvalDetails?.join("\n")).not.toContain("password");
		const queryApprovalDetails = tool.formatApprovalDetails?.({
			description: "query auth",
			ws: "wss://events.example.test/feed?access_token=secret#private",
		});
		expect(queryApprovalDetails?.join("\n")).toContain("wss://events.example.test/feed");
		expect(queryApprovalDetails?.join("\n")).not.toContain("access_token");
		expect(queryApprovalDetails?.join("\n")).not.toContain("secret");
		expect(queryApprovalDetails?.join("\n")).not.toContain("private");
	});

	it("rejects command monitors when Bash execution is disabled", async () => {
		const manager = createManager();
		const tool = new MonitorTool(createSession(manager, {}, { "bash.enabled": false }));

		await expect(
			tool.execute("call", {
				description: "disabled command",
				command: "printf 'must not run\\n'",
			}),
		).rejects.toThrow("Bash execution is disabled");
		expect(manager.getAllJobs()).toHaveLength(0);
	});
});

describe("monitor renderer", () => {
	it("bounds and sanitizes command and WebSocket previews", () => {
		const command = ["one\tvalue", "two", "three", "four", "five"].join("\n");
		const commandText = Bun.stripANSI(
			monitorToolRenderer
				.renderCall({ description: "bounded", command }, { expanded: false, isPartial: true }, uiTheme)
				.render(160)
				.join("\n"),
		);
		expect(commandText).toContain("value");
		expect(commandText).toContain("three");
		expect(commandText).not.toContain("four");
		expect(commandText).not.toContain("\t");
		const home = os.homedir();
		const homeCommandText = Bun.stripANSI(
			monitorToolRenderer
				.renderCall(
					{ description: "home path", command: `${home}/bin/watcher` },
					{ expanded: false, isPartial: true },
					uiTheme,
				)
				.render(160)
				.join("\n"),
		);
		expect(homeCommandText).toContain("~/bin/watcher");
		expect(homeCommandText).not.toContain(home);

		const socketText = Bun.stripANSI(
			monitorToolRenderer
				.renderCall(
					{ description: "secret", ws: "ws://user:password@127.0.0.1/events" },
					{ expanded: false, isPartial: true },
					uiTheme,
				)
				.render(160)
				.join("\n"),
		);
		expect(socketText).toContain("credentialed WebSocket URL rejected");
		expect(socketText).not.toContain("password");
		const querySocketText = Bun.stripANSI(
			monitorToolRenderer
				.renderCall(
					{ description: "query auth", ws: "wss://events.example.test/feed?access_token=secret#private" },
					{ expanded: false, isPartial: true },
					uiTheme,
				)
				.render(160)
				.join("\n"),
		);
		expect(querySocketText).toContain("wss://events.example.test/feed");
		expect(querySocketText).not.toContain("access_token");
		expect(querySocketText).not.toContain("secret");
		expect(querySocketText).not.toContain("private");
	});
});
describe("monitor lifecycle", () => {
	it("returns a job id immediately, preserves owner id, and records terminal success", async () => {
		const manager = createManager();
		const tool = new MonitorTool(createSession(manager));
		const result = await tool.execute("call", { description: "one line", command: "printf 'ready\\n'" });
		const jobId = result.details?.async.jobId;

		expect(jobId).toBeDefined();
		expect(textOf(result)).toContain(`Monitor job ${jobId} started`);
		expect(result.details).toMatchObject({ source: "command", async: { state: "running", type: "monitor" } });
		expect(manager.getJob(jobId!)?.ownerId).toBe("Main");

		await waitForTerminal(manager, jobId!);
		expect(manager.getJob(jobId!)).toMatchObject({
			status: "completed",
			resultText: "Command monitor exited normally (code 0).",
		});
	});

	it("records terminal command failures", async () => {
		const manager = createManager();
		const result = await new MonitorTool(createSession(manager)).execute("call", {
			description: "failing command",
			command: "exit 7",
		});
		const jobId = result.details!.async.jobId;

		await waitForTerminal(manager, jobId);
		expect(manager.getJob(jobId)).toMatchObject({ status: "failed" });
		expect(manager.getJob(jobId)?.errorText).toContain("code 7");
	});

	it("cancels through the owner-scoped hub tool", async () => {
		const manager = createManager();
		const session = createSession(manager);
		const result = await new MonitorTool(session).execute("call", {
			description: "persistent command",
			command: "while true; do printf 'tick\\n'; sleep 1; done",
			persistent: true,
		});
		const jobId = result.details!.async.jobId;
		expect(manager.getJob(jobId)?.persistent).toBe(true);

		const cancel = await new HubTool(session).execute("cancel", { op: "cancel", ids: [jobId] });
		expect(textOf(cancel)).toContain(`background job ${jobId}`);
		await waitForTerminal(manager, jobId);
		expect(manager.getJob(jobId)?.status).toBe("cancelled");
	});
});
