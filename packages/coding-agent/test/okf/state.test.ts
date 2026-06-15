import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { OkfSessionState } from "../../src/okf/state";
import type { OkfSearchResult, OkfStore } from "../../src/okf/store/types";

class FakeOkfStore implements OkfStore {
	readonly searchQueries: string[] = [];

	constructor(readonly resultId = "architecture/auth") {}
	async upsert(): Promise<void> {}

	async get(): Promise<undefined> {
		return undefined;
	}

	async delete(): Promise<void> {}

	async list(): Promise<[]> {
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

describe("okf/state OkfSessionState", () => {
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
