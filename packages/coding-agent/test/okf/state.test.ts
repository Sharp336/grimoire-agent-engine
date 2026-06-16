import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { getBundleRoot, type OkfConceptSummary, writeConcept } from "../../src/okf/bundle";
import { OkfSessionState, startOkfLayer } from "../../src/okf/state";
import type { OkfSearchResult, OkfStore } from "../../src/okf/store/types";

class FakeOkfStore implements OkfStore {
	readonly searchQueries: string[] = [];
	readonly upserts: { summary: OkfConceptSummary; body: string }[] = [];

	constructor(readonly resultId = "architecture/auth") {}
	async upsert(summary: OkfConceptSummary, body: string): Promise<void> {
		this.upserts.push({ summary, body });
	}

	async get(): Promise<undefined> {
		return undefined;
	}

	async delete(): Promise<void> {}

	async list(): Promise<OkfConceptSummary[]> {
		return [];
	}

	async search(query: string): Promise<OkfSearchResult[]> {
		this.searchQueries.push(query);
		return [
			{
				id: this.resultId,
				type: "Architecture",
				title: this.resultId.includes("/") ? "Auth" : "Deploy",
				description: "Auth flow overview",
				tags: ["auth"],
				score: 0,
			},
		];
	}

	async count(): Promise<number> {
		return 0;
	}

	async close(): Promise<void> {}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("okf/state OkfSessionState", () => {
	it("does not block startup on the initial reindex", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "okf-start-"));
		const finishReindex = Promise.withResolvers<number>();
		const reindexSpy = vi
			.spyOn(OkfSessionState.prototype, "reindex")
			.mockImplementation(async () => await finishReindex.promise);
		const settings = Settings.isolated();
		settings.set("okf.enabled", true);
		settings.set("okf.reindexOnStart", true);
		settings.set("okf.store", "sqlite");
		const startup = startOkfLayer({ sessionId: "session", settings, cwd, taskDepth: 0 });
		try {
			const result = await Promise.race([startup, Bun.sleep(100).then(() => "blocked" as const)]);

			expect(result).toBeInstanceOf(OkfSessionState);
			expect(reindexSpy).toHaveBeenCalledTimes(1);
		} finally {
			finishReindex.resolve(0);
			const state = await startup.catch(() => undefined);
			state?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	it("injects auto-recall only for the first user turn", async () => {
		const settings = Settings.isolated();
		settings.set("okf.autoRecall", true);
		settings.set("okf.recallMaxTokens", 800);
		const store = new FakeOkfStore();
		const state = new OkfSessionState({ sessionId: "session", settings, cwd: process.cwd(), store });

		const first = await state.beforeAgentStartPrompt("debug the auth login flow");
		const second = await state.beforeAgentStartPrompt("now inspect billing webhooks");
		const developerInstructions = await state.buildDeveloperInstructions();

		expect(first).toContain("Auth flow overview");
		expect(second).toBeUndefined();
		expect(store.searchQueries).toHaveLength(1);
		expect(developerInstructions).not.toContain("Auth flow overview");
	});

	it("keeps first-turn auto-recall independent for alias states", async () => {
		const settings = Settings.isolated();
		settings.set("okf.autoRecall", true);
		settings.set("okf.recallMaxTokens", 800);
		const store = new FakeOkfStore();
		const parent = new OkfSessionState({ sessionId: "parent", settings, cwd: process.cwd(), store });
		const alias = new OkfSessionState({ sessionId: "subagent", settings, cwd: process.cwd(), aliasOf: parent });

		const parentSnippet = await parent.beforeAgentStartPrompt("debug the auth login flow");
		const aliasSnippet = await alias.beforeAgentStartPrompt("summarize the auth middleware");

		expect(parentSnippet).toContain("Auth flow overview");
		expect(aliasSnippet).toContain("Auth flow overview");
		expect(store.searchQueries).toHaveLength(2);
	});

	it("uses path-only okf links for root-level recalled concepts", async () => {
		const settings = Settings.isolated();
		settings.set("okf.autoRecall", true);
		settings.set("okf.recallMaxTokens", 800);
		const store = new FakeOkfStore("deploy");
		const state = new OkfSessionState({ sessionId: "session", settings, cwd: process.cwd(), store });

		const snippet = await state.beforeAgentStartPrompt("deploy checklist");

		expect(snippet).toContain("(okf:///deploy.md)");
		expect(snippet).not.toContain("(okf://deploy.md)");
	});

	it("resolves a relative okf.bundleDir against the session cwd, not the process cwd", () => {
		// A session cwd outside the process cwd (mimics ACP/subagent/embedded hosts
		// where the process dir differs from the active project).
		const sessionCwd = path.join(os.tmpdir(), "okf-session-root");
		const settings = Settings.isolated();
		settings.set("okf.bundleDir", "custom/knowledge");
		const state = new OkfSessionState({ sessionId: "session", settings, cwd: sessionCwd, store: new FakeOkfStore() });

		// Must resolve against the session cwd — matching `okf://` reads/writes —
		// never against the process cwd.
		expect(state.bundleRoot).toBe(path.resolve(sessionCwd, "custom/knowledge"));
		expect(state.bundleRoot.startsWith(sessionCwd)).toBe(true);
	});

	it("indexConcept upserts a just-written concept into the active store", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "okf-index-"));
		try {
			const settings = Settings.isolated();
			const store = new FakeOkfStore();
			const state = new OkfSessionState({ sessionId: "session", settings, cwd: tmpDir, store });

			// Simulate an okf:// write landing on disk, then index it.
			await writeConcept(
				getBundleRoot(tmpDir),
				"tables/orders",
				"---\ntype: Table\ndescription: orders\n---\n\n# Schema",
			);
			await state.indexConcept("tables/orders");

			expect(store.upserts).toHaveLength(1);
			expect(store.upserts[0]!.summary.id).toBe("tables/orders");
			expect(store.upserts[0]!.summary.type).toBe("Table");
			expect(store.upserts[0]!.body).toContain("# Schema");
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("re-runs auto-recall after resetFirstTurnRecall for a new transcript", async () => {
		const settings = Settings.isolated();
		settings.set("okf.autoRecall", true);
		settings.set("okf.recallMaxTokens", 800);
		const store = new FakeOkfStore();
		const state = new OkfSessionState({ sessionId: "session", settings, cwd: process.cwd(), store });

		const first = await state.beforeAgentStartPrompt("debug the auth login flow");
		const later = await state.beforeAgentStartPrompt("now inspect billing webhooks");
		expect(first).toContain("Auth flow overview");
		expect(later).toBeUndefined();
		expect(store.searchQueries).toHaveLength(1);

		// A new transcript (/new, handoff, branch, session switch) must reset the
		// first-turn guard so the new conversation's opening turn re-recalls.
		state.resetFirstTurnRecall();
		const afterReset = await state.beforeAgentStartPrompt("fresh auth question");
		expect(afterReset).toContain("Auth flow overview");
		expect(store.searchQueries).toHaveLength(2);
	});
});
