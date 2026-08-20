/**
 * Tests that ExtensionToolWrapper reports the calling session's identity on
 * `tool_call`. Extensions need this to scope policy to the top-level agent
 * without also constraining the subagents it delegates to — blocking a tool
 * on an undifferentiated event blocks both.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("ExtensionToolWrapper tool_call session identity", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let observedPath: string;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-tool-call-identity-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-tool-call-identity-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
		observedPath = path.join(tempDir.path(), "observed.json");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	/**
	 * Loads an extension that appends each `tool_call` event's identity fields to
	 * a JSON-lines file, so the assertion reads what the wrapper actually emitted.
	 */
	const runnerRecordingIdentity = async (): Promise<ExtensionRunner> => {
		fs.writeFileSync(
			path.join(extensionsDir, "record-identity.ts"),
			`import * as fs from "node:fs";
			export default function (pi) {
				pi.on("tool_call", event => {
					fs.appendFileSync(
						${JSON.stringify(observedPath)},
						JSON.stringify({ agentKind: event.agentKind, taskDepth: event.taskDepth }) + "\\n",
					);
				});
			}`,
		);
		const discovered = fs
			.readdirSync(extensionsDir, { withFileTypes: true })
			.filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
			.map(entry => path.join(extensionsDir, entry.name))
			.sort();
		const result = await loadExtensions(discovered, tempDir.path());
		return new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);
	};

	const observed = (): Array<{ agentKind?: string; taskDepth?: number }> =>
		fs
			.readFileSync(observedPath, "utf8")
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line));

	const identityTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Test tool",
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	} as AgentTool;

	it("reports agentKind main and taskDepth 0 for a top-level call", async () => {
		const wrapped = new ExtensionToolWrapper(identityTool, await runnerRecordingIdentity());

		await wrapped.execute("call-main", {} as never, undefined, undefined, {
			agentKind: "main",
			taskDepth: 0,
		} as AgentToolContext);

		expect(observed()).toEqual([{ agentKind: "main", taskDepth: 0 }]);
	});

	it("reports agentKind sub and the child depth for a delegated call", async () => {
		const wrapped = new ExtensionToolWrapper(identityTool, await runnerRecordingIdentity());

		await wrapped.execute("call-sub", {} as never, undefined, undefined, {
			agentKind: "sub",
			taskDepth: 1,
		} as AgentToolContext);

		expect(observed()).toEqual([{ agentKind: "sub", taskDepth: 1 }]);
	});

	it("omits both fields when the host does not report them", async () => {
		const wrapped = new ExtensionToolWrapper(identityTool, await runnerRecordingIdentity());

		// A handler must be able to tell "top-level" from "not reported" so it can
		// fail open on hosts that predate these fields.
		await wrapped.execute("call-unknown", {} as never, undefined, undefined, {} as AgentToolContext);

		expect(observed()).toEqual([{}]);
	});
});
