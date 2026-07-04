import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendWorkspaceBindingSessionMetadata,
	WorkspaceBindingRegistry,
	WorkspaceBindingUnavailableError,
	type WorkspaceBindingMetadata,
} from "@oh-my-pi/pi-coding-agent/session/workspace-binding";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workspace-binding-"));
	tempDirs.push(dir);
	return dir;
}

async function makeWorkspace(root: string, name = "project"): Promise<string> {
	const workspaceRoot = path.join(root, name);
	await fs.mkdir(workspaceRoot, { recursive: true });
	await Bun.write(path.join(workspaceRoot, "package.json"), "{}\n");
	return workspaceRoot;
}

async function makeSessionFile(agentDir: string, sessionId: string): Promise<string> {
	const sessionFile = path.join(agentDir, "sessions", `${sessionId}.jsonl`);
	await fs.mkdir(path.dirname(sessionFile), { recursive: true });
	await Bun.write(sessionFile, "");
	return sessionFile;
}

function expectWorkspaceBindingMetadata(value: unknown, expected: WorkspaceBindingMetadata): void {
	if (typeof value !== "object" || value === null) {
		throw new Error("Expected workspace binding metadata object");
	}
	if (!("sessionId" in value)) throw new Error("Expected workspace binding sessionId");
	if (!("workspaceRoot" in value)) throw new Error("Expected workspace binding workspaceRoot");
	if (!("registryFile" in value)) throw new Error("Expected workspace binding registryFile");
	expect(value.sessionId).toBe(expected.sessionId);
	expect(value.workspaceRoot).toBe(expected.workspaceRoot);
	expect(value.registryFile).toBe(expected.registryFile);
}


class FakeSessionManager {
	readonly appendedInits: unknown[] = [];
	#header: { workspaceBinding?: WorkspaceBindingMetadata } = {};

	setWorkspaceBinding(metadata: WorkspaceBindingMetadata): void {
		this.#header.workspaceBinding = metadata;
	}

	appendSessionInit(init: unknown): string {
		this.appendedInits.push(init);
		return "init-entry-id";
	}

	getHeader(): { workspaceBinding?: WorkspaceBindingMetadata } {
		return this.#header;
	}
}
describe("WorkspaceBindingRegistry", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("registers a session to its canonical workspace root without touching the real OMP home", async () => {
		const tempDir = await makeTempDir();
		const agentDir = path.join(tempDir, "agent-home");
		const workspaceRoot = await makeWorkspace(tempDir);
		const sessionId = "session-create";
		const sessionFile = await makeSessionFile(agentDir, sessionId);
		const registry = new WorkspaceBindingRegistry({ agentDir });

		const binding = await registry.register({
			sessionId,
			sessionFile,
			workspaceRoot: path.join(workspaceRoot, "."),
			agentId: "Main",
			kind: "main",
			status: "running",
			createdAt: "2026-07-04T12:00:00.000Z",
			lastSeenAt: "2026-07-04T12:00:00.000Z",
		});

		expect(binding).toEqual({
			sessionId,
			sessionFile,
			workspaceRoot,
			agentId: "Main",
			kind: "main",
			status: "running",
			createdAt: "2026-07-04T12:00:00.000Z",
			lastSeenAt: "2026-07-04T12:00:00.000Z",
		});
		expect(registry.registryFile.startsWith(agentDir)).toBe(true);
		expect(registry.registryFile.includes(path.join(os.homedir(), ".omp"))).toBe(false);
	});

	it("persists lookup by session id across registry instances", async () => {
		const tempDir = await makeTempDir();
		const agentDir = path.join(tempDir, "agent-home");
		const workspaceRoot = await makeWorkspace(tempDir);
		const sessionId = "session-lookup";
		const sessionFile = await makeSessionFile(agentDir, sessionId);
		const firstRegistry = new WorkspaceBindingRegistry({ agentDir });
		const binding = await firstRegistry.register({
			sessionId,
			sessionFile,
			workspaceRoot,
			agentId: "Worker",
			kind: "sub",
			status: "running",
			createdAt: "2026-07-04T12:01:00.000Z",
			lastSeenAt: "2026-07-04T12:01:00.000Z",
		});

		const reloadedRegistry = new WorkspaceBindingRegistry({ agentDir });

		expect(await reloadedRegistry.lookupBySessionId(sessionId)).toEqual(binding);
	});

	it("updates status and lastSeenAt without rewriting the session workspace identity", async () => {
		const tempDir = await makeTempDir();
		const agentDir = path.join(tempDir, "agent-home");
		const workspaceRoot = await makeWorkspace(tempDir);
		const sessionId = "session-status";
		const sessionFile = await makeSessionFile(agentDir, sessionId);
		const registry = new WorkspaceBindingRegistry({ agentDir });
		await registry.register({
			sessionId,
			sessionFile,
			workspaceRoot,
			agentId: "Worker",
			kind: "sub",
			status: "running",
			createdAt: "2026-07-04T12:02:00.000Z",
			lastSeenAt: "2026-07-04T12:02:00.000Z",
		});

		const updated = await registry.updateStatus(sessionId, {
			status: "parked",
			lastSeenAt: "2026-07-04T12:05:30.000Z",
		});
		const reloadedRegistry = new WorkspaceBindingRegistry({ agentDir });

		expect(updated).toMatchObject({
			sessionId,
			sessionFile,
			workspaceRoot,
			agentId: "Worker",
			kind: "sub",
			status: "parked",
			createdAt: "2026-07-04T12:02:00.000Z",
			lastSeenAt: "2026-07-04T12:05:30.000Z",
		});
		expect(await reloadedRegistry.lookupBySessionId(sessionId)).toEqual(updated);
	});

	it("fails closed when the bound workspace is missing instead of falling back to the launch cwd", async () => {
		const tempDir = await makeTempDir();
		const agentDir = path.join(tempDir, "agent-home");
		const workspaceRoot = await makeWorkspace(tempDir, "deleted-project");
		const fallbackCwd = await makeWorkspace(tempDir, "current-project");
		const sessionId = "session-missing";
		const sessionFile = await makeSessionFile(agentDir, sessionId);
		const registry = new WorkspaceBindingRegistry({ agentDir });
		await registry.register({
			sessionId,
			sessionFile,
			workspaceRoot,
			agentId: "Worker",
			kind: "sub",
			status: "parked",
			createdAt: "2026-07-04T12:03:00.000Z",
			lastSeenAt: "2026-07-04T12:03:00.000Z",
		});
		await fs.rm(workspaceRoot, { recursive: true, force: true });

		let caught: unknown;
		try {
			await registry.requireWorkspaceForSession(sessionId, { fallbackCwd });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(WorkspaceBindingUnavailableError);
		if (!(caught instanceof WorkspaceBindingUnavailableError)) {
			throw new Error("Expected WorkspaceBindingUnavailableError");
		}
		expect(caught.code).toBe("WORKSPACE_MISSING");
		expect(caught.sessionId).toBe(sessionId);
		expect(caught.workspaceRoot).toBe(workspaceRoot);
		expect(caught.fallbackCwd).toBe(fallbackCwd);
	});

	it("records the binding in session header and session_init metadata for faithful revive", async () => {
		const tempDir = await makeTempDir();
		const agentDir = path.join(tempDir, "agent-home");
		const workspaceRoot = await makeWorkspace(tempDir);
		const sessionId = "session-metadata";
		const sessionFile = await makeSessionFile(agentDir, sessionId);
		const sessionManager = new FakeSessionManager();
		const registry = new WorkspaceBindingRegistry({ agentDir });
		const binding = await registry.register({
			sessionId,
			sessionFile,
			workspaceRoot,
			agentId: "Worker",
			kind: "sub",
			status: "running",
			createdAt: "2026-07-04T12:04:00.000Z",
			lastSeenAt: "2026-07-04T12:04:00.000Z",
		});

		const entryId = appendWorkspaceBindingSessionMetadata(sessionManager as never, binding, {
			systemPrompt: "system prompt",
			task: "do isolated work",
			tools: ["read", "write"],
			spawns: "task",
			readSummarize: false,
		});
		const expectedMetadata: WorkspaceBindingMetadata = {
			sessionId,
			workspaceRoot,
			registryFile: registry.registryFile,
		};

		expect(entryId).toBe("init-entry-id");
		expectWorkspaceBindingMetadata(sessionManager.getHeader().workspaceBinding, expectedMetadata);
		expect(sessionManager.appendedInits).toEqual([
			{
				systemPrompt: "system prompt",
				task: "do isolated work",
				tools: ["read", "write"],
				spawns: "task",
				readSummarize: false,
				workspaceBinding: expectedMetadata,
			},
		]);
	});
});
