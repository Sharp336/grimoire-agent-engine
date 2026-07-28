import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentDefinition, ExecutorOptions } from "@oh-my-pi/pi-coding-agent";
import { AnimaExecutorController } from "../src/executor";
import type { AnimaControl, ControlEvent, ControlRequestOptions, ProtocolHello } from "../src/protocol";

const HELLO: ProtocolHello = {
	protocol: "anima-control",
	version: 1,
	anima_version: "test",
	methods: ["invoke.start", "invoke.observe", "invoke.wait_turn", "invoke.cancel", "invoke.release"],
	capabilities: { turn_authority: true },
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
			owner: "external:omp:test",
		});
		expect(controller.executor.claim(packagedAgent())).toBe(true);
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
			owner: "external:omp:test",
		});
		const progress: string[] = [];
		const result = await controller.executor.execute({
			...executorOptions(),
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
		expect(start).not.toHaveProperty("context");
		expect(start.worktree).toBe(false);
		expect(start.route).toMatchObject({ harness: "claude", provider: "anthropic", effort: "high" });
		expect(start.core_prompt).toEqual({
			body: "Review exactly once.",
			sha256: "6484359fa323e2b597bc6a29f191c1d7af29e9dd1233e3e9bd19d418a4a7a0c8",
		});
		expect(progress.some(line => line.includes("creating durable invocation"))).toBe(true);
	});

	it("cancels the durable invocation before returning an aborted result", async () => {
		const client = new FakeControl();
		const wait = Promise.withResolvers<unknown>();
		client.waitResult = wait.promise;
		const controller = new AnimaExecutorController({
			client,
			agentRoot: path.resolve(import.meta.dir, "../agents"),
			owner: "external:omp:test",
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
			owner: "external:omp:test",
		});
		const result = await controller.executor.execute({
			...executorOptions(),
			additionalDirectories: ["/tmp/second-root"],
		});
		expect(result).toMatchObject({ exitCode: 1, error: "unsupported_additional_directories" });
		expect(client.calls).toEqual([]);
	});
});
