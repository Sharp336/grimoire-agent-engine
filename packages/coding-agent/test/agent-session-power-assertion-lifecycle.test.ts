import { expect, it } from "bun:test";

it("keeps sleep prevention aligned with session-owned activity", async () => {
	const script = String.raw`
		import assert from "node:assert/strict";
		import * as fs from "node:fs";
		import * as os from "node:os";
		import * as path from "node:path";
		import { mock } from "bun:test";

		// Dynamic imports are deliberate: install the native mock before AgentSession loads it.
		const native = await import("@oh-my-pi/pi-natives");
		let acquired = 0;
		let released = 0;
		class MockPowerAssertion {
			static start() {
				acquired++;
				return new MockPowerAssertion();
			}
			stop() {
				released++;
			}
		}
		mock.module("@oh-my-pi/pi-natives", () => ({ ...native, PowerAssertion: MockPowerAssertion }));

		const { Agent } = await import("@oh-my-pi/pi-agent-core");
		const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
		const { getBundledModel } = await import("@oh-my-pi/pi-catalog/models");
		const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async");
		const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
		const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
		const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
		const { AgentSession } = await import("@oh-my-pi/pi-coding-agent/session/agent-session");
		const { AuthStorage } = await import("@oh-my-pi/pi-coding-agent/session/auth-storage");
		const { convertToLlm } = await import("@oh-my-pi/pi-coding-agent/session/messages");
		const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-power-assertion-"));
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		assert.ok(model);

		function createAssistantMessage(text) {
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		}

		const streamStarts = [];
		function nextStreamStart() {
			const start = Promise.withResolvers();
			streamStarts.push(start.resolve);
			return start.promise;
		}

		function createAgent() {
			return new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: (_model, _context, options) => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						streamStarts.shift()?.();
						options?.signal?.addEventListener(
							"abort",
							() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
							{ once: true },
						);
					});
					return stream;
				},
			});
		}

		try {
			const ownerlessJobs = new AsyncJobManager({});
			const ownerless = new AgentSession({
				agent: createAgent(),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage),
				asyncJobManager: ownerlessJobs,
				agentRegistry: new AgentRegistry(),
			});
			const foreignGate = Promise.withResolvers();
			const foreignJob = ownerlessJobs.register("task", "foreign", () => foreignGate.promise, { ownerId: "other" });
			assert.equal(acquired, 0, "an ownerless session must ignore other sessions' jobs");
			ownerlessJobs.cancel(foreignJob, { ownerId: "other" });
			foreignGate.resolve("cancelled");
			await ownerless.dispose();

			const jobs = new AsyncJobManager({});
			const registry = new AgentRegistry();
			const session = new AgentSession({
				agent: createAgent(),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage),
				agentId: "Main",
				asyncJobManager: jobs,
				agentRegistry: registry,
			});

			const promptStarted = nextStreamStart();
			const prompt = session.prompt("hold while prompting");
			await promptStarted;
			assert.equal(acquired, 1, "a foreground prompt acquires the assertion");
			await session.abort();
			await prompt.catch(() => {});
			assert.equal(released, 1, "aborting the only activity releases the assertion");

			const jobGate = Promise.withResolvers();
			const job = jobs.register("task", "owned", () => jobGate.promise, { ownerId: "Main" });
			assert.equal(acquired, 2, "an owned running job acquires the assertion");
			jobs.cancel(job, { ownerId: "Main" });
			assert.equal(released, 2, "ending an owned job releases the assertion");
			jobGate.resolve("cancelled");

			registry.register({ id: "child", displayName: "child", kind: "sub", parentId: "Main", session: null });
			assert.equal(acquired, 3, "a running child subagent acquires the assertion");
			registry.setStatus("child", "idle");
			assert.equal(released, 3, "an idle child subagent releases the assertion");

			const backgroundGate = Promise.withResolvers();
			const backgroundJob = jobs.register("task", "still running", () => backgroundGate.promise, { ownerId: "Main" });
			assert.equal(acquired, 4, "background work acquires the assertion");
			const abortingPromptStarted = nextStreamStart();
			const abortingPrompt = session.prompt("abort while background work continues");
			await abortingPromptStarted;
			await session.abort();
			await abortingPrompt.catch(() => {});
			assert.equal(released, 3, "abort retains the assertion while owned work remains active");
			jobs.cancel(backgroundJob, { ownerId: "Main" });
			assert.equal(released, 4, "the assertion releases when the final owned activity ends");
			backgroundGate.resolve("cancelled");
			await session.dispose();
		} finally {
			authStorage.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	`;

	const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
		cwd: process.cwd(),
		env: { ...process.env, BUN_ENV: "", NODE_ENV: "" },
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stderr = await new Response(proc.stderr).text();
	expect(exitCode, stderr).toBe(0);
});
