import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

/**
 * End-to-end test for the fastcontext subagent with real model providers.
 *
 * Gated on E2E=1 to avoid running network calls in CI. Requires stored
 * credentials for the tested provider in ~/.omp/agent/agent.db.
 *
 * Run with: E2E=1 bun test test/tools/fastcontext-e2e.test.ts
 *
 * Confirms the fastcontext agent works with multiple model families:
 * - z.ai GLM (anthropic-messages API)
 * - umans GLM-5.2 (anthropic-messages API)
 * - OpenAI Codex GPT-5.5 (openai-codex-responses API)
 */

const E2E = Bun.env.E2E === "1";

// Derive the oh-my-pi repo root from this test file's location so the
// E2E test works regardless of where the checkout lives.
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

function getAgent(name: string): AgentDefinition {
	const agents = loadBundledAgents();
	const agent = agents.find(a => a.name === name);
	if (!agent) throw new Error(`Agent "${name}" not found in bundled agents`);
	return agent;
}

async function createAuthStorage(): Promise<{ auth: AuthStorage; db: Database }> {
	const dbPath = path.join(os.homedir(), ".omp", "agent", "agent.db");
	const db = new Database(dbPath, { readonly: true });
	const store = new SqliteAuthCredentialStore(db);
	const auth = new AuthStorage(store);
	await auth.reload();
	return { auth, db };
}

describe.skipIf(!E2E)("fastcontext subagent E2E", () => {
	let auth: AuthStorage;
	let db: Database;
	let tempCwd: string;

	beforeEach(async () => {
		const result = await createAuthStorage();
		auth = result.auth;
		db = result.db;
		tempCwd = path.join(os.tmpdir(), `fastcontext-e2e-${Date.now()}`);
		await fs.mkdir(tempCwd, { recursive: true });
	});

	afterEach(async () => {
		db.close();
		await fs.rm(tempCwd, { recursive: true, force: true }).catch(() => {});
	});

	it("runs with z.ai GLM model and yields structured citations", async () => {
		const zaiKey = await auth.getApiKey("zai");
		if (!zaiKey) {
			console.warn("Skipping z.ai E2E: no stored ZAI credential");
			return;
		}

		const agent = getAgent("fastcontext");
		const settings = Settings.isolated({ extensions: [], "mcp.discoveryMode": false });

		const result = await runSubprocess({
			cwd: REPO_ROOT,
			agent,
			task: `Find the function that resolves agent model patterns in the coding-agent package at ${REPO_ROOT}/packages/coding-agent. Return citations.`,
			assignment: "Find the function that resolves agent model patterns.",
			index: 0,
			id: "fastcontext-zai-e2e",
			modelOverride: ["zai/glm-5-turbo"],
			settings,
			enableLsp: false,
			authStorage: auth,
			preloadedExtensionPaths: [],
		});

		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.output).toBeTruthy();

		const parsed = JSON.parse(result.output);
		expect(parsed).toHaveProperty("citations");
		expect(parsed).toHaveProperty("summary");
		expect(Array.isArray(parsed.citations)).toBe(true);
		expect(parsed.citations.length).toBeGreaterThan(0);

		const firstCitation = parsed.citations[0];
		expect(firstCitation).toHaveProperty("path");
		expect(firstCitation).toHaveProperty("reason");
		expect(typeof firstCitation.path).toBe("string");
		expect(typeof firstCitation.reason).toBe("string");
	}, 120000);

	it("runs with umans GLM-5.2 model and yields structured citations", async () => {
		const umansKey = await auth.getApiKey("umans");
		if (!umansKey) {
			console.warn("Skipping umans E2E: no stored umans credential");
			return;
		}

		const agent = getAgent("fastcontext");
		const settings = Settings.isolated({ extensions: [], "mcp.discoveryMode": false });

		const result = await runSubprocess({
			cwd: REPO_ROOT,
			agent,
			task: `Find the SOFT_REQUEST_BUDGET constant in the task executor at ${REPO_ROOT}/packages/coding-agent. Return citations.`,
			assignment: "Find the SOFT_REQUEST_BUDGET constant.",
			index: 0,
			id: "fastcontext-umans-e2e",
			modelOverride: ["umans/umans-glm-5.2"],
			settings,
			enableLsp: false,
			authStorage: auth,
			preloadedExtensionPaths: [],
		});

		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.output).toBeTruthy();

		const parsed = JSON.parse(result.output);
		expect(parsed).toHaveProperty("citations");
		expect(parsed).toHaveProperty("summary");
		expect(Array.isArray(parsed.citations)).toBe(true);
		expect(parsed.citations.length).toBeGreaterThan(0);
	}, 120000);

	it("runs with OpenAI Codex GPT-5.5 model and yields structured citations", async () => {
		const codexKey = await auth.getApiKey("openai-codex");
		if (!codexKey) {
			console.warn("Skipping OpenAI Codex E2E: no stored credential");
			return;
		}

		const agent = getAgent("fastcontext");
		const settings = Settings.isolated({ extensions: [], "mcp.discoveryMode": false });

		const result = await runSubprocess({
			cwd: REPO_ROOT,
			agent,
			task: `Find the parseAgentFields function in the coding-agent package at ${REPO_ROOT}/packages/coding-agent. Return citations.`,
			assignment: "Find the parseAgentFields function.",
			index: 0,
			id: "fastcontext-codex-e2e",
			modelOverride: ["openai-codex/gpt-5.5"],
			settings,
			enableLsp: false,
			authStorage: auth,
			preloadedExtensionPaths: [],
		});

		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.output).toBeTruthy();

		const parsed = JSON.parse(result.output);
		expect(parsed).toHaveProperty("citations");
		expect(parsed).toHaveProperty("summary");
		expect(Array.isArray(parsed.citations)).toBe(true);
		expect(parsed.citations.length).toBeGreaterThan(0);

		const firstCitation = parsed.citations[0];
		expect(firstCitation).toHaveProperty("path");
		expect(firstCitation).toHaveProperty("reason");
	}, 120000);
});
