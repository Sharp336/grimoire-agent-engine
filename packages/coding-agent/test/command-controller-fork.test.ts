import { afterEach, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

function streamingContext(options: { persisted?: boolean } = {}) {
	const appendSessionInit = vi.fn();
	const flush = vi.fn(async () => {});
	const close = vi.fn(async () => {});
	const dropSession = vi.fn(async () => {});
	const createCommittedChildSession = vi.fn(async (_id: string, childOptions?: { materializeParent?: boolean }) => {
		if (options.persisted === false && !childOptions?.materializeParent) {
			throw new Error("Committed child sessions require a persisted parent session");
		}
		return {
			manager: { appendSessionInit, flush, close, dropSession },
			sessionFile: "/tmp/parent/Fork-child.jsonl",
			parentSessionId: "parent",
			parentLeafId: "leaf",
			messages: [],
		};
	});
	const showStatus = vi.fn();
	const showError = vi.fn();
	const fork = vi.fn();
	const abort = vi.fn();
	const switchSession = vi.fn();
	const streamMessage = { role: "assistant", content: [{ type: "text", text: "still streaming" }] };
	const session = {
		isStreaming: true,
		getAgentId: () => "Main",
		agent: { state: { systemPrompt: ["system"], streamMessage } },
		getActiveToolNames: () => ["read"],
		settings: { get: () => false },
		sessionManager: {
			peekSessionInit: () => ({
				outputSchema: { type: "string" },
				outputSchemaMode: "strict",
				restrictToolNames: true,
			}),
		},
		createCommittedChildSession,
		fork,
		abort,
	};
	const ctx = { session, showStatus, showError, switchSession } as unknown as InteractiveModeContext;
	return {
		ctx,
		session,
		streamMessage,
		appendSessionInit,
		flush,
		close,
		dropSession,
		createCommittedChildSession,
		fork,
		abort,
		switchSession,
		showStatus,
		showError,
	};
}

describe("CommandController streaming /fork", () => {
	afterEach(() => AgentRegistry.resetGlobalForTests());

	it("parks a committed-boundary child without switching the parent", async () => {
		const harness = streamingContext();
		await new CommandController(harness.ctx).handleForkCommand();
		expect(harness.createCommittedChildSession).toHaveBeenCalledTimes(1);
		expect(harness.appendSessionInit).toHaveBeenCalledWith(
			expect.objectContaining({
				task: "Continue the forked session from its committed boundary.",
				tools: ["read"],
				spawns: "",
				outputSchema: { type: "string" },
				outputSchemaMode: "strict",
				restrictToolNames: true,
			}),
		);
		expect(harness.flush).toHaveBeenCalledTimes(1);
		expect(harness.close).toHaveBeenCalledTimes(1);
		const ref = AgentRegistry.global()
			.list()
			.find(candidate => candidate.id.startsWith("Fork-"));
		expect(ref).toMatchObject({ kind: "sub", parentId: "Main", status: "parked" });
		expect(harness.showStatus).toHaveBeenCalledWith(
			`Forked committed session to ${ref?.id}; open /hub to continue it.`,
		);
		expect(harness.fork).not.toHaveBeenCalled();
		expect(harness.abort).not.toHaveBeenCalled();
		expect(harness.switchSession).not.toHaveBeenCalled();
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.agent.state.streamMessage).toBe(harness.streamMessage);
	});

	it("materializes a lazy parent before parking the committed-boundary child", async () => {
		const harness = streamingContext({ persisted: false });
		await new CommandController(harness.ctx).handleForkCommand();
		expect(harness.createCommittedChildSession).toHaveBeenCalledWith(expect.stringMatching(/^Fork-/), {
			materializeParent: true,
		});
		expect(harness.showError).not.toHaveBeenCalled();
		expect(AgentRegistry.global().list()).toHaveLength(1);
	});
});
