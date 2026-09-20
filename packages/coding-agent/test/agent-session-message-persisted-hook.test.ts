import { expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("holds the persistence fence until post-append settlement and surfaces settlement failure", async () => {
	const auth = createInMemoryAuthStorage();
	const model = createMockModel({ responses: [] });
	const manager = SessionManager.inMemory();
	const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth),
	});
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	try {
		session.setMessagePersistedHandler(async message => {
			expect(
				manager.getContextBranch().some(entry => entry.type === "message" && entry.message.role === message.role),
			).toBe(true);
			entered.resolve();
			await gate.promise;
		});
		agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 1,
			},
		});
		await entered.promise;
		let settled = false;
		const pending = session.settleInFlightMessagePersistence().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		gate.resolve();
		await pending;
		expect(settled).toBe(true);
		session.setMessagePersistedHandler(async () => {
			throw new Error("effect checkpoint rejected");
		});
		agent.emitExternalEvent({ type: "message_end", message: { role: "user", content: "next", timestamp: 2 } });
		await expect(session.settleInFlightMessagePersistence()).rejects.toThrow("effect checkpoint rejected");
	} finally {
		gate.resolve();
		await session.dispose();
		auth.close();
	}
});
