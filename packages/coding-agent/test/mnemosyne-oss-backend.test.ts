import { afterEach, describe, expect, it } from "bun:test";
import { mnemosyneOssBackend } from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/backend";
import type { MnemosyneOssBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/config";
import {
	MnemosyneOssSessionState,
	type MnemosyneOssWorkerLike,
	setMnemosyneOssSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/state";
import type {
	MnemosyneOssWorkerMethod,
	MnemosyneOssWorkerRecallItem,
	MnemosyneOssWorkerRecord,
} from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/worker-protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FakeSessionData {
	session: AgentSession;
	entries: any[];
	customEntries: Array<{ customType: string; data: unknown }>;
	refreshes: number;
}

interface FakeWorkerData {
	worker: MnemosyneOssWorkerLike;
	calls: Array<{ method: MnemosyneOssWorkerMethod; params: Record<string, unknown> }>;
	memories: Map<string, MnemosyneOssWorkerRecord>;
	shutdowns: number;
}

const config: MnemosyneOssBackendConfig = {
	dataDir: "/tmp/mnemosyne-test",
	baseBank: "project-bank",
	bank: "project-bank",
	globalBank: "default",
	retainBank: "project-bank",
	recallBanks: ["project-bank"],
	sharedBanks: [],
	scoping: "per-project",
	ownership: "omp",
	autoRecall: true,
	autoRetain: true,
	localEmbeddings: false,
	localConsolidation: false,
	autoMigrate: false,
	retainEveryNTurns: 4,
	recallLimit: 8,
	recallContextTurns: 3,
	recallMaxQueryChars: 4000,
	injectionTokenLimit: 5000,
	requestTimeoutMs: 1000,
	sleepTimeoutMs: 1000,
	shutdownTimeoutMs: 100,
	debug: true,
};

const sessions: FakeSessionData[] = [];

afterEach(() => {
	for (const { session } of sessions.splice(0)) setMnemosyneOssSessionState(session, undefined);
});

function createSession(sessionId = "session-1", entries: any[] = []): FakeSessionData {
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	const manager = {
		getCwd: () => "/tmp/project",
		getEntries: () => entries,
		appendCustomEntry: (customType: string, data: unknown) => {
			customEntries.push({ customType, data });
			entries.push({ type: "custom", customType, data });
			return `entry-${customEntries.length}`;
		},
		flush: async () => undefined,
	};
	const data: FakeSessionData = {
		entries,
		customEntries,
		refreshes: 0,
		session: {
			sessionId,
			sessionManager: manager,
			subscribe: () => () => {},
			refreshBaseSystemPrompt: async () => {
				data.refreshes++;
			},
		} as unknown as AgentSession,
	};
	sessions.push(data);
	return data;
}

function addTurn(data: FakeSessionData, index: number): void {
	data.entries.push({ type: "message", message: { role: "user", content: `user turn ${index}` } });
	data.entries.push({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: `assistant ${index}` }] },
	});
}

function createWorker(recallItems: MnemosyneOssWorkerRecallItem[] = []): FakeWorkerData {
	const calls: FakeWorkerData["calls"] = [];
	const memories = new Map<string, MnemosyneOssWorkerRecord>();
	let nextId = 1;
	let shutdowns = 0;
	const worker: MnemosyneOssWorkerLike = {
		request: async <T>(method: MnemosyneOssWorkerMethod, params: Record<string, unknown> = {}) => {
			calls.push({ method, params });
			if (method === "recall") return { items: recallItems } as T;
			if (method === "remember") {
				const id = `memory-${nextId++}`;
				const options = (params.options ?? {}) as Record<string, any>;
				const record: MnemosyneOssWorkerRecord = {
					id,
					content: String(params.content),
					source: options.source,
					metadata: options.metadata,
					bank: "project-bank",
					editable: true,
				};
				memories.set(id, record);
				return { id } as T;
			}
			if (method === "get") {
				const record = memories.get(String(params.id));
				return (record ? { status: "found", record } : { status: "not_found", id: params.id }) as T;
			}
			if (method === "update" || method === "forget" || method === "invalidate") {
				const id = String(params.id);
				const record = memories.get(id);
				if (!record) return { status: "not_found", id } as T;
				if (method === "update") record.content = String(params.content);
				return {
					status: method === "update" ? "updated" : method === "forget" ? "deleted" : "invalidated",
					id,
					bank: record.bank,
				} as T;
			}
			if (method === "status" || method === "stats") {
				return {
					banks: [
						{
							bank: "project-bank",
							database: "/tmp/project-bank.db",
							health: "ok",
							working_count: memories.size,
						},
					],
					sdk_version: "4.0.0",
					python_version: "3.11.0",
					embedding_mode: "lexical",
					consolidation_mode: "heuristic",
				} as T;
			}
			if (method === "capabilities")
				return {
					clear_mode: "bank-manager",
					protocol: 1,
					sdk_version: "4.0.0",
					python_version: "3.11.0",
					embedding_mode: "lexical",
					consolidation_mode: "heuristic",
				} as T;
			if (method === "clear") {
				memories.clear();
				return { deleted: true } as T;
			}
			return {} as T;
		},
		shutdown: async () => {
			shutdowns++;
		},
	};
	return {
		worker,
		calls,
		memories,
		get shutdowns() {
			return shutdowns;
		},
	} as FakeWorkerData;
}

describe("Mnemosyne OSS backend", () => {
	it("recalls fail-open and caches one untrusted first-turn block for prompt rebuilds and compaction", async () => {
		const session = createSession();
		const fake = createWorker([
			{ id: "seed", content: "stored background", source: "seed", score: 1, bank: "project-bank" },
		]);
		const state = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: session.session,
			worker: fake.worker,
		});
		setMnemosyneOssSessionState(session.session, state);
		const first = await mnemosyneOssBackend.beforeAgentStartPrompt!(session.session, "current question");
		const second = await mnemosyneOssBackend.beforeAgentStartPrompt!(session.session, "current question");
		expect(first).toContain("<memories>");
		expect(first).toContain("stored background");
		expect(second).toBeUndefined();
		expect((await mnemosyneOssBackend.buildDeveloperInstructions("/tmp", {} as any, session.session))!).toContain(
			"stored background",
		);
		const compacted = await mnemosyneOssBackend.preCompactionContext!(
			[{ role: "user", content: "question" } as any],
			{} as any,
			session.session,
		);
		expect(compacted).toContain("stored background");
		expect(fake.calls.filter(call => call.method === "recall")).toHaveLength(2);
	});

	it("retains only unretained root suffixes, persists cursors after acknowledgement, and resumes from the latest cursor", async () => {
		const session = createSession();
		for (let index = 1; index <= 4; index++) addTurn(session, index);
		const fake = createWorker();
		const state = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: session.session,
			worker: fake.worker,
		});
		await state.maybeRetainOnAgentEnd([] as any);
		for (let index = 5; index <= 6; index++) addTurn(session, index);
		await state.forceRetainCurrentSession();
		const remembers = fake.calls.filter(call => call.method === "remember");
		expect(remembers).toHaveLength(2);
		expect((remembers[0].params.options as any).metadata.sourceId).toBe("session-1:turns:1-4");
		expect((remembers[1].params.options as any).metadata.sourceId).toBe("session-1:turns:5-6");
		expect(session.customEntries.at(-1)).toEqual({
			customType: "mnemosyne-oss-retention-cursor",
			data: { sessionId: "session-1", retainedThroughUserTurn: 6, sourceId: "session-1:turns:5-6" },
		});
		const resumed = createSession("session-1", session.entries);
		const resumedWorker = createWorker();
		const resumedState = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: resumed.session,
			worker: resumedWorker.worker,
		});
		addTurn(resumed, 7);
		await resumedState.forceRetainCurrentSession();
		expect(
			(resumedWorker.calls.find(call => call.method === "remember")!.params.options as any).metadata.sourceId,
		).toBe("session-1:turns:7-7");
	});

	it("aliases share explicit operations but never auto-retain, enqueue, sleep, clear, or shut down", async () => {
		const parentSession = createSession();
		const fake = createWorker();
		const parent = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: parentSession.session,
			worker: fake.worker,
		});
		setMnemosyneOssSessionState(parentSession.session, parent);
		const aliasSession = createSession("alias-1");
		const alias = new MnemosyneOssSessionState({
			sessionId: "alias-1",
			config,
			session: aliasSession.session,
			aliasOf: parent,
		});
		setMnemosyneOssSessionState(aliasSession.session, alias);
		await mnemosyneOssBackend.save!(
			{ agentDir: "/tmp", cwd: "/tmp", session: aliasSession.session },
			{ content: "explicit alias fact" },
		);
		await mnemosyneOssBackend.enqueue("/tmp", "/tmp", aliasSession.session);
		await alias.dispose();
		expect(fake.calls.filter(call => call.method === "remember")).toHaveLength(1);
		expect(fake.calls.some(call => call.method === "sleep")).toBe(false);
		expect(fake.shutdowns).toBe(0);
	});

	it("maps exact get/edit operations, status diagnostics, and refuses shared clear before mutation", async () => {
		const session = createSession();
		const fake = createWorker();
		const state = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: session.session,
			worker: fake.worker,
		});
		setMnemosyneOssSessionState(session.session, state);
		const saved = await mnemosyneOssBackend.save!(
			{ agentDir: "/tmp", cwd: "/tmp", session: session.session },
			{ content: "editable fact" },
		);
		const id = saved.ids![0];
		expect(
			(await mnemosyneOssBackend.get!({ agentDir: "/tmp", cwd: "/tmp", session: session.session }, id)).status,
		).toBe("found");
		expect(
			(
				await mnemosyneOssBackend.edit!({ agentDir: "/tmp", cwd: "/tmp", session: session.session }, "update", id, {
					content: "updated",
				})
			).status,
		).toBe("updated");
		expect(
			(
				await mnemosyneOssBackend.edit!(
					{ agentDir: "/tmp", cwd: "/tmp", session: session.session },
					"invalidate",
					id,
				)
			).status,
		).toBe("invalidated");
		const status = await mnemosyneOssBackend.status!({ agentDir: "/tmp", cwd: "/tmp", session: session.session });
		expect(status.sdkVersion).toBe("4.0.0");
		const sharedSession = createSession("shared");
		const sharedConfig = { ...config, ownership: "shared" as const };
		const sharedWorker = createWorker();
		setMnemosyneOssSessionState(
			sharedSession.session,
			new MnemosyneOssSessionState({
				sessionId: "shared",
				config: sharedConfig,
				session: sharedSession.session,
				worker: sharedWorker.worker,
			}),
		);
		await expect(mnemosyneOssBackend.clear("/tmp", "/tmp", sharedSession.session)).rejects.toThrow(
			"active bank is shared",
		);
		expect(sharedWorker.calls.some(call => call.method === "clear")).toBe(false);
	});
});
