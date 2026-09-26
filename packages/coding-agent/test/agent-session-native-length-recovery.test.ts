import { expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { NativeSessionStorage } from "@oh-my-pi/pi-coding-agent/session/native-session-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("keeps a native thinking-only length stop visible when incomplete-response compaction cannot recover", async () => {
	const auth = createInMemoryAuthStorage();
	auth.setRuntimeApiKey("mock", "test-key");
	let throughSeq = 0;
	// Append-only journal: the recovery rewind trims the dropped turn out of the native working set.
	const storage = {
		locator: "native:family/generation",
		append(entries: readonly SessionEntry[]) {
			throughSeq += Math.max(1, entries.length);
			const position = { familyId: "family", generationId: "generation", throughSeq, incarnation: 1 };
			return { position, completion: Promise.resolve() };
		},
		async barrier() {},
	} as unknown as NativeSessionStorage;
	const sessionManager = SessionManager.createNative("/native-length", storage, "/native-length");
	const thinking = { type: "thinking" as const, thinking: "long reasoning", thinkingSignature: "reasoning_content" };
	const mock = createMockModel({
		responses: [
			{ content: [thinking], stopReason: "length" },
			{ content: ["unexpected retry"], stopReason: "stop" },
		],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "retry.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	const warnings = spyOn(logger, "warn");
	try {
		await session.prompt("question");

		expect(warnings.mock.calls.map(([message]) => message)).not.toContain("Agent listener rejected");
		expect(mock.calls).toHaveLength(1);
		const truncated = { role: "assistant", stopReason: "length", content: [thinking] };
		expect(session.messages.at(-1)).toMatchObject(truncated);
		expect(sessionManager.getLeafEntry()).toMatchObject({ type: "message", message: truncated });
	} finally {
		warnings.mockRestore();
		await session.dispose();
		auth.close();
	}
}, 30_000);
