import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type {
	AgentDefinition,
	ExecutorOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	IrcMessage,
} from "@oh-my-pi/pi-coding-agent";
import { AnimaExecutorController } from "../src/executor";
import animaExtension, { handleAnimaCommand } from "../src/extension";
import type { AnimaControl, ControlEvent, ControlRequestOptions, ProtocolHello } from "../src/protocol";

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

	hello(): Promise<ProtocolHello> {
		return Promise.resolve(HELLO);
	}

	async request<T>(method: string, params: unknown, options?: ControlRequestOptions): Promise<T> {
		this.calls.push({ method, params, options });
		switch (method) {
			case "invoke.start":
				return {
					invocation_id: "in-1",
					agent_id: "agent-1",
					session_name: "omp-agent-1",
					state: "starting",
				} as T;
			case "invoke.wait_turn":
				return (await this.waitResult) as T;
			case "invoke.observe":
				return {
					invocation_id: "in-1",
					agent_id: "agent-1",
					session_name: "omp-agent-1",
					state: "generating",
				} as T;
			case "invoke.message":
				return { message_id: "message-1" } as T;
			default:
				return {} as T;
		}
	}

	onEvent(listener: (event: ControlEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): Promise<void> {
		return Promise.resolve();
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

describe("AnimaExecutorController", () => {
	it("claims only packaged or explicitly configured agents", () => {
		const controller = new AnimaExecutorController({
			client: new FakeControl(),
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			allowAgentNames: ["project-claude"],
		});
		expect(controller.executor.claim(packagedAgent())).toBe(true);
		expect(
			controller.executor.claim({ ...packagedAgent(), filePath: "/linked/plugin/agents/claude-reviewer.md" }),
		).toBe(true);
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
		expect(corePrompt.body).toContain("final assistant response");
		expect(corePrompt.body).not.toContain("Shared context\n\nInspect the target exactly once.");
		expect(corePrompt.body.toLowerCase()).not.toContain("yield");
		expect(corePrompt.sha256).toBe(new Bun.CryptoHasher("sha256").update(corePrompt.body).digest("hex"));
		expect(client.calls[0]?.options?.id).toBe("start:external:omp:test-sidecar:task-2");
		expect(progress.some(line => line.includes("creating durable invocation"))).toBe(true);
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

		expect(messageId).toBe("message-1");
		expect(client.calls.map(call => call.method)).toEqual([
			"invoke.start",
			"invoke.wait_turn",
			"invoke.release",
			"invoke.message",
		]);
		expect(client.calls[2]?.params).toEqual({ invocation_id: "in-1", policy: "keep" });
		expect(client.calls[3]?.params).toEqual({
			invocation_id: "in-1",
			body: "Check the remaining edge case.",
			priority: 0,
		});
		expect(controller.list()).toEqual([
			expect.objectContaining({
				requestId: "task-2",
				invocationId: "in-1",
				state: "released",
				lastMessageId: "message-1",
				detail: "follow-up message message-1 delivered",
			}),
		]);
	});

	it("maps an awaited IRC send to urgent threaded Anima mail", async () => {
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
			from: "Main",
			to: "omp-agent-1",
			body: "Report the blocker.",
			ts: Date.now(),
			threadId: "thread-1",
			replyTo: "mail-parent",
		};

		expect(await controller.sendPeer(message, { expectsReply: true })).toBe("message-1");
		expect(client.calls).toEqual([
			{
				method: "invoke.message",
				params: {
					invocation_id: "in-1",
					subject: "OMP IRC from Main",
					body: "Report the blocker.",
					priority: 0,
					thread_id: "thread-1",
					reply_to: "mail-parent",
				},
				options: { id: "irc:irc-1" },
			},
		]);
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
		await Promise.resolve();
		abort.abort("operator");
		const result = await pending;
		wait.resolve({});

		expect(result).toMatchObject({ exitCode: 1, aborted: true, abortReason: "operator" });
		expect(client.calls.map(call => call.method)).toEqual([
			"invoke.start",
			"invoke.wait_turn",
			"invoke.cancel",
			"invoke.release",
		]);
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

		expect(confirmations).toBe(0);
		expect(client.calls.map(call => call.method)).toEqual(["invoke.message"]);
		expect(client.calls[0]?.params).toEqual({
			invocation_id: "in-1",
			body: "Check   this edge case.",
			priority: 0,
		});
		expect(notifications).toEqual([{ message: "task-2: message message-1 delivered", type: "info" }]);
	});
});
