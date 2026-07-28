import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SecretObfuscator } from "../secrets/obfuscator";
import { SecretBroker } from "../secrets/broker/broker";
import {
	buildSecretPreambleMessage,
	createSecretBrokerExtension,
	injectSecretPreambleOnce,
	SECRET_BROKER_PREAMBLE,
} from "../secrets/broker/secret-broker-extension";

describe("Phase A Task A1: system-prompt preamble for redaction-marker awareness", () => {
	const conversation: AgentMessage[] = [
		{
			role: "user",
			content: [{ type: "text", text: "hello" }],
			attribution: "user",
			timestamp: 1,
		} as AgentMessage,
	];

	it("preamble is a developer-role message containing the exact marker documentation", () => {
		// buildSecretPreambleMessage returns the AgentMessage union (some variants
		// have no content); we know the shape we built — cast for the assertion.
		const msg = buildSecretPreambleMessage() as unknown as {
			role: string;
			content: string | Array<{ text?: string }>;
		};
		expect(msg.role).toBe("developer");
		const text =
			typeof msg.content === "string" ? msg.content : msg.content.map(block => block.text ?? "").join("\n");
		for (const marker of ["#ABCD#", "[REDACTED]", "[redacted from LLM]", "{{vault:"]) {
			expect(text).toContain(marker);
		}
	});

	it("preamble text matches the operator-approved wording verbatim", () => {
		expect(SECRET_BROKER_PREAMBLE).toContain("Redacted text is intentional, not corruption");
		expect(SECRET_BROKER_PREAMBLE).toContain(
			"Never attempt to obtain, decode, guess, or reconstruct redacted values",
		);
		expect(SECRET_BROKER_PREAMBLE).toContain("run_with_secret or run_with_chain");
		expect(SECRET_BROKER_PREAMBLE).toContain("/redact");
		expect(SECRET_BROKER_PREAMBLE).toContain("/bw-unlock");
	});

	it("injects exactly once, at the front of the messages array", () => {
		const first = injectSecretPreambleOnce(conversation, false);
		expect(first).toBeDefined();
		expect(first).toHaveLength(conversation.length + 1);
		expect(first![0].role).toBe("developer");
		expect(first![1]).toBe(conversation[0]);

		// Second call (already injected) is a no-op: no modification.
		const second = injectSecretPreambleOnce(conversation, true);
		expect(second).toBeUndefined();
	});

	it("preamble passes through the obfuscator unchanged (its #ABCD# is documentation, not a placeholder)", () => {
		const obfuscator = new SecretObfuscator([]);
		expect(obfuscator.obfuscate(SECRET_BROKER_PREAMBLE)).toBe(SECRET_BROKER_PREAMBLE);
		expect(obfuscator.deobfuscateForDisplay(SECRET_BROKER_PREAMBLE)).toBe(SECRET_BROKER_PREAMBLE);
	});

	it("factory wires the context handler: first event injects, second is a no-op", () => {
		type ContextHandler = (event: {
			type: "context";
			messages: AgentMessage[];
		}) => { messages?: AgentMessage[] } | void;
		let contextHandler: ContextHandler | undefined;
		const api = {
			registerTool: () => {},
			registerCommand: () => {},
			on(event: string, handler: ContextHandler) {
				if (event === "context") contextHandler = handler;
			},
		};
		createSecretBrokerExtension(new SecretBroker())(api as never);
		expect(contextHandler).toBeDefined();

		const first = contextHandler!({ type: "context", messages: conversation });
		expect(first?.messages).toHaveLength(conversation.length + 1);
		expect(first?.messages?.[0].role).toBe("developer");

		const second = contextHandler!({ type: "context", messages: conversation });
		expect(second?.messages).toBeUndefined();
	});
});
