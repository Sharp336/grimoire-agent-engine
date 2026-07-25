import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";

const model =
	getBundledModel("cursor", "cursor-composer-2.5") ??
	buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor-agent",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});

describe("Cursor contract surfaces (advisor, cancellation, disposal)", () => {
	let tempDir: TempDir | undefined;
	let sessionManager: SessionManager | undefined;
	let authStorage: AuthStorage | undefined;
	let modelRegistry: ModelRegistry | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		if (session) {
			const s = session;
			session = undefined;
			await s.dispose().catch(() => {});
		}
		if (tempDir) {
			const t = tempDir;
			tempDir = undefined;
			await t.remove().catch(() => {});
		}
	});

	it("reads providers.cursor.useHttp1ForAgent per request for main and advisor turns", async () => {
		tempDir = await TempDir.create("advisor-cursor-contract-test-");
		sessionManager = SessionManager.inMemory();
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("cursor-agent", "test-key");
		modelRegistry = new ModelRegistry(authStorage);

		const isolatedSettings = Settings.isolated({
			"providers.cursor.useHttp1ForAgent": true,
		});
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
			capturedStreamOptions.push(opts as SimpleStreamOptions);
			throw new Error("capture-stop");
		};

		const settingsAwareStreamFn = createSettingsAwareStreamFn(isolatedSettings, captureStreamFn);

		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: settingsAwareStreamFn,
		});

		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: isolatedSettings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: settingsAwareStreamFn,
		});

		// No Agent-level snapshot: the setting is read per request by the
		// settings-aware stream wrapper.
		await mainAgent.prompt("main test").catch(() => {});
		expect(capturedStreamOptions.length).toBeGreaterThan(0);
		expect(capturedStreamOptions[0]?.cursorUseHttp1ForAgent).toBe(true);

		// Flipping the setting mid-session must take effect on the next turn.
		capturedStreamOptions.length = 0;
		isolatedSettings.override("providers.cursor.useHttp1ForAgent", false);
		await mainAgent.prompt("main test 2").catch(() => {});
		expect(capturedStreamOptions[0]?.cursorUseHttp1ForAgent).toBe(false);
		isolatedSettings.override("providers.cursor.useHttp1ForAgent", true);

		capturedStreamOptions.length = 0;

		// Enable advisor and verify advisor agent also receives setting
		const advisorModelSelector = getBundledModel("anthropic", "claude-sonnet-4-5")
			? "anthropic/claude-sonnet-4-5"
			: "cursor-agent/cursor-composer-2.5";
		session.settings.setModelRole("advisor", advisorModelSelector);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");

		await advisor.prompt("advisor test").catch(() => {});

		expect(capturedStreamOptions.length).toBeGreaterThan(0);
		expect(capturedStreamOptions[0]?.cursorUseHttp1ForAgent).toBe(true);
	});

	it("passes attempt AbortSignal to tool.execute from CursorExecHandlers", async () => {
		const abortController = new AbortController();
		let receivedSignal: AbortSignal | undefined;

		const mockTool: AgentTool = {
			name: "read",
			label: "read",
			description: "mock read tool",
			parameters: {} as never,
			execute: async (_callId, _params, signal) => {
				receivedSignal = signal;
				return { content: [{ type: "text", text: "read ok" }], details: {} };
			},
		};

		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["read", mockTool]]),
		});

		await handlers.read({ path: "test.txt", toolCallId: "call-1" } as never, abortController.signal);

		expect(receivedSignal).toBe(abortController.signal);
	});

	it("passes attempt AbortSignal to streaming shell tool execution in CursorExecHandlers", async () => {
		const abortController = new AbortController();
		let receivedSignal: AbortSignal | undefined;

		const mockShellTool: AgentTool = {
			name: "bash",
			label: "bash",
			description: "mock bash tool",
			parameters: {} as never,
			execute: async (_callId, _params, signal) => {
				receivedSignal = signal;
				return { content: [{ type: "text", text: "bash ok" }], details: {} };
			},
		};

		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["bash", mockShellTool]]),
		});

		await handlers.shellStream(
			{ command: "echo hello", toolCallId: "call-2" } as never,
			{ onStdout: () => {}, onStderr: () => {} },
			abortController.signal,
		);

		expect(receivedSignal).toBe(abortController.signal);
	});

	it("performs composite disposal and blocks new transport work in an isolated subprocess", async () => {
		const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-composite-disposal.ts")], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stderr.trim()).toBe("");
		const result = JSON.parse(stdout) as {
			ok: boolean;
			disposalBlocksNewWork: boolean;
			promiseIdentity: boolean;
			promisePendingBeforeRelease: boolean;
			promiseAwaitsTeardown: boolean;
			subsequentCallIdentity: boolean;
		};
		expect(result.ok).toBe(true);
		expect(result.disposalBlocksNewWork).toBe(true);
		expect(result.promiseIdentity).toBe(true);
		expect(result.promisePendingBeforeRelease).toBe(true);
		expect(result.promiseAwaitsTeardown).toBe(true);
		expect(result.subsequentCallIdentity).toBe(true);
	});
});
