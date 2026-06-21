import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { Settings } from "../../config/settings";
import { closeCodemapDb } from "../db";
import { injectCodemapTaskContext } from "../index";
import { initSchema } from "../schema";
import type { CodemapSessionState } from "../state";
import { upsertSummary } from "../store";

// --- Test fixtures ----------------------------------------------------------

const TASK = "implement user authentication with JWT";
let tmpDir: string;
let cwd: string;
let projectLabel: string;
let dbPath: string;
let client: Client;

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-inj-"));
	cwd = path.join(tmpDir, "project");
	projectLabel = path.basename(cwd);
	fs.mkdirSync(cwd, { recursive: true });
	dbPath = path.join(tmpDir, "codemap-test.db");
	client = createClient({ url: `file:${dbPath}` });
	await initSchema(client);

	// Seed summaries that match the task keywords (auth, JWT, user).
	await fs.promises.mkdir(path.join(cwd, "src"), { recursive: true });
	await fs.promises.writeFile(path.join(cwd, "src", "auth.ts"), "export function login() {}");
	await upsertSummary(client, {
		projectLabel,
		filePath: "src/auth.ts",
		summaryText: "JWT authentication middleware. Verifies tokens and guards protected routes.",
		contentHash: "irrelevant-for-fts",
		maxSummaryChars: 1000,
		symbolName: null,
		symbolKind: null,
	});
	await fs.promises.writeFile(path.join(cwd, "src", "user.ts"), "export interface User {}");
	await upsertSummary(client, {
		projectLabel,
		filePath: "src/user.ts",
		summaryText: "User model and session management for authentication flows.",
		contentHash: "irrelevant-for-fts",
		maxSummaryChars: 1000,
		symbolName: null,
		symbolKind: null,
	});
});

afterAll(async () => {
	await closeCodemapDb(client);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort.
	}
});

function makeConfig(): CodemapSessionState["config"] {
	return {
		enabled: true,
		autoInject: true,
		dbPath,
		tokenBudget: 8000,
		maxResults: 20,
		maxSummaryChars: 1000,
		turso: { syncUrl: "", authToken: "", autoProvision: false, org: "" },
		embedding: {
			model: "BAAI/bge-base-en-v1.5",
			variant: "en",
			apiUrl: undefined,
			apiKey: undefined,
			dimensions: 768,
		},
	};
}

function makeState(overrides: Partial<CodemapSessionState> = {}): CodemapSessionState {
	return {
		client,
		config: makeConfig(),
		hasInjectedForFirstTurn: false,
		...overrides,
	};
}

// --- Guard chain: returns null when gated off -------------------------------

describe("codemap injectCodemapTaskContext — guard chain", () => {
	it("returns null when codemap.enabled is false", async () => {
		const settings = Settings.isolated({ "codemap.enabled": false });
		const markInjected = mock(() => {});
		const result = await injectCodemapTaskContext(settings, makeState(), cwd, TASK, markInjected);
		expect(result).toBeNull();
		expect(markInjected).not.toHaveBeenCalled();
	});

	it("returns null when codemap.autoInject is false", async () => {
		const settings = Settings.isolated({
			"codemap.enabled": true,
			"codemap.autoInject": false,
		});
		const markInjected = mock(() => {});
		const result = await injectCodemapTaskContext(settings, makeState(), cwd, TASK, markInjected);
		expect(result).toBeNull();
		expect(markInjected).not.toHaveBeenCalled();
	});

	it("returns null when no session state exists (codemap not initialized)", async () => {
		const settings = Settings.isolated({ "codemap.enabled": true });
		const markInjected = mock(() => {});
		const result = await injectCodemapTaskContext(settings, undefined, cwd, TASK, markInjected);
		expect(result).toBeNull();
		expect(markInjected).not.toHaveBeenCalled();
	});

	it("returns null when already injected for first turn", async () => {
		const settings = Settings.isolated({ "codemap.enabled": true, "codemap.autoInject": true });
		const markInjected = mock(() => {});
		const state = makeState({ hasInjectedForFirstTurn: true });
		const result = await injectCodemapTaskContext(settings, state, cwd, TASK, markInjected);
		expect(result).toBeNull();
		expect(markInjected).not.toHaveBeenCalled();
	});
});

// --- Composes with memory.backend="off" -------------------------------------
// The function takes Settings directly — it never touches memory.backend.
// This test verifies that: with backend="off" in settings, injection still works.

describe("codemap injectCodemapTaskContext — composes with memory.backend off", () => {
	it("injects summaries even when memory.backend is off", async () => {
		const settings = Settings.isolated({
			"codemap.enabled": true,
			"codemap.autoInject": true,
			"memory.backend": "off",
		});
		const markInjected = mock(() => {});
		const result = await injectCodemapTaskContext(settings, makeState(), cwd, TASK, markInjected);
		expect(result).not.toBeNull();
		expect(markInjected).toHaveBeenCalled();
		expect(result).toContain("Relevant Code Summaries");
	});
});

// --- Once-per-session guard -------------------------------------------------

describe("codemap injectCodemapTaskContext — fires once per session", () => {
	it("first call returns injection block and marks injected", async () => {
		const settings = Settings.isolated({ "codemap.enabled": true, "codemap.autoInject": true });
		const markInjected = mock(() => {});
		const state = makeState();
		const result = await injectCodemapTaskContext(settings, state, cwd, TASK, markInjected);
		expect(result).not.toBeNull();
		expect(markInjected).toHaveBeenCalledTimes(1);
	});

	it("second call (after markInjected set the flag) returns null", async () => {
		const settings = Settings.isolated({ "codemap.enabled": true, "codemap.autoInject": true });
		const state = makeState();
		// Simulate the first call having set the flag via markInjected.
		const markFirst = mock(() => {
			state.hasInjectedForFirstTurn = true;
		});
		const first = await injectCodemapTaskContext(settings, state, cwd, TASK, markFirst);
		expect(first).not.toBeNull();

		// Second call — state.hasInjectedForFirstTurn is now true.
		const markSecond = mock(() => {});
		const second = await injectCodemapTaskContext(settings, state, cwd, TASK, markSecond);
		expect(second).toBeNull();
		expect(markSecond).not.toHaveBeenCalled();
	});
});

// --- Error isolation --------------------------------------------------------

describe("codemap injectCodemapTaskContext — error isolation", () => {
	it("returns null (never throws) when getTaskContext fails", async () => {
		const settings = Settings.isolated({ "codemap.enabled": true, "codemap.autoInject": true });
		// Pass a broken client that will throw on query.
		const brokenState = makeState({
			client: {
				execute: () => {
					throw new Error("DB corrupted");
				},
			} as unknown as Client,
		});
		const markInjected = mock(() => {});
		// Must NOT throw — injection must never break agent start.
		const result = await injectCodemapTaskContext(settings, brokenState, cwd, TASK, markInjected);
		expect(result).toBeNull();
		expect(markInjected).not.toHaveBeenCalled();
	});
});

// --- Injection block content ------------------------------------------------

describe("codemap injectCodemapTaskContext — block content", () => {
	it("includes the task text and matched file summaries", async () => {
		const settings = Settings.isolated({ "codemap.enabled": true, "codemap.autoInject": true });
		const markInjected = mock(() => {});
		const result = await injectCodemapTaskContext(settings, makeState(), cwd, TASK, markInjected);
		expect(result).toContain(`task: "${TASK}"`);
		// FTS should match auth.ts (JWT authentication) — it has both "auth" and "jwt" keywords.
		expect(result).toContain("src/auth.ts");
	});
});
