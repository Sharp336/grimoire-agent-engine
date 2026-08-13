import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type ObservabilityPayload,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];
const sessions: AgentSession[] = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;

function makeTempDir(prefix: string): TempDir {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir;
}

function observabilityEntries(manager: SessionManager): Array<CustomEntry<ObservabilityPayload>> {
	return manager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<ObservabilityPayload> =>
				entry.type === "custom" && entry.customType === "observability",
		);
}

function buildSession(
	manager: SessionManager,
	agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	}),
): AgentSession {
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
	});
	sessions.push(session);
	return session;
}

beforeAll(async () => {
	sharedDir = TempDir.createSync("@pi-observability-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected bundled test model to exist");
	model = bundled;
});

afterEach(async () => {
	while (sessions.length > 0) await sessions.pop()?.dispose();
	for (const dir of tempDirs.splice(0)) await dir.remove();
});

afterAll(async () => {
	authStorage.close();
	await sharedDir.remove();
});

describe("session observability events", () => {
	it("materializes on the first observability append while user-only sessions remain lazy", async () => {
		const dir = makeTempDir("@pi-observability-persist-");
		const sessionDir = path.join(dir.path(), "sessions");
		const lazy = SessionManager.create(dir.path(), sessionDir);
		const lazyFile = lazy.getSessionFile();
		if (!lazyFile) throw new Error("Expected persisted session path");
		lazy.appendMessage({ role: "user", content: "not durable yet", timestamp: Date.now() });
		expect(fs.existsSync(lazyFile)).toBe(false);

		const durable = SessionManager.create(dir.path(), sessionDir);
		const durableFile = durable.getSessionFile();
		if (!durableFile) throw new Error("Expected persisted session path");
		const entryId = await durable.appendObservability({ v: 1, kind: "session_boundary", reason: "attach" });
		expect(fs.existsSync(durableFile)).toBe(true);

		const reopened = await SessionManager.open(durableFile);
		const [entry] = observabilityEntries(reopened);
		expect(entry?.id).toBe(entryId);
		expect(entry?.data).toEqual({ v: 1, kind: "session_boundary", reason: "attach" });
		expect(entry?.data).not.toHaveProperty("id");
		expect(entry?.data).not.toHaveProperty("parentId");
		expect(entry?.data).not.toHaveProperty("timestamp");
	});

	it("keeps observability custom entries out of model context", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "visible", timestamp: Date.now() });
		await manager.appendObservability({ v: 1, kind: "session_boundary", reason: "attach" });

		expect(manager.buildSessionContext().messages).toEqual([
			{ role: "user", content: "visible", timestamp: expect.any(Number) },
		]);
	});

	it("writes run assignment only when a caller supplies runId", async () => {
		const session = buildSession(SessionManager.inMemory());
		expect(await session.assignRun()).toBeUndefined();
		expect(observabilityEntries(session.sessionManager)).toEqual([]);

		await session.assignRun("run_supplied");
		expect(observabilityEntries(session.sessionManager).map(entry => entry.data)).toEqual([
			{ v: 1, kind: "run_assignment", runId: "run_supplied" },
		]);
	});

	it("records one attach boundary and one resume boundary for a completed switch", async () => {
		const dir = makeTempDir("@pi-observability-boundary-");
		const sessionDir = path.join(dir.path(), "sessions");
		const source = SessionManager.create(dir.path(), sessionDir);
		const session = buildSession(source);
		await session.recordProcessAttach();
		expect(observabilityEntries(source).map(entry => entry.data)).toEqual([
			{ v: 1, kind: "session_boundary", reason: "attach" },
		]);

		const target = SessionManager.create(dir.path(), sessionDir);
		await target.appendObservability({ v: 1, kind: "segment", segmentId: "existing" });
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected target session path");
		await target.close();

		expect(await session.switchSession(targetFile)).toBe(true);
		const boundaries = observabilityEntries(source).filter(entry => entry.data?.kind === "session_boundary");
		expect(boundaries.map(entry => entry.data)).toEqual([
			{ v: 1, kind: "session_boundary", reason: "resume" },
		]);
	});

	it("preserves an actor transcript header id across park and revive", async () => {
		const dir = makeTempDir("@pi-observability-revive-");
		const manager = SessionManager.create(dir.path(), path.join(dir.path(), "nested"));
		await manager.appendObservability({ v: 1, kind: "segment", segmentId: "nested-work" });
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected nested transcript path");
		const executionId = manager.getHeader().id;
		await manager.close();

		const revived = await SessionManager.open(file);
		expect(revived.getHeader().id).toBe(executionId);
	});

	it("records only provider requests that fail before an assistant message exists", async () => {
		const failedAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		failedAgent.prompt = async () => {
			throw new Error("request setup failed");
		};
		const failedSession = buildSession(SessionManager.inMemory(), failedAgent);
		await expect(failedSession.prompt("fail before assistant")).rejects.toThrow("request setup failed");
		expect(observabilityEntries(failedSession.sessionManager).map(entry => entry.data)).toEqual([
			{ v: 1, kind: "model_request", outcome: "failed" },
		]);

		const completedManager = SessionManager.inMemory();
		const completedAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		completedAgent.prompt = async () => {
			completedManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			throw new Error("listener failed after assistant persistence");
		};
		const completedSession = buildSession(completedManager, completedAgent);
		await expect(completedSession.prompt("complete normally")).rejects.toThrow(
			"listener failed after assistant persistence",
		);
		expect(
			observabilityEntries(completedSession.sessionManager).filter(entry => entry.data?.kind === "model_request"),
		).toEqual([]);
	});

	it("loads unknown future observability kinds without changing schema version 3", async () => {
		const dir = makeTempDir("@pi-observability-future-");
		const manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		manager.appendCustomEntry("observability", { v: 1, kind: "future_kind", futureField: true });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted session path");

		const reopened = await SessionManager.open(file);
		expect(reopened.getHeader().version).toBe(CURRENT_SESSION_VERSION);
		expect(reopened.getHeader().version).toBe(3);
		expect(
			reopened.getEntries().find(entry => entry.type === "custom" && entry.customType === "observability")?.data,
		).toEqual({ v: 1, kind: "future_kind", futureField: true });
	});
});
