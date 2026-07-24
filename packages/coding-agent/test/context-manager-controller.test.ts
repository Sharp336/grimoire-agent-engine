import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import type { ContextAgentRunner } from "../src/context-manager/agent-runner";
import { ContextManagerController } from "../src/context-manager/controller";
import { decideHistorianTrigger } from "../src/context-manager/historian";
import type { ContextMemoryAdapter } from "../src/context-manager/memory";
import { injectAutoSearchHint } from "../src/context-manager/search";
import { SessionManager } from "../src/session/session-manager";
import * as git from "../src/utils/git";

const temporaryDirectories: string[] = [];
const model = { provider: "test", id: "test", contextWindow: 128_000 } as Model;

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "context-controller-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function appendTurns(sessionManager: SessionManager, count: number): void {
	const start = Date.now() - 100_000;
	for (let index = 0; index < count; index++) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `request ${index} with durable details` }],
			timestamp: start + index * 2_000,
		});
		sessionManager.appendMessage(
			assistant(`completed ${index} with verified outcome`, start + index * 2_000 + 1_000),
		);
	}
}

function appendToolTurn(sessionManager: SessionManager, timestamp: number): void {
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "read the project configuration" }],
		timestamp,
	});
	sessionManager.appendMessage({
		...assistant("", timestamp + 1),
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "config.yml" } }],
		stopReason: "toolUse",
	});
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "mode: managed" }],
		isError: false,
		timestamp: timestamp + 2,
	});
}

function canonicalMessages(sessionManager: SessionManager) {
	return sessionManager
		.getBranch()
		.filter(entry => entry.type === "message")
		.map(entry => entry.message);
}

describe("managed-context controller", () => {
	it("reduces a complete protocol-safe turn, expands canonical source, and never mutates stored messages", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendTurns(sessionManager, 3);
		const settings = Settings.isolated({
			"contextManager.protectedTags": 2,
			"contextManager.cacheTtl": { default: "0s" },
			"contextManager.historian.enabled": false,
		});
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings,
			sessionManager,
			storePath: ":memory:",
		});
		try {
			const canonical = canonicalMessages(sessionManager);
			const original = JSON.stringify(canonical);
			await controller.prepareCanonicalMessages(canonical);
			const firstWire = await controller.transformContext(canonical, undefined, model);
			expect(JSON.stringify(firstWire)).toContain("§1§");

			const reduction = await controller.reduceTags([1]);
			expect(reduction).toMatchObject({ status: "queued", requestedTags: [1], expandedTags: [1, 2] });
			const flush = await controller.flush(model);
			expect(flush).toMatchObject({ status: "ok", activatedDrops: 1, activeDrops: 1 });
			const reducedWire = await controller.transformContext(canonical, undefined, model);
			expect(reducedWire).toHaveLength(canonical.length - 2);

			const expansion = await controller.expandTags([1], true);
			expect(expansion.foundTags).toEqual([1]);
			expect(expansion.content).toContain("request 0 with durable details");
			const restoredWire = await controller.transformContext(canonical, undefined, model);
			expect(restoredWire).toHaveLength(canonical.length);
			expect(JSON.stringify(canonical)).toBe(original);
		} finally {
			await controller.dispose();
		}
	});

	it("delays queued reductions until the provider cache TTL expires", async () => {
		vi.useFakeTimers();
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendTurns(sessionManager, 3);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({
				"contextManager.protectedTags": 2,
				"contextManager.cacheTtl": { default: "1h" },
				"contextManager.historian.enabled": false,
			}),
			sessionManager,
			storePath: ":memory:",
		});
		try {
			const canonical = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(canonical);
			await controller.transformContext(canonical, undefined, model);
			await controller.reduceTags([1]);
			expect(await controller.transformContext(canonical, undefined, model)).toHaveLength(6);
			expect((await controller.diagnostics()).drops).toMatchObject({ active: 0, queued: 1 });

			vi.advanceTimersByTime(3_600_001);
			expect(await controller.transformContext(canonical, undefined, model)).toHaveLength(4);
			expect((await controller.diagnostics()).drops).toMatchObject({ active: 1, queued: 0 });
		} finally {
			await controller.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps append-only wire prefixes byte-stable across forty turns", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendTurns(sessionManager, 5);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({ "contextManager.historian.enabled": false }),
			sessionManager,
			storePath: ":memory:",
		});
		try {
			const initial = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(initial);
			const initialWire = await controller.transformContext(initial, undefined, model);
			const stablePrefix = JSON.stringify(initialWire);

			appendTurns(sessionManager, 35);
			const extended = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(extended);
			const extendedWire = await controller.transformContext(extended, undefined, model);
			expect(extendedWire).toHaveLength(80);
			expect(JSON.stringify(extendedWire.slice(0, initialWire.length))).toBe(stablePrefix);
		} finally {
			await controller.dispose();
		}
	});

	it("expands reductions to complete multi-message tool protocol units", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendToolTurn(sessionManager, Date.now() - 10_000);
		appendTurns(sessionManager, 1);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({
				"contextManager.protectedTags": 2,
				"contextManager.cacheTtl": { default: "0s" },
				"contextManager.historian.enabled": false,
			}),
			sessionManager,
			storePath: ":memory:",
		});
		try {
			const canonical = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(canonical);
			const reduction = await controller.reduceTags([2]);
			expect(reduction).toMatchObject({
				status: "queued",
				requestedTags: [2],
				expandedTags: [1, 2, 3],
			});
			await controller.flush(model);
			const wire = await controller.transformContext(canonical, undefined, model);
			expect(wire).toHaveLength(2);
			expect(JSON.stringify(wire)).not.toContain("call-1");
		} finally {
			await controller.dispose();
		}
	});

	it("does not leak a later branch reduction into an earlier sibling branch", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendTurns(sessionManager, 3);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({
				"contextManager.protectedTags": 2,
				"contextManager.cacheTtl": { default: "0s" },
				"contextManager.historian.enabled": false,
			}),
			sessionManager,
			storePath: ":memory:",
		});
		try {
			const mainBranch = sessionManager.getBranch();
			const canonical = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(canonical);
			await controller.reduceTags([1]);
			await controller.flush(model);
			expect(await controller.transformContext(canonical, undefined, model)).toHaveLength(4);

			const siblingRoot = mainBranch[1];
			if (!siblingRoot) throw new Error("Expected the first completed turn");
			sessionManager.branch(siblingRoot.id);
			appendTurns(sessionManager, 1);
			const sibling = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(sibling);
			const siblingWire = await controller.transformContext(sibling, undefined, model);
			expect(siblingWire).toHaveLength(4);
			expect(JSON.stringify(siblingWire)).toContain("request 0 with durable details");
		} finally {
			await controller.dispose();
		}
	});

	it("copies visible tag and drop state transactionally when a session file forks", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		appendTurns(sessionManager, 3);
		await sessionManager.flush();
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({
				"contextManager.protectedTags": 2,
				"contextManager.cacheTtl": { default: "0s" },
				"contextManager.historian.enabled": false,
			}),
			sessionManager,
			storePath: path.join(cwd, "context.db"),
		});
		try {
			const canonical = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(canonical);
			await controller.reduceTags([1]);
			await controller.flush(model);
			expect(await controller.transformContext(canonical, undefined, model)).toHaveLength(4);

			const sourceSessionId = sessionManager.getSessionId();
			const forked = await sessionManager.fork();
			expect(forked).toBeDefined();
			expect(sessionManager.getSessionId()).not.toBe(sourceSessionId);
			const forkCanonical = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(forkCanonical);
			expect(await controller.transformContext(forkCanonical, undefined, model)).toHaveLength(4);
			expect((await controller.diagnostics()).drops).toMatchObject({ active: 1, queued: 0 });
		} finally {
			await controller.dispose();
			await sessionManager.close();
		}
	});

	it("restores tag generations and active drops after a database restart", async () => {
		const cwd = await temporaryDirectory();
		const databasePath = path.join(cwd, "context.db");
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		appendTurns(sessionManager, 3);
		await sessionManager.flush();
		const settings = Settings.isolated({
			"contextManager.protectedTags": 2,
			"contextManager.cacheTtl": { default: "0s" },
			"contextManager.historian.enabled": false,
		});
		const first = await ContextManagerController.create({
			mode: "primary",
			settings,
			sessionManager,
			storePath: databasePath,
		});
		let restarted: ContextManagerController | undefined;
		try {
			const canonical = canonicalMessages(sessionManager);
			await first.prepareCanonicalMessages(canonical);
			await first.reduceTags([1]);
			await first.flush(model);
			await first.dispose();

			restarted = await ContextManagerController.create({
				mode: "primary",
				settings,
				sessionManager,
				storePath: databasePath,
			});
			await restarted.prepareCanonicalMessages(canonical);
			expect(await restarted.transformContext(canonical, undefined, model)).toHaveLength(4);
			const diagnostics = await restarted.diagnostics();
			expect(diagnostics.tags.total).toBe(6);
			expect(diagnostics.drops).toMatchObject({ active: 1, queued: 0 });
		} finally {
			await first.dispose();
			await restarted?.dispose();
			await sessionManager.close();
		}
	});

	it("honors commit-cluster trigger enablement and minimum count", () => {
		const runtime = {
			sessionId: "session",
			modelKey: "test/test",
			contextLimit: 200_000,
			conversationTokens: 0,
			toolCallTokens: 0,
			nonMessageTokens: 0,
			totalTokens: 0,
			pressurePercent: 0,
			executeThresholdTokens: 100_000,
			cacheTtlMs: 0,
			updatedAt: 0,
			cleanupWatermarkTag: 0,
		};
		const chunk = { units: [], tags: [], entries: [], tokenCount: 6_000, commitClusters: 2 };
		expect(decideHistorianTrigger(runtime, chunk, 30_000, false, 0).shouldRun).toBe(false);
		expect(decideHistorianTrigger(runtime, chunk, 30_000, false, 2)).toMatchObject({
			shouldRun: true,
			reason: "commit-clusters",
		});
	});

	it("publishes validated tiered history that shrinks wire context while preserving canonical history", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendTurns(sessionManager, 5);
		const settings = Settings.isolated({
			"contextManager.protectedTags": 2,
			"contextManager.historian.twoPass": false,
			"contextManager.historian.tools": ["ctx_search"],
			"contextManager.language": "Simplified Chinese",
		});
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings,
			sessionManager,
			storePath: ":memory:",
		});
		const runner: ContextAgentRunner = {
			resolveCandidates: role => [
				{
					role,
					model,
					thinkingLevel: undefined,
					selector: "test/test",
					activeModelFallback: false,
				},
			],
			run: async input => {
				expect(input.toolNames).toEqual(["ctx_search"]);
				expect(input.systemPrompt).toContain("explicitly granted tools: ctx_search");
				expect(input.userPrompt).toContain("Simplified Chinese");
				const tags = [...input.userPrompt.matchAll(/"tag":\s*(\d+)/g)].map(match => Number(match[1]));
				return JSON.stringify({
					compartments: [
						{
							startTag: Math.min(...tags),
							endTag: Math.max(...tags),
							title: "Completed work",
							p1: "Done.",
							p2: "I completed the requested work.",
							p3: "I completed the requested work and preserved the verified decisions and outcomes.",
							startDate: new Date(Date.now() - 100_000).toISOString(),
							endDate: new Date().toISOString(),
						},
					],
					facts: [],
				});
			},
		};
		controller.setAgentRunner(runner);
		try {
			const canonical = canonicalMessages(sessionManager);
			const original = JSON.stringify(canonical);
			await controller.prepareCanonicalMessages(canonical);
			await controller.transformContext(canonical, undefined, model);

			const result = await controller.recomp();
			expect(result).toMatchObject({ status: "published", compartments: 1, startTag: 1, endTag: 8 });
			const wire = await controller.transformContext(canonical, undefined, model);
			expect(wire.length).toBeLessThan(canonical.length);
			expect(JSON.stringify(wire)).toContain("Completed work");
			expect(JSON.stringify(canonical)).toBe(original);
			const diagnostics = await controller.diagnostics();
			expect(diagnostics.compartments.total).toBe(1);
			expect(diagnostics.tags.dropped).toBe(8);
		} finally {
			await controller.dispose();
		}
	});

	it("keeps the published generation unchanged when historian validation fails", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendTurns(sessionManager, 5);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({
				"contextManager.protectedTags": 2,
				"contextManager.historian.twoPass": false,
			}),
			sessionManager,
			storePath: ":memory:",
		});
		controller.setAgentRunner({
			resolveCandidates: role => [
				{
					role,
					model,
					thinkingLevel: undefined,
					selector: "test/test",
					activeModelFallback: false,
				},
			],
			run: async () => '{"compartments":"invalid","facts":[]}',
		});
		try {
			const canonical = canonicalMessages(sessionManager);
			const original = JSON.stringify(canonical);
			await controller.prepareCanonicalMessages(canonical);
			const before = await controller.transformContext(canonical, undefined, model);
			const result = await controller.recomp();
			expect(result.status).toBe("failed");
			const after = await controller.transformContext(canonical, undefined, model);
			expect(after).toEqual(before);
			expect((await controller.diagnostics()).compartments.total).toBe(0);
			expect(JSON.stringify(canonical)).toBe(original);
		} finally {
			await controller.dispose();
		}
	});

	it("preserves the original user bytes when appending an automatic search hint", () => {
		const original = "  leading spaces  \n\n\nline with trailing spaces  \n";
		const hint = '<ctx-search-hint generation="1">result</ctx-search-hint>';
		const messages = injectAutoSearchHint([{ role: "user", content: original, timestamp: 1 }], hint);
		const message = messages[0];
		expect(message?.role).toBe("user");
		if (message?.role !== "user" || typeof message.content !== "string") {
			throw new Error("Expected a string user message");
		}
		expect(message.content.slice(0, original.length)).toBe(original);
		expect(message.content.slice(original.length)).toBe(`\n\n${hint}\n`);
	});

	it("indexes active notes into managed full-text search with canonical IDs", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated(),
			sessionManager,
			storePath: ":memory:",
		});
		try {
			const written = await controller.manageNote({
				action: "write",
				category: "architecture",
				content: "Quasar invariant requires deterministic routing",
				scope: "project",
			});
			const note = written.notes[0];
			const search = await controller.searchContext("quasar deterministic", { sources: ["note"] });
			expect(search.hits).toHaveLength(1);
			expect(search.hits[0]).toMatchObject({
				source: "note",
				id: note?.id,
				canonicalId: note?.id,
				title: "architecture",
			});
			expect(search.hits[0]?.snippet).toContain("Quasar invariant");
		} finally {
			await controller.dispose();
		}
	});

	it("fuses Mnemopi with embedded notes and caches deterministic automatic hints", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({
				"contextManager.embeddings.enabled": true,
				"contextManager.autoSearch.enabled": true,
				"contextManager.autoSearch.minPromptChars": 1,
				"contextManager.autoSearch.scoreThreshold": 0,
				"contextManager.historian.enabled": false,
			}),
			sessionManager,
			storePath: ":memory:",
		});
		const adapter: ContextMemoryAdapter = {
			available: true,
			autoRecall: true,
			projectBank: "project",
			userBank: "user",
			embeddingIdentity: { enabled: true, provider: "test", model: "embedding" },
			recall: async query => ({
				query,
				project: [
					{
						id: "memory-1",
						bank: "project",
						scope: "project",
						content: "Quasar routing uses a deterministic table.",
						score: 0.95,
					},
				],
				user: [],
			}),
			read: () => undefined,
			remember: async () => undefined,
			edit: (_operation, id) => ({ status: "not_found", id }),
			merge: async () => undefined,
			list: () => [],
			patch: (id: string) => ({ status: "not_found", id }),
			embedBatch: async texts => texts.map(() => Float32Array.of(1, 0)),
			cosineSimilarity: (left, right) => left[0]! * right[0]! + left[1]! * right[1]!,
		};
		controller.setMemoryAdapter(adapter);
		try {
			await controller.manageNote({
				action: "write",
				category: "architecture",
				content: "Quasar deterministic routing is enforced by the repository.",
				scope: "project",
			});
			const embedded = await controller.startEmbedding();
			expect(embedded).toMatchObject({ state: "idle", pending: 0 });
			expect(embedded.completed).toBeGreaterThan(0);

			const search = await controller.searchContext("quasar deterministic routing", {
				sources: ["memory", "note"],
			});
			expect(new Set(search.hits.map(hit => hit.source))).toEqual(new Set(["memory", "note"]));

			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Explain Quasar deterministic routing." }],
				timestamp: Date.now(),
			});
			sessionManager.appendMessage(assistant("I will inspect the context.", Date.now() + 1));
			const canonical = canonicalMessages(sessionManager);
			await controller.prepareCanonicalMessages(canonical);
			const firstWire = await controller.transformContext(canonical, undefined, model);
			const secondWire = await controller.transformContext(canonical, undefined, model);
			expect(JSON.stringify(firstWire)).toContain("<ctx-search-hint");
			expect(secondWire).toEqual(firstWire);
		} finally {
			await controller.dispose();
		}
	});

	it("indexes recent Git commits through the controlled repository helper", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const latest = (await git.log.metadata(repoRoot, { since: 0, maxCommits: 1 }))?.[0];
		if (!latest) throw new Error("Expected a non-merge Git commit");
		const controller = await ContextManagerController.create({
			mode: "primary",
			settings: Settings.isolated({
				"contextManager.gitCommitIndexing.enabled": true,
				"contextManager.gitCommitIndexing.sinceDays": 100_000,
				"contextManager.gitCommitIndexing.maxCommits": 10,
			}),
			sessionManager: SessionManager.inMemory(repoRoot),
			storePath: ":memory:",
		});
		try {
			expect(await controller.indexGit()).toBeGreaterThan(0);
			const search = await controller.searchContext(latest.subject, { sources: ["git_commit"] });
			expect(search.hits.some(hit => hit.canonicalId === latest.sha)).toBe(true);
		} finally {
			await controller.dispose();
		}
	});

	it("is byte-for-byte inert when managed context is disabled", async () => {
		const cwd = await temporaryDirectory();
		const sessionManager = SessionManager.inMemory(cwd);
		appendTurns(sessionManager, 2);
		const controller = await ContextManagerController.create({
			mode: "off",
			settings: Settings.isolated({ "contextManager.enabled": false }),
			sessionManager,
			storePath: ":memory:",
		});
		const canonical = canonicalMessages(sessionManager);
		const original = JSON.stringify(canonical);
		const wire = await controller.transformContext(canonical, undefined, model);
		expect(wire).toBe(canonical);
		expect(JSON.stringify(wire)).toBe(original);
		await controller.dispose();
	});
});
