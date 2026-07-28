import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type {
	AgentDefinition,
	ExecutorOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	IrcMessage,
	IrcPeerTransport,
	SubagentExecutor,
} from "@oh-my-pi/pi-coding-agent";
import { AnimaExecutorController } from "../src/executor";
import animaExtension, { handleAnimaCommand, registerAnimaExtension } from "../src/extension";
import {
	type AnimaControl,
	type ControlEvent,
	ControlProtocolError,
	type ControlRequestOptions,
	type ProtocolHello,
} from "../src/protocol";

const HELLO: ProtocolHello = {
	protocol: "anima-control",
	version: 1,
	anima_version: "test",
	owner: "external:omp:test-sidecar",
	mailbox: "omp-test-sidecar-Main",
	methods: [
		"invoke.start",
		"invoke.observe",
		"invoke.wait_turn",
		"invoke.cancel",
		"invoke.message",
		"invoke.release",
		"mail.receive",
		"mail.ack",
	],
	capabilities: { turn_authority: true, threaded_mail: true, external_mailbox: true },
	limits: { max_line_bytes: 1_048_576, max_in_flight: 128 },
};

class FakeControl implements AnimaControl {
	readonly calls: Array<{ method: string; params: unknown; options?: ControlRequestOptions }> = [];
	readonly #listeners = new Set<(event: ControlEvent) => void>();
	helloResult: ProtocolHello | Promise<ProtocolHello> = HELLO;
	cancelResult: unknown | Promise<unknown> = { invocation_id: "in-1", disposition: "cancelled_running" };
	readonly releaseResults: Array<unknown | Promise<unknown>> = [];
	closeCalls = 0;
	closeCallIndex = -1;
	#mailReceive?: ReturnType<typeof Promise.withResolvers<never>>;
	readonly startResults: Array<unknown | Promise<unknown>> = [];
	readonly waitResults: Array<unknown | Promise<unknown>> = [];
	startResult: unknown | Promise<unknown> = {
		invocation_id: "in-1",
		agent_id: "agent-1",
		session_name: "omp-agent-1",
		state: "starting",
	};
	waitResult: unknown = {
		invocation_id: "in-1",
		session_name: "omp-agent-1",
		authority: { epoch: "epoch-1" },
		turn_id: "turn-1",
		text: "exact final text",
		stop_reason: "end_turn",
		transcript_ref: "history://session-1",
		attach_ref: "an attach omp-agent-1",
		completed_at: "2026-07-28T00:00:00Z",
	};

	async hello(): Promise<ProtocolHello> {
		return await this.helloResult;
	}

	async request<T>(method: string, params: unknown, options?: ControlRequestOptions): Promise<T> {
		this.calls.push({ method, params, options });
		switch (method) {
			case "invoke.start": {
				const result = this.startResults.length > 0 ? this.startResults.shift() : this.startResult;
				return (await result) as T;
			}
			case "invoke.wait_turn": {
				const result = this.waitResults.length > 0 ? this.waitResults.shift() : this.waitResult;
				return (await result) as T;
			}
			case "invoke.observe": {
				const observeParams = params as { invocation_id: string };
				const invocationId = observeParams.invocation_id;
				return {
					invocation_id: invocationId,
					agent_id: "agent-1",
					session_name: "omp-agent-1",
					state: "generating",
				} as T;
			}
			case "invoke.message":
				return {
					invocation_id: "in-1",
					session_name: "omp-agent-1",
					message_id: "message-1",
					thread_id: (params as { thread_id?: string }).thread_id,
					priority: 0,
					disposition: "delivered",
				} as T;
			case "invoke.cancel":
				return (await this.cancelResult) as T;
			case "invoke.release": {
				const releaseParams = params as { invocation_id: string; policy?: string };
				const policy = releaseParams.policy ?? "park";
				if (this.releaseResults.length > 0) return (await this.releaseResults.shift()) as T;
				return {
					invocation_id: releaseParams.invocation_id,
					session_name: "omp-agent-1",
					policy,
					disposition: policy === "keep" ? "kept" : "parked",
				} as T;
			}
			case "mail.receive":
				this.#mailReceive ??= Promise.withResolvers<never>();
				return this.#mailReceive.promise;
			default:
				return {} as T;
		}
	}

	onEvent(listener: (event: ControlEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): Promise<void> {
		this.closeCalls += 1;
		this.closeCallIndex = this.calls.length;
		this.#mailReceive?.reject(new ControlProtocolError("transport_closed", "closed", true));
		this.#mailReceive = undefined;
		return Promise.resolve();
	}
}

class RetryOnceControl extends FakeControl {
	waitFailures = 0;
	waitError = new ControlProtocolError("transport_exited", "sidecar exited", true);

	override async request<T>(method: string, params: unknown, options?: ControlRequestOptions): Promise<T> {
		if (method === "invoke.wait_turn" && this.waitFailures > 0) {
			this.waitFailures -= 1;
			this.calls.push({ method, params, options });
			throw this.waitError;
		}
		return super.request<T>(method, params, options);
	}
}

function packagedAgent(): AgentDefinition {
	return {
		name: "claude-reviewer",
		description: "Reviewer",
		systemPrompt: "Review exactly once.",
		tools: ["read"],
		source: "user",
		filePath: path.resolve(import.meta.dir, "../agents/claude-reviewer.md"),
	};
}

function executorOptions(agent = packagedAgent()): ExecutorOptions {
	return {
		cwd: "/tmp",
		agent,
		task: "Shared context\n\nInspect the target exactly once.",
		assignment: "Inspect the target exactly once.",
		index: 2,
		id: "task-2",
		effort: "hi",
	};
}

function extensionHarness(): {
	pi: ExtensionAPI;
	executor?: SubagentExecutor;
	shutdown?: () => Promise<void>;
} {
	const harness: {
		pi: ExtensionAPI;
		executor?: SubagentExecutor;
		shutdown?: () => Promise<void>;
	} = {
		pi: undefined as unknown as ExtensionAPI,
	};
	harness.pi = {
		setLabel: () => undefined,
		registerSubagentExecutor: (executor: SubagentExecutor) => {
			harness.executor = executor;
		},
		registerCommand: () => undefined,
		on: (event: string, handler: () => Promise<void>) => {
			if (event === "session_shutdown") harness.shutdown = handler;
		},
	} as unknown as ExtensionAPI;
	return harness;
}

class FakePeerBus {
	transport?: IrcPeerTransport;
	registerCalls = 0;

	registerPeerTransport(transport: IrcPeerTransport): () => void {
		this.transport = transport;
		this.registerCalls += 1;
		return () => {
			if (this.transport === transport) this.transport = undefined;
		};
	}

	deliverInbound(): Promise<{ outcome: string }> {
		return Promise.resolve({ outcome: "injected" });
	}
}

describe("AnimaExecutorController", () => {
	it("claims only packaged or explicitly configured agents", () => {
		const controller = new AnimaExecutorController({
			client: new FakeControl(),
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			allowAgentNames: ["project-claude"],
		});
		expect(controller.executor.claim(packagedAgent())).toBe(true);
		expect(
			controller.executor.claim({ ...packagedAgent(), filePath: "/tmp/project/agents/claude-reviewer.md" }),
		).toBe(false);
		expect(
			controller.executor.claim({
				...packagedAgent(),
				filePath: path.resolve(import.meta.dir, "../agents/claude-reviewer-copy.md"),
			}),
		).toBe(false);
		expect(
			controller.executor.claim({
				...packagedAgent(),
				filePath: path.resolve(import.meta.dir, "../agents/claude-implementer.md"),
			}),
		).toBe(false);
		expect(
			controller.executor.claim({ ...packagedAgent(), name: "project-claude", filePath: "/tmp/project.md" }),
		).toBe(true);
		expect(controller.executor.claim({ ...packagedAgent(), name: "native", filePath: "/tmp/native.md" })).toBe(false);
	});

	it("maps one normalized OMP request to start, authority wait, and release", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const progress: string[] = [];
		const result = await controller.executor.execute({
			...executorOptions(),
			worktree: "/tmp/caller-worktree",
			context: "Shared background from the parent task.",
			planReference: { path: "local://approved-plan.md", content: "1. Preserve the protocol boundary." },
			modelOverride: "anthropic/claude-opus-4-6:high",
			outputSchema: { result: "string" },
			outputSchemaOverridesAgent: true,
			onProgress: event => progress.push(event.lastIntent ?? ""),
		});

		expect(result).toMatchObject({
			exitCode: 0,
			output: "exact final text",
			tokens: 0,
			requests: 0,
			external: {
				executor: "anima",
				invocationId: "in-1",
				agentId: "agent-1",
				usageAvailable: false,
			},
		});
		expect(client.calls.map(call => call.method)).toEqual(["invoke.start", "invoke.wait_turn", "invoke.release"]);
		const start = client.calls[0]?.params as Record<string, unknown>;
		expect(start.assignment).toBe("Shared context\n\nInspect the target exactly once.");
		expect(start.owner).toBe("external:omp:test-sidecar");
		expect(start.mailbox).toBe("omp-test-sidecar-Main");
		expect(start.context).toBe("Shared background from the parent task.");
		expect(start.workdir).toBe("/tmp/caller-worktree");
		expect(start.worktree).toBe(false);
		expect(start.route).toMatchObject({
			harness: "claude",
			provider: "anthropic",
			model: "claude-opus-4-6",
			effort: "high",
		});
		const corePrompt = start.core_prompt as { body: string; sha256: string };
		expect(corePrompt.body).toContain("Review exactly once.");
		expect(corePrompt.body).toContain("Shared background from the parent task.");
		expect(corePrompt.body).toContain("local://approved-plan.md");
		expect(corePrompt.body).toContain("1. Preserve the protocol boundary.");
		expect(corePrompt.body).toContain("caller-owned working tree at `/tmp/caller-worktree`");
		expect(corePrompt.body).toContain("OMP role grants only these tool capabilities: read");
		expect(corePrompt.body).toContain('"result": "string"');
		expect(corePrompt.body).toContain("anima-omp-reply");
		expect(corePrompt.body).toContain('--body "..."');
		expect(corePrompt.body).toContain("--thread-id THREAD_ID");
		expect(corePrompt.body).toContain("--reply-to MESSAGE_ID");
		expect(corePrompt.body).not.toContain("an mail send");
		expect(corePrompt.body).not.toContain(HELLO.mailbox);
		expect(corePrompt.body).toContain("final assistant response");
		expect(corePrompt.body).not.toContain("Shared context\n\nInspect the target exactly once.");
		expect(corePrompt.body.toLowerCase()).not.toContain("yield");
		expect(corePrompt.sha256).toBe(new Bun.CryptoHasher("sha256").update(corePrompt.body).digest("hex"));
		const durableKey = client.calls[0]?.options?.id;
		if (!durableKey) throw new Error("missing durable invocation key");
		expect(durableKey).toMatch(/^start:external:omp:test-sidecar:task-2:[0-9a-f-]{36}$/);
		expect(controller.list()[0]?.durableKey).toBe(durableKey);
		expect(client.calls[2]?.options?.timeoutMs).toBe(60_000);
		expect(progress.some(line => line.includes("creating durable invocation"))).toBe(true);
	});

	it("preserves unrestricted native tool semantics when tools are omitted or empty", async () => {
		const omittedToolsAgent = { ...packagedAgent() };
		delete omittedToolsAgent.tools;
		for (const agent of [omittedToolsAgent, { ...omittedToolsAgent, tools: [] }]) {
			const client = new FakeControl();
			const controller = new AnimaExecutorController({
				client,
				agentRoot: path.resolve(import.meta.dir, "../agents"),
				allowAgentNames: [agent.name],
			});

			expect((await controller.executor.execute(executorOptions(agent))).exitCode).toBe(0);
			const startParams = client.calls[0]?.params as { core_prompt: { body: string } };
			expect(startParams.core_prompt.body).toContain("OMP role does not restrict tool capabilities");
			expect(startParams.core_prompt.body).not.toContain("grants no tool capabilities");
		}
	});

	it("uses execution-unique durable keys and retains repeated task IDs as distinct invocations", async () => {
		const client = new FakeControl();
		client.startResults.push(
			{ invocation_id: "in-1", agent_id: "agent-1", session_name: "omp-agent-1", state: "starting" },
			{ invocation_id: "in-2", agent_id: "agent-2", session_name: "omp-agent-2", state: "starting" },
		);
		client.waitResults.push(client.waitResult, {
			invocation_id: "in-2",
			session_name: "omp-agent-2",
			authority: { epoch: "epoch-2" },
			turn_id: "turn-2",
			text: "second final text",
			stop_reason: "end_turn",
			transcript_ref: "history://session-2",
			attach_ref: "an attach omp-agent-2",
			completed_at: "2026-07-28T00:01:00Z",
		});
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});

		expect((await controller.executor.execute(executorOptions())).exitCode).toBe(0);
		expect((await controller.executor.execute(executorOptions())).exitCode).toBe(0);

		const durableKeys = client.calls
			.filter(call => call.method === "invoke.start")
			.map(call => call.options?.id)
			.filter((key): key is string => key !== undefined);
		expect(durableKeys).toHaveLength(2);
		expect(new Set(durableKeys).size).toBe(2);
		expect(durableKeys.every(key => key.startsWith("start:external:omp:test-sidecar:task-2:"))).toBe(true);
		const [firstDurableKey, secondDurableKey] = durableKeys;
		if (!firstDurableKey || !secondDurableKey) throw new Error("executor did not emit two durable start keys");
		expect(controller.list()).toEqual([
			expect.objectContaining({ requestId: "task-2", durableKey: firstDurableKey, invocationId: "in-1" }),
			expect.objectContaining({ requestId: "task-2", durableKey: secondDurableKey, invocationId: "in-2" }),
		]);

		await controller.observe("task-2");
		expect(client.calls.at(-1)?.params).toEqual({ invocation_id: "in-2" });
		await controller.observe(firstDurableKey);
		expect(client.calls.at(-1)?.params).toEqual({ invocation_id: "in-1" });
	});

	it("re-observes and waits for the same invocation after a retryable transport exit", async () => {
		const client = new RetryOnceControl();
		client.waitFailures = 1;
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});

		expect(await controller.executor.execute(executorOptions())).toMatchObject({
			exitCode: 0,
			output: "exact final text",
		});
		expect(client.calls.map(call => call.method)).toEqual([
			"invoke.start",
			"invoke.wait_turn",
			"invoke.observe",
			"invoke.wait_turn",
			"invoke.release",
		]);
		expect(client.calls.filter(call => call.method === "invoke.start")).toHaveLength(1);
		expect(client.calls.filter(call => call.method === "invoke.observe")[0]?.params).toEqual({
			invocation_id: "in-1",
		});
		expect(controller.list()[0]).toMatchObject({ invocationId: "in-1", state: "released" });
	});

	it("ignores OMP's parent-model fallback when the agent configures Claude", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const result = await controller.executor.execute({
			...executorOptions({ ...packagedAgent(), model: ["anthropic/claude-sonnet-4-6"] }),
			modelOverride: "openai-codex/gpt-5.4",
			parentActiveModelPattern: "openai-codex/gpt-5.4",
		});

		expect(result.exitCode).toBe(0);
		const start = client.calls[0]?.params as { route: { model: string } };
		expect(start.route.model).toBe("claude-sonnet-4-6");
	});

	it("rejects an explicit non-Claude model override", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const result = await controller.executor.execute({
			...executorOptions({ ...packagedAgent(), model: ["anthropic/claude-sonnet-4-6"] }),
			modelOverride: "openai-codex/gpt-5.4",
			parentActiveModelPattern: "openai-codex/gpt-5.3",
		});

		expect(result).toMatchObject({
			exitCode: 1,
			error: "unsupported_model_selector",
			stderr: 'Anima Claude executor requires an explicit Anthropic model selector; received "openai-codex/gpt-5.4"',
		});
		expect(client.calls).toEqual([]);
	});

	it("fails preflight when an agent configures a non-Anthropic model", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const result = await controller.executor.execute(
			executorOptions({ ...packagedAgent(), model: ["openai/gpt-5.4"] }),
		);

		expect(result).toMatchObject({
			exitCode: 1,
			error: "unsupported_model_selector",
			stderr: 'Anima Claude executor requires an explicit Anthropic model selector; received "openai/gpt-5.4"',
		});
		expect(client.calls).toEqual([]);
	});

	it("keeps the released worker addressable and delivers follow-up to its original invocation", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			retention: "keep",
		});

		expect((await controller.executor.execute(executorOptions())).exitCode).toBe(0);
		const messageId = await controller.message("task-2", "Check the remaining edge case.");
		while (controller.list()[0]?.state !== "released") await Bun.sleep(0);

		expect(messageId).toBe("message-1");
		expect(client.calls.map(call => call.method)).toEqual([
			"invoke.start",
			"invoke.wait_turn",
			"invoke.release",
			"invoke.message",
			"invoke.wait_turn",
			"invoke.release",
		]);
		expect(client.calls[2]?.params).toEqual({ invocation_id: "in-1", policy: "keep" });
		expect(client.calls[3]?.params).toEqual({
			invocation_id: "in-1",
			body: "Check the remaining edge case.",
			priority: 0,
			timeout_ms: 60_000,
		});
		expect(controller.list()).toEqual([
			expect.objectContaining({
				requestId: "task-2",
				invocationId: "in-1",
				state: "released",
				lastMessageId: "message-1",
				detail: "follow-up turn turn-1 completed",
			}),
		]);
	});

	it("re-observes a retained follow-up after transport loss and still releases it", async () => {
		const client = new RetryOnceControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			retention: "keep",
		});
		expect((await controller.executor.execute(executorOptions())).exitCode).toBe(0);
		client.calls.length = 0;
		client.waitFailures = 1;

		expect(await controller.message("task-2", "Check again after reconnect.")).toBe("message-1");
		while (controller.list()[0]?.state !== "released") await Promise.resolve();

		expect(client.calls.map(call => call.method)).toEqual([
			"invoke.message",
			"invoke.wait_turn",
			"invoke.observe",
			"invoke.wait_turn",
			"invoke.release",
		]);
		expect(client.calls.filter(call => call.method === "invoke.start")).toHaveLength(0);
		expect(controller.list()[0]).toMatchObject({
			invocationId: "in-1",
			state: "released",
			detail: "follow-up turn turn-1 completed",
		});
	});

	it("cancels and releases a follow-up when turn recovery cannot continue", async () => {
		const client = new RetryOnceControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			retention: "keep",
		});
		expect((await controller.executor.execute(executorOptions())).exitCode).toBe(0);
		client.calls.length = 0;
		client.waitFailures = 1;
		client.waitError = new ControlProtocolError("invalid_response", "turn authority missing");

		expect(await controller.message("task-2", "Check the terminal cleanup path.")).toBe("message-1");
		while (controller.list()[0]?.state !== "failed") await Promise.resolve();

		expect(client.calls.map(call => call.method)).toEqual([
			"invoke.message",
			"invoke.wait_turn",
			"invoke.cancel",
			"invoke.release",
		]);
		expect(client.calls.filter(call => call.method === "invoke.start")).toHaveLength(0);
		expect(controller.list()[0]).toMatchObject({
			invocationId: "in-1",
			state: "failed",
			detail: "follow-up failed: turn authority missing",
		});
	});

	it("routes a threaded IRC reply to the originating local peer", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			retention: "keep",
		});
		expect((await controller.executor.execute(executorOptions())).exitCode).toBe(0);
		client.calls.length = 0;
		const message: IrcMessage = {
			id: "irc-1",
			from: "requester-1",
			to: "omp-agent-1",
			body: "Report the blocker.",
			ts: Date.now(),
			threadId: "thread-1",
			replyTo: "mail-parent",
		};

		expect(await controller.sendPeer(message)).toBe("message-1");
		while (controller.list()[0]?.state !== "released") await Bun.sleep(0);
		expect(client.calls[0]).toEqual({
			method: "invoke.message",
			params: {
				invocation_id: "in-1",
				subject: "OMP IRC from requester-1",
				body: "Report the blocker.",
				priority: 0,
				thread_id: "thread-1",
				reply_to: "mail-parent",
				timeout_ms: 60_000,
			},
			options: { id: "irc:irc-1", timeoutMs: 90_000 },
		});
		expect(controller.resolvePeerMessage("omp-agent-1", { threadId: "thread-1" })).toEqual({
			recipient: "requester-1",
		});
		expect(controller.resolvePeerMessage("omp-agent-1", { replyTo: "message-1" })).toEqual({
			recipient: "requester-1",
		});
		expect(controller.resolvePeerMessage("forged-peer", { threadId: "thread-1" })).toBeUndefined();
		expect(client.calls.map(call => call.method)).toEqual(["invoke.message", "invoke.wait_turn", "invoke.release"]);
	});

	it("rejects follow-up for an unknown task without contacting Anima", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});

		expect(controller.message("missing-task", "Continue.")).rejects.toThrow(
			'Unknown Anima invocation "missing-task"',
		);
		expect(client.calls).toEqual([]);
	});

	it("cancels the durable invocation before returning an aborted result", async () => {
		const client = new FakeControl();
		const wait = Promise.withResolvers<unknown>();
		client.waitResult = wait.promise;
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const abort = new AbortController();
		const pending = controller.executor.execute({ ...executorOptions(), signal: abort.signal });
		while (client.calls.length < 2) await Bun.sleep(0);
		abort.abort("operator");
		const commandCancellation = controller.cancel("task-2");
		const [result] = await Promise.all([pending, commandCancellation]);
		wait.resolve({});

		expect(result).toMatchObject({ exitCode: 1, aborted: true, abortReason: "operator" });
		expect(client.calls.map(call => call.method)).toEqual([
			"invoke.start",
			"invoke.wait_turn",
			"invoke.cancel",
			"invoke.release",
		]);
		expect(client.calls.filter(call => call.method === "invoke.cancel")).toHaveLength(1);
		expect(client.calls.filter(call => call.method === "invoke.release")).toHaveLength(1);
	});

	it("returns a completed turn when cancellation loses to terminal commit", async () => {
		const client = new FakeControl();
		const completed = client.waitResult;
		const wait = Promise.withResolvers<unknown>();
		client.waitResult = wait.promise;
		client.cancelResult = { invocation_id: "in-1", disposition: "already_completed" };
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const abort = new AbortController();
		const pending = controller.executor.execute({ ...executorOptions(), signal: abort.signal });
		while (client.calls.length < 2) await Promise.resolve();
		abort.abort("operator");
		wait.resolve(completed);

		expect(await pending).toMatchObject({ exitCode: 0, output: "exact final text" });
		expect(client.calls.filter(call => call.method === "invoke.cancel")).toHaveLength(1);
		expect(client.calls.filter(call => call.method === "invoke.release")).toHaveLength(1);
	});

	it("fails truthfully when cancellation and release both report stale authority", async () => {
		const client = new FakeControl();
		client.cancelResult = { invocation_id: "in-1", disposition: "stale_authority" };
		client.releaseResults.push({
			invocation_id: "in-1",
			session_name: "omp-agent-1",
			policy: "park",
			disposition: "stale_authority",
		});
		const wait = Promise.withResolvers<unknown>();
		client.waitResult = wait.promise;
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const abort = new AbortController();
		const pending = controller.executor.execute({ ...executorOptions(), signal: abort.signal });
		while (client.calls.length < 2) await Promise.resolve();
		abort.abort("operator");

		expect(await pending).toMatchObject({
			exitCode: 1,
			aborted: true,
			error: "Anima invocation in-1 was not cancelled: stale_authority",
		});
		expect(client.calls.filter(call => call.method === "invoke.cancel")).toHaveLength(1);
		expect(client.calls.filter(call => call.method === "invoke.release")).toHaveLength(1);
		expect(controller.list()[0]).toMatchObject({ state: "failed" });
		wait.reject(new Error("cancelled"));
	});

	it("rejects an unsuccessful release disposition without reporting task success", async () => {
		const client = new FakeControl();
		client.releaseResults.push({
			invocation_id: "in-1",
			session_name: "omp-agent-1",
			policy: "park",
			disposition: "stale_authority",
		});
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});

		expect(await controller.executor.execute(executorOptions())).toMatchObject({
			exitCode: 1,
			error: "Anima invocation in-1 was not parked: stale_authority",
		});
		expect(client.calls.filter(call => call.method === "invoke.release")).toHaveLength(1);
		expect(controller.list()[0]).toMatchObject({ state: "failed" });
	});

	it("serializes release and revival and reapplies retention to the new turn revision", async () => {
		const client = new FakeControl();
		const firstRelease = Promise.withResolvers<unknown>();
		client.releaseResults.push(firstRelease.promise);
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const execution = controller.executor.execute(executorOptions());
		while (client.calls.filter(call => call.method === "invoke.release").length < 1) await Promise.resolve();
		const message = controller.message("task-2", "Re-check after release.");
		firstRelease.resolve({
			invocation_id: "in-1",
			session_name: "omp-agent-1",
			policy: "park",
			disposition: "parked",
		});

		expect((await execution).exitCode).toBe(0);
		expect(await message).toBe("message-1");
		while (controller.list()[0]?.state !== "released") await Promise.resolve();
		const releases = client.calls.filter(call => call.method === "invoke.release");
		expect(releases).toHaveLength(2);
		expect(releases.map(call => call.options?.id)).toEqual(["release:in-1:0", "release:in-1:1"]);
	});

	it("settles promptly when aborted while protocol hello is pending", async () => {
		const client = new FakeControl();
		const hello = Promise.withResolvers<ProtocolHello>();
		client.helloResult = hello.promise;
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const abort = new AbortController();
		const pending = controller.executor.execute({ ...executorOptions(), signal: abort.signal });
		await Promise.resolve();
		abort.abort("operator");

		expect(await pending).toMatchObject({
			exitCode: 1,
			aborted: true,
			abortReason: "operator",
		});
		expect(client.calls).toEqual([]);
		hello.resolve(HELLO);
	});

	it("settles on abort while invoke.start is pending and cleans a late commit", async () => {
		const client = new FakeControl();
		const start = Promise.withResolvers<unknown>();
		client.startResult = start.promise;
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const abort = new AbortController();
		const pending = controller.executor.execute({ ...executorOptions(), signal: abort.signal });
		while (client.calls.filter(call => call.method === "invoke.start").length < 1) await Promise.resolve();
		abort.abort("operator");

		expect(await pending).toMatchObject({ exitCode: 1, aborted: true, abortReason: "operator" });
		start.resolve({
			invocation_id: "in-late",
			agent_id: "agent-late",
			session_name: "omp-agent-late",
			state: "starting",
		});
		while (client.calls.filter(call => call.method === "invoke.release").length < 1) await Promise.resolve();
		expect(client.calls.filter(call => call.method === "invoke.cancel")).toHaveLength(1);
		expect(client.calls.filter(call => call.method === "invoke.release")).toHaveLength(1);
	});

	it("times out during invoke.start and cleans a late committed invocation exactly once", async () => {
		const client = new FakeControl();
		const start = Promise.withResolvers<unknown>();
		client.startResult = start.promise;
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const result = await controller.executor.execute({ ...executorOptions(), maxRuntimeMs: 10 });

		expect(result).toMatchObject({
			exitCode: 1,
			error: "runtime_timeout",
			aborted: true,
			abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=10)",
		});
		expect(client.calls.map(call => call.method)).toEqual(["invoke.start"]);

		start.resolve({
			invocation_id: "in-late",
			agent_id: "agent-late",
			session_name: "omp-agent-late",
			state: "starting",
		});
		await Bun.sleep(0);
		expect(client.calls.map(call => call.method)).toEqual(["invoke.start", "invoke.cancel", "invoke.release"]);
		expect(client.calls.filter(call => call.method === "invoke.cancel")).toHaveLength(1);
		expect(client.calls.filter(call => call.method === "invoke.release")).toHaveLength(1);
	});

	it("fails unsupported additional roots before contacting Anima", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const result = await controller.executor.execute({
			...executorOptions(),
			additionalDirectories: ["/tmp/second-root"],
		});
		expect(result).toMatchObject({ exitCode: 1, error: "unsupported_additional_directories" });
		expect(client.calls).toEqual([]);
	});
});

describe("Anima extension commands", () => {
	it("rejects invalid retention during extension registration", async () => {
		const previous = process.env.ANIMA_OMP_RETENTION;
		process.env.ANIMA_OMP_RETENTION = "destroy";
		try {
			await expect(animaExtension({} as ExtensionAPI)).rejects.toThrow(
				'Invalid ANIMA_OMP_RETENTION "destroy"; expected "park" or "keep"',
			);
		} finally {
			if (previous === undefined) delete process.env.ANIMA_OMP_RETENTION;
			else process.env.ANIMA_OMP_RETENTION = previous;
		}
	});

	it("fails preflight before sidecar startup when the executor host API is absent", async () => {
		const bus = new FakePeerBus();
		let creates = 0;
		const pi = {
			pi: { IrcBus: { global: () => bus } },
			setLabel: () => undefined,
			registerCommand: () => undefined,
			on: () => undefined,
		} as unknown as ExtensionAPI;

		await expect(
			registerAnimaExtension(pi, {
				createClient: () => {
					creates += 1;
					return new FakeControl();
				},
			}),
		).rejects.toThrow(
			"@anima/omp requires @oh-my-pi/pi-coding-agent >=17.2.0 <18; this host does not expose ExtensionAPI.registerSubagentExecutor",
		);
		expect(creates).toBe(0);
		expect(bus.registerCalls).toBe(0);
	});

	it("registers the peer bridge on the production host IRC bus when no override is supplied", async () => {
		const client = new FakeControl();
		const bus = new FakePeerBus();
		const harness = extensionHarness();
		let globalCalls = 0;
		Object.assign(harness.pi, {
			pi: {
				IrcBus: {
					global: () => {
						globalCalls += 1;
						return bus;
					},
				},
			},
		});

		await registerAnimaExtension(harness.pi, { createClient: () => client });
		while (bus.registerCalls === 0) await Promise.resolve();

		expect(globalCalls).toBe(1);
		expect(bus.transport).toBeDefined();
		if (!harness.shutdown) throw new Error("extension did not register its shutdown hook");
		await harness.shutdown();
		expect(bus.transport).toBeUndefined();
	});

	it("registers a fail-closed claimant when sidecar startup fails", async () => {
		const client = new FakeControl();
		const hello = Promise.withResolvers<ProtocolHello>();
		client.helloResult = hello.promise;
		const bus = new FakePeerBus();
		const harness = extensionHarness();
		await registerAnimaExtension(harness.pi, { createClient: () => client, bus });
		const executor = harness.executor;
		if (!executor || !harness.shutdown) throw new Error("extension did not register its executor and shutdown hook");
		expect(executor.claim(packagedAgent())).toBe(true);
		hello.reject(new ControlProtocolError("transport_start_failed", "sidecar unavailable", true));

		expect(await executor.execute(executorOptions())).toMatchObject({
			exitCode: 1,
			stderr: "sidecar unavailable",
			error: "sidecar unavailable",
		});
		expect(client.calls.some(call => call.method === "invoke.start")).toBe(false);
		await harness.shutdown();
		expect(client.closeCalls).toBe(1);
	});

	it("shares one bridge, drains active invocations before final close, and permits a fresh runtime", async () => {
		const client = new FakeControl();
		const bus = new FakePeerBus();
		let creates = 0;
		const dependencies = {
			createClient: () => {
				creates += 1;
				return client;
			},
			bus,
		};
		const first = extensionHarness();
		const second = extensionHarness();
		await registerAnimaExtension(first.pi, dependencies);
		await registerAnimaExtension(second.pi, dependencies);
		if (!first.executor || !first.shutdown || !second.executor || !second.shutdown) {
			throw new Error("extension did not register both shared-runtime instances");
		}
		expect(first.executor).toBe(second.executor);
		expect(creates).toBe(1);
		expect(bus.registerCalls).toBe(1);

		await first.shutdown();
		expect(client.closeCalls).toBe(0);
		expect(bus.transport).toBeDefined();

		const wait = Promise.withResolvers<unknown>();
		client.waitResult = wait.promise;
		const execution = second.executor.execute(executorOptions());
		while (client.calls.filter(call => call.method === "invoke.wait_turn").length < 1) await Promise.resolve();
		await second.shutdown();
		const cancelIndex = client.calls.findIndex(call => call.method === "invoke.cancel");
		const releaseIndex = client.calls.findIndex(call => call.method === "invoke.release");
		expect(cancelIndex).toBeGreaterThanOrEqual(0);
		expect(releaseIndex).toBeGreaterThan(cancelIndex);
		expect(client.closeCallIndex).toBeGreaterThan(releaseIndex);
		expect(client.closeCalls).toBe(1);
		expect(bus.transport).toBeUndefined();
		wait.reject(new ControlProtocolError("transport_closed", "closed", true));
		await execution;

		const freshClient = new FakeControl();
		const fresh = extensionHarness();
		await registerAnimaExtension(fresh.pi, { createClient: () => freshClient, bus });
		if (!fresh.executor || !fresh.shutdown) throw new Error("fresh extension runtime was not registered");
		expect((await fresh.executor.execute(executorOptions())).exitCode).toBe(0);
		await fresh.shutdown();
		expect(freshClient.closeCalls).toBe(1);
		expect(bus.registerCalls).toBe(2);
	});

	it("fails safely when message task ID or text is missing or unknown", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
		});
		const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
		let confirmations = 0;
		const ctx = {
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
				confirm: () => {
					confirmations += 1;
					return Promise.resolve(true);
				},
			},
		} as unknown as ExtensionCommandContext;

		await handleAnimaCommand("message", ctx, controller);
		await handleAnimaCommand("message task-2", ctx, controller);
		await handleAnimaCommand("message unknown Continue.", ctx, controller);

		expect(notifications).toEqual([
			{ message: "Usage: /anima message <task-id> <text...>", type: "error" },
			{ message: "Usage: /anima message <task-id> <text...>", type: "error" },
			{ message: 'Unknown Anima invocation "unknown"', type: "error" },
		]);
		expect(confirmations).toBe(0);
		expect(client.calls).toEqual([]);
	});

	it("delivers message text without confirmation", async () => {
		const client = new FakeControl();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			retention: "keep",
		});
		expect((await controller.executor.execute(executorOptions())).exitCode).toBe(0);
		client.calls.length = 0;
		const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
		let confirmations = 0;
		const ctx = {
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
				confirm: () => {
					confirmations += 1;
					return Promise.resolve(true);
				},
			},
		} as unknown as ExtensionCommandContext;

		await handleAnimaCommand("message task-2 Check   this edge case.", ctx, controller);
		while (controller.list()[0]?.state !== "released") await Bun.sleep(0);

		expect(confirmations).toBe(0);
		expect(client.calls.map(call => call.method)).toEqual(["invoke.message", "invoke.wait_turn", "invoke.release"]);
		expect(client.calls[0]?.params).toEqual({
			invocation_id: "in-1",
			body: "Check   this edge case.",
			priority: 0,
			timeout_ms: 60_000,
		});
		expect(notifications).toEqual([{ message: "task-2: message message-1 delivered", type: "info" }]);
	});
});
