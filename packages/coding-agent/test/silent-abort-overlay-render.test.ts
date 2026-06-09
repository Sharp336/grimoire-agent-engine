/**
 * Regression: the observer overlay must not render SILENT_ABORT_MARKER verbatim.
 *
 * The overlay now renders a subagent transcript through a mounted TranscriptRenderer
 * fed by a TranscriptSource (here a ReplaySource over a real JSONL file). The
 * silent-abort sentinel is suppressed via the `getAssistantMessageDisplay` renderer
 * dep that SelectorController.#buildObserverRendererDeps wires for the observer; this
 * test exercises that path end-to-end and asserts the sentinel never reaches the
 * rendered output, while a genuine error still renders a visible `Error:` line.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionObserverOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-observer-overlay";
import type {
	ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { isSilentAbort, SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";

const SESSION_ID = "test-session-1";

function makeJsonlSessionFile(dirPath: string, entries: object[]): string {
	const filePath = path.join(dirPath, "session.jsonl");
	const lines = entries.map(e => JSON.stringify(e));
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
	return filePath;
}

function makeSubagentRegistry(sessions: ObservableSession[]): SessionObserverRegistry {
	return {
		getSessions: () => sessions,
		// getEventBus returns undefined so the overlay selects a ReplaySource (no live tail).
		getEventBus: () => undefined,
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(s => s.status === "active").length,
	} as unknown as SessionObserverRegistry;
}

/**
 * Build the overlay with the same silent-abort-suppressing renderer dep that
 * SelectorController.#buildObserverRendererDeps wires in production, so this test
 * defends the actual observer rendering contract.
 */
function makeObserverOverlay(registry: SessionObserverRegistry): SessionObserverOverlayComponent {
	return new SessionObserverOverlayComponent(
		registry,
		() => {},
		["ctrl+s"],
		() => {},
		{
			rendererDeps: {
				getAssistantMessageDisplay: message =>
					message.stopReason === "aborted" && isSilentAbort(message.errorMessage)
						? { ...message, stopReason: "stop" as const }
						: message,
			},
		},
	);
}

describe("Observer overlay silent-abort regression", () => {
	let tmpDir: string;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overlay-test-"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("does not render an Error line for silent-abort assistant messages with empty content", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "aborted",
					errorMessage: SILENT_ABORT_MARKER,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const registry = makeSubagentRegistry([
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const overlay = makeObserverOverlay(registry);
		const renderedText = overlay.render(120).join("\n");

		// The sentinel MUST NOT appear verbatim in any rendered line.
		expect(renderedText).not.toContain(SILENT_ABORT_MARKER);
		// A genuine error line must NOT appear for a suppressed silent-abort message.
		expect(renderedText).not.toContain("Error:");
	});

	it("renders normal error messages as a visible Error line", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-2",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-2",
				parentId: "msg-user-2",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "error",
					errorMessage: "Connection timed out",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const registry = makeSubagentRegistry([
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "failed",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const overlay = makeObserverOverlay(registry);
		const renderedText = overlay.render(120).join("\n");

		// A real error renders the same way as in the main agent: a red "Error: <msg>" line.
		expect(renderedText).toContain("Error: Connection timed out");
	});
});
