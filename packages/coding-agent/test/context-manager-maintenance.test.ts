import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import type {
	ContextAgentCandidate,
	ContextAgentRunInput,
	ContextAgentRunner,
} from "../src/context-manager/agent-runner";
import { ContextManagerController } from "../src/context-manager/controller";
import { ContextDreamer } from "../src/context-manager/dreamer";
import { ContextDreamTaskExecutor } from "../src/context-manager/dreamer-tasks";
import { renderTieredHistory } from "../src/context-manager/history";
import {
	type ContextMemoryAdapter,
	type ContextMemoryMaintenanceRecord,
	type ContextMemoryPatchInput,
	renderContextMemory,
} from "../src/context-manager/memory";
import { ContextSidekick } from "../src/context-manager/sidekick";
import { ContextStore } from "../src/context-manager/storage";
import { SessionManager } from "../src/session/session-manager";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function candidate(role: string): ContextAgentCandidate {
	return {
		role,
		model: { provider: "test", id: "test" } as Model,
		thinkingLevel: undefined,
		selector: "test/test",
		activeModelFallback: false,
	};
}

function registerSession(store: ContextStore, sessionManager: SessionManager, cwd: string): void {
	store.registerProject({ id: "project", kind: "directory", canonicalIdentity: cwd, cwd, root: cwd });
	store.upsertSession({ id: sessionManager.getSessionId(), projectId: "project", mode: "primary" });
}

describe("managed-context maintenance leases", () => {
	it("serializes one lease domain across independent database connections", async () => {
		const directory = await temporaryDirectory("context-domain-lease-");
		const databasePath = path.join(directory, "context.db");
		const first = await ContextStore.open({ path: databasePath });
		first.registerProject({
			id: "project",
			kind: "directory",
			canonicalIdentity: directory,
			cwd: directory,
			root: directory,
		});
		const second = await ContextStore.open({ path: databasePath });
		try {
			expect(first.diagnostics().schemaVersion).toBe(5);
			expect(first.tryAcquireJobDomainLease("project", "memory-maintenance", "owner-a", 30_000)).toBe(true);
			expect(second.tryAcquireJobDomainLease("project", "memory-maintenance", "owner-b", 30_000)).toBe(false);
			expect(first.heartbeatJobDomainLease("project", "memory-maintenance", "owner-a", 30_000)).toBe(true);
			expect(first.releaseJobDomainLease("project", "memory-maintenance", "owner-a")).toBe(true);
			expect(second.tryAcquireJobDomainLease("project", "memory-maintenance", "owner-b", 30_000)).toBe(true);
		} finally {
			first.close();
			second.close();
		}
	});

	it("rebuilds domain leases when reopening a version-four database", async () => {
		const directory = await temporaryDirectory("context-domain-migration-");
		const databasePath = path.join(directory, "context.db");
		const bootstrap = await ContextStore.open({ path: databasePath });
		bootstrap.registerProject({
			id: "project",
			kind: "directory",
			canonicalIdentity: directory,
			cwd: directory,
			root: directory,
		});
		bootstrap.close();

		const legacy = new Database(databasePath);
		legacy.exec("DROP TABLE job_domain_leases; PRAGMA user_version = 4;");
		legacy.close();

		const migrated = await ContextStore.open({ path: databasePath });
		try {
			expect(migrated.diagnostics().schemaVersion).toBe(5);
			expect(migrated.tryAcquireJobDomainLease("project", "memory-maintenance", "owner", 30_000)).toBe(true);
		} finally {
			migrated.close();
		}
	});

	it("serializes manual scheduler work and releases leases on bounded abort", async () => {
		const directory = await temporaryDirectory("context-scheduler-lease-");
		const databasePath = path.join(directory, "context.db");
		const firstStore = await ContextStore.open({ path: databasePath });
		firstStore.registerProject({
			id: "project",
			kind: "directory",
			canonicalIdentity: directory,
			cwd: directory,
			root: directory,
		});
		const secondStore = await ContextStore.open({ path: databasePath });
		const settings = Settings.isolated({ "contextManager.dreamer.enabled": true });
		const started = Promise.withResolvers<void>();
		const blockingRun: ContextDreamTaskExecutor["run"] = async (_task, options) => {
			const signal = options.signal;
			if (!signal) throw new Error("Expected scheduler abort signal");
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			started.resolve();
			await aborted.promise;
			throw new Error("scheduler aborted");
		};
		const successfulRun: ContextDreamTaskExecutor["run"] = async task => ({
			changed: 1,
			summary: `${task}: recovered`,
		});
		const makeDreamer = (
			store: ContextStore,
			ownerId: string,
			run: ContextDreamTaskExecutor["run"],
		): ContextDreamer =>
			new ContextDreamer({
				store,
				settings,
				executor: { run } as unknown as ContextDreamTaskExecutor,
				sessionManager: SessionManager.inMemory(directory),
				getMemoryAdapter: () => undefined,
				ownerId,
				getProjectId: () => "project",
				getSessionId: () => undefined,
				getCwd: () => directory,
			});
		const first = makeDreamer(firstStore, "owner-a", blockingRun);
		const second = makeDreamer(secondStore, "owner-b", successfulRun);
		try {
			const firstRun = first.runNow(["maintain-docs"], { force: true });
			await started.promise;
			const blocked = await second.runNow(["maintain-docs"], { force: true });
			expect(blocked[0]).toMatchObject({ status: "skipped" });
			expect(blocked[0]?.summary).toContain("lease held");
			const blockedJobId = blocked[0]?.jobId;
			if (!blockedJobId) throw new Error("Expected a blocked manual job");
			expect(secondStore.getJob(blockedJobId)?.status).toBe("cancelled");
			expect(secondStore.listJobs("project").filter(job => job.status === "pending")).toHaveLength(0);

			await first.dispose(1_000);
			expect((await firstRun)[0]).toMatchObject({ status: "failed" });
			const recovered = await second.runNow(["maintain-docs"], { force: true });
			expect(recovered[0]).toMatchObject({ status: "succeeded", changed: 1 });
		} finally {
			await first.dispose(1_000);
			await second.dispose(1_000);
			firstStore.close();
			secondStore.close();
		}
	});
});

describe("managed-context dream tasks", () => {
	it("maps project memories through validated metadata and makes memory-off tasks cost-free", async () => {
		const cwd = await temporaryDirectory("context-dream-task-");
		const settings = Settings.isolated({ "contextManager.language": "Simplified Chinese" });
		const sessionManager = SessionManager.inMemory(cwd);
		const store = await ContextStore.open({ path: ":memory:" });
		registerSession(store, sessionManager, cwd);
		let memory: ContextMemoryMaintenanceRecord = {
			id: "memory-1",
			bank: "project",
			scope: "project",
			content: "A repository-independent durable fact",
			editable: true,
			recallCount: 0,
			metadata: {},
		};
		const adapter: ContextMemoryAdapter = {
			available: true,
			autoRecall: true,
			projectBank: "project",
			userBank: "user",
			embeddingIdentity: { enabled: false, provider: "none", model: "none" },
			recall: async query => ({ query, project: [], user: [] }),
			read: id => (id === memory.id ? memory : undefined),
			remember: async () => undefined,
			edit: (_operation, id) => ({ status: "not_found", id }),
			merge: async () => undefined,
			list: scope => (scope === "user" ? [] : [memory]),
			patch: (id: string, input: ContextMemoryPatchInput) => {
				if (id !== memory.id) return { status: "not_found", id };
				memory = { ...memory, ...input };
				return { status: "updated", id, bank: memory.bank, scope: memory.scope };
			},
			embedBatch: async () => undefined,
			cosineSimilarity: () => 0,
		};
		const run = vi.fn(async (input: ContextAgentRunInput) => {
			expect(input.userPrompt).toContain("Simplified Chinese");
			return JSON.stringify({
				actions: [
					{
						id: memory.id,
						action: "map",
						backingFiles: [],
						fileIndependent: true,
						reason: "not tied to one file",
					},
				],
			});
		});
		const runner: ContextAgentRunner = {
			resolveCandidates: role => [candidate(role)],
			run,
		};
		const executor = new ContextDreamTaskExecutor({
			store,
			settings,
			runner,
			sessionManager,
			getMemoryAdapter: () => adapter,
			getProjectId: () => "project",
			getSessionId: () => sessionManager.getSessionId(),
			getCwd: () => cwd,
		});
		const result = await executor.run("map-memories", { forced: true });
		expect(result.changed).toBe(1);
		expect(memory.metadata).toMatchObject({
			managedContext: {
				backingFiles: [],
				fileIndependent: true,
				sourceTask: "map-memories",
			},
		});
		expect(run).toHaveBeenCalledTimes(1);

		const disabledExecutor = new ContextDreamTaskExecutor({
			store,
			settings,
			runner,
			sessionManager,
			getMemoryAdapter: () => undefined,
			getProjectId: () => "project",
			getSessionId: () => sessionManager.getSessionId(),
			getCwd: () => cwd,
		});
		const skipped = await disabledExecutor.run("verify", { forced: true });
		expect(skipped.changed).toBe(0);
		expect(skipped.summary).toContain("Mnemopi is unavailable");
		expect(run).toHaveBeenCalledTimes(1);
		store.close();
	});
});

describe("managed-context prompt wrappers", () => {
	it("preserves recalled and summarized text bytes inside static XML templates", () => {
		const exact = "line with trailing spaces  \n\n\n| column | value |\n| --- | --- |\n";
		const memory = renderContextMemory(
			{
				query: "formatting",
				project: [{ id: "memory", bank: "project", scope: "project", content: exact, score: 1 }],
				user: [],
			},
			10_000,
		);
		expect(memory.block).toContain(exact);

		const history = renderTieredHistory(
			[
				{
					id: "compartment",
					sessionId: "session",
					scopeLeafEntryId: "leaf",
					startTag: 1,
					endTag: 2,
					tagOrdinals: [1, 2],
					title: "Formatting",
					p1: exact,
					p2: exact,
					p3: exact,
					p1Tokens: 1,
					p2Tokens: 1,
					p3Tokens: 1,
					sourceHash: "hash",
					historianVersion: 1,
					generation: 1,
					active: true,
					createdAt: 1,
				},
			],
			10_000,
			false,
		);
		expect(history.block).toContain(exact);
	});
});

describe("managed-context memory bridge", () => {
	it("owns recall injection and reuses one bounded memory block for the same prompt", async () => {
		const cwd = await temporaryDirectory("context-memory-bridge-");
		const sessionManager = SessionManager.inMemory(cwd);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated(),
			sessionManager,
			storePath: ":memory:",
		});
		const recall = vi.fn(async (query: string) => ({
			query,
			project:
				query === "No matching memory"
					? []
					: [
							{
								id: "memory-1",
								bank: "project",
								scope: "project" as const,
								content: "The repository uses deterministic routing.",
								score: 0.95,
							},
						],
			user: [],
		}));
		const adapter: ContextMemoryAdapter = {
			available: true,
			autoRecall: true,
			projectBank: "project",
			userBank: "user",
			embeddingIdentity: { enabled: false, provider: "none", model: "none" },
			recall,
			read: () => undefined,
			remember: async () => undefined,
			edit: (_operation, id) => ({ status: "not_found", id }),
			merge: async () => undefined,
			list: () => [],
			patch: (id: string) => ({ status: "not_found", id }),
			embedBatch: async () => undefined,
			cosineSimilarity: () => 0,
		};
		controller.setMemoryAdapter(adapter);
		try {
			const first = await controller.decorateSystemPrompt(["base"], undefined, "How is routing configured?");
			const second = await controller.decorateSystemPrompt(["base"], undefined, "How is routing configured?");
			expect(recall).toHaveBeenCalledTimes(1);
			expect(first).toEqual(second);
			expect(first.join("\n").match(/<project-memory/g)).toHaveLength(1);
			expect(first.join("\n")).toContain("deterministic routing");

			const emptyFirst = await controller.decorateSystemPrompt(["base"], undefined, "No matching memory");
			const emptySecond = await controller.decorateSystemPrompt(["base"], undefined, "No matching memory");
			expect(recall).toHaveBeenCalledTimes(2);
			expect(emptyFirst).toEqual(["base"]);
			expect(emptySecond).toEqual(["base"]);
		} finally {
			await controller.dispose();
		}
	});
});

describe("managed-context side agents and documents", () => {
	it("fails sidekick augmentation open without changing the user prompt", async () => {
		const settings = Settings.isolated({ "contextManager.sidekick.enabled": true });
		const runner: ContextAgentRunner = {
			resolveCandidates: role => [candidate(role)],
			run: async () => {
				throw new Error("provider unavailable");
			},
		};
		const result = await new ContextSidekick(settings, runner).augment("Keep the original question");
		expect(result).toEqual({
			status: "failed",
			prompt: "Keep the original question",
			warning: "provider unavailable",
		});
	});

	it("preserves original user bytes in successful sidekick augmentation", async () => {
		const original = "  preserve leading spaces  \n\n\nand trailing spaces  \n";
		const runner: ContextAgentRunner = {
			resolveCandidates: role => [candidate(role)],
			run: async input => {
				expect(input.userPrompt).toContain("Simplified Chinese");
				return "Relevant context from indexed history.";
			},
		};
		const result = await new ContextSidekick(
			Settings.isolated({
				"contextManager.sidekick.enabled": true,
				"contextManager.language": "Simplified Chinese",
			}),
			runner,
		).augment(original);
		expect(result.status).toBe("augmented");
		if (result.status !== "augmented") throw new Error("Expected sidekick augmentation");
		expect(result.prompt.slice(0, original.length)).toBe(original);
		expect(result.prompt.slice(original.length)).toContain("<sidekick-augmentation>");
	});

	it("injects only bounded project documents and labels them as untrusted data", async () => {
		const cwd = await temporaryDirectory("context-project-docs-");
		await Bun.write(path.join(cwd, "ARCHITECTURE.md"), "# Architecture\nCanonical project facts.");
		const settings = Settings.isolated();
		const sessionManager = SessionManager.inMemory(cwd);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings,
			sessionManager,
			storePath: ":memory:",
		});
		try {
			const decorated = await controller.decorateSystemPrompt(["base"]);
			expect(decorated[0]).toBe("base");
			expect(decorated[1]).toContain("<project-docs>");
			expect(decorated[1]).toContain("untrusted reference data");
			expect(decorated[1]).toContain("Canonical project facts.");
		} finally {
			await controller.dispose();
		}
	});
});
