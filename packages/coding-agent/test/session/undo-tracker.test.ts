import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { UndoTracker } from "@oh-my-pi/pi-coding-agent/session/undo-tracker";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

async function runGit(cwd: string, ...args: string[]): Promise<string> {
	const proc = await Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((proc.exitCode ?? 0) !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${err || out}`);
	}
	return out;
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

function makeUserMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

describe("UndoTracker", () => {
	let tmpDir: string;
	let projectDir: string;
	let agentDir: string;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-undo-tracker-test-"));
		projectDir = path.join(tmpDir, "project");
		agentDir = path.join(tmpDir, "agent");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await runGit(projectDir, "init");
		await runGit(projectDir, "config", "user.email", "test@example.com");
		await runGit(projectDir, "config", "user.name", "Test");
		await fs.writeFile(path.join(projectDir, "file.txt"), "v1");
		await runGit(projectDir, "add", "file.txt");
		await runGit(projectDir, "commit", "-m", "initial");
		sessionManager = SessionManager.inMemory(projectDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("records a snapshot entry after a turn with file changes", async () => {
		const tracker = new UndoTracker({ sessionManager, projectRoot: projectDir, agentDataDir: agentDir, enabled: true });
		expect(await tracker.isSupported()).toBe(true);

		await tracker.onUserTurnStart();
		const userId = sessionManager.appendMessage(makeUserMessage("change it"));
		await fs.writeFile(path.join(projectDir, "file.txt"), "v2");
		await fs.writeFile(path.join(projectDir, "new.txt"), "fresh");
		sessionManager.appendMessage(makeAssistantMessage("done"));
		await tracker.onAssistantTurnEnd();

		const entries = sessionManager.getEntries();
		const undoEntry = entries.find(e => e.type === "custom" && e.customType === "undo-snapshot");
		expect(undoEntry).toBeTruthy();
		const data = (undoEntry as { data?: Record<string, unknown> }).data ?? {};
		expect(data.refEntryId).toBe(userId);
		expect((data.changedFiles as string[]).sort()).toEqual(["file.txt", "new.txt"]);
	});

	it("resolves undo boundaries across one turn", async () => {
		const tracker = new UndoTracker({ sessionManager, projectRoot: projectDir, agentDataDir: agentDir, enabled: true });
		await tracker.onUserTurnStart();
		const userId = sessionManager.appendMessage(makeUserMessage("change it"));
		await fs.writeFile(path.join(projectDir, "file.txt"), "v2");
		sessionManager.appendMessage(makeAssistantMessage("done"));
		await tracker.onAssistantTurnEnd();

		const boundaries = tracker.resolveUndo("1");
		expect(boundaries).toBeTruthy();
		expect(boundaries!.targetUserEntryId).toBe(userId);
		expect(boundaries!.filesToRestore).toContain("file.txt");
		expect(boundaries!.userMessageText).toBe("change it");
	});

	it("restores files to the pre-turn snapshot", async () => {
		const tracker = new UndoTracker({ sessionManager, projectRoot: projectDir, agentDataDir: agentDir, enabled: true });
		await tracker.onUserTurnStart();
		sessionManager.appendMessage(makeUserMessage("change it"));
		await fs.writeFile(path.join(projectDir, "file.txt"), "v2");
		sessionManager.appendMessage(makeAssistantMessage("done"));
		await tracker.onAssistantTurnEnd();

		const boundaries = tracker.resolveUndo("1")!;
		await tracker.restoreFiles(boundaries);
		expect(await fs.readFile(path.join(projectDir, "file.txt"), "utf8")).toBe("v1");
	});

	it("skips capture when disabled", async () => {
		const tracker = new UndoTracker({ sessionManager, projectRoot: projectDir, agentDataDir: agentDir, enabled: false });
		expect(await tracker.isSupported()).toBe(false);
		await tracker.onUserTurnStart();
		sessionManager.appendMessage(makeUserMessage("hi"));
		await fs.writeFile(path.join(projectDir, "x.txt"), "x");
		sessionManager.appendMessage(makeAssistantMessage("ok"));
		await tracker.onAssistantTurnEnd();
		expect(sessionManager.getEntries().some(e => e.type === "custom" && e.customType === "undo-snapshot")).toBe(false);
	});
});
