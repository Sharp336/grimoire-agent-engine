import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PromptGateBlockedError } from "@oh-my-pi/pi-coding-agent/prompt-gate/runtime";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();

describe("AgentSession prompt gate", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let gateDirectory: string;
	let helperPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-agent-session-prompt-gate-");
		setAgentDir(path.join(tempDir.path(), "agent"));
		gateDirectory = path.join(getAgentDir(), "prompt-gates");
		await mkdir(gateDirectory, { recursive: true });
		helperPath = path.join(tempDir.path(), "blocking-gate");
		await writeFile(
			helperPath,
			`#!/usr/bin/env bun\nimport { createInterface } from "node:readline";\nconst lines = createInterface({ input: process.stdin, crlfDelay: Infinity });\nfor await (const line of lines) {\n  const input = JSON.parse(line);\n  process.stdout.write(JSON.stringify({ version: 1, event: "prompt-gate-v1", integration_id: input.integration_id, decision: "block", reason: "test blocked" }) + "\\n");\n  process.stdin.destroy();\n  break;\n}\n`,
		);
		await chmod(helperPath, 0o755);
		const digest = Bun.SHA256.hash(new Uint8Array(await Bun.file(helperPath).arrayBuffer()), "hex");
		await writeFile(
			path.join(gateDirectory, "test.json"),
			JSON.stringify({
				version: 1,
				event: "prompt-gate-v1",
				integration_id: "agent-session-test",
				command: [helperPath],
				command_sha256: digest,
				first_decision_timeout_ms: 1_000,
				on_error: "block",
			}),
		);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		setAgentDir(originalAgentDir);
		tempDir.removeSync();
	});

	it("blocks user prompts before provider dispatch but bypasses agent-attributed synthetic turns", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		let providerCalls = 0;
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (...args) => {
				providerCalls++;
				return mock.stream(...args);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await expect(session.prompt("must not reach provider")).rejects.toBeInstanceOf(PromptGateBlockedError);
		expect(providerCalls).toBe(0);
		await expect(session.steer("must not enter steer queue")).rejects.toBeInstanceOf(PromptGateBlockedError);
		await expect(session.followUp("must not enter follow-up queue")).rejects.toBeInstanceOf(PromptGateBlockedError);
		await session.prompt("internal continuation", { synthetic: true });
		expect(providerCalls).toBe(1);
	});
	it("cancels staged gate delivery when local preflight rejects the prompt", async () => {
		const cancellationRecord = path.join(tempDir.path(), "gate-cancelled");
		await writeFile(
			helperPath,
			`#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const cancellationRecord = process.argv.at(-1);
process.on("SIGTERM", () => {
  writeFileSync(cancellationRecord, "cancelled");
  process.exit(0);
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const input = JSON.parse(line);
  const frame = value => process.stdout.write(JSON.stringify({ version: 1, integration_id: input.integration_id, ...value }) + "\\n");
  if (input.text === "original") {
    frame({ event: "prompt-gate-v1", decision: "block", reason: "reviewing" });
    frame({ event: "stage_approved", text: "corrected", delivery_token: "delivery-1" });
  } else {
    frame({ event: "prompt-gate-v1", decision: "allow" });
    break;
  }
}
`,
		);
		await chmod(helperPath, 0o755);
		const digest = Bun.SHA256.hash(new Uint8Array(await Bun.file(helperPath).arrayBuffer()), "hex");
		await writeFile(
			path.join(gateDirectory, "test.json"),
			JSON.stringify({
				version: 1,
				event: "prompt-gate-v1",
				integration_id: "agent-session-test",
				command: [helperPath, cancellationRecord],
				command_sha256: digest,
				first_decision_timeout_ms: 1_000,
				on_error: "block",
			}),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["unreachable"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await expect(session.prompt("original")).rejects.toThrow("No API key found");
		await expect(Bun.file(cancellationRecord).exists()).resolves.toBe(true);
	});
});
