import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SecretObfuscator } from "../secrets/obfuscator";
import { BlobStore } from "../session/blob-store";
import type { FileEntry, SessionMessageEntry } from "../session/session-entries";
import { prepareEntryForPersistence } from "../session/session-persistence";

const SECRET = "my-secret-value-1234";

function makeBlobStore(): BlobStore {
	const dir = mkdtempSync(join(tmpdir(), "omp-jsonl-seam-test-"));
	return new BlobStore(dir);
}

function makeMessageEntry(message: AgentMessage): SessionMessageEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

function makeUserMessage(content: string): AgentMessage {
	return {
		role: "user",
		content,
		timestamp: Date.now(),
	};
}

function makeUserMessageBlocks(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function makeAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic" as never,
		provider: "anthropic" as never,
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as never,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("Tier-1 Task 5: pre-persist JSONL seam", () => {
	describe("prepareEntryForPersistence with obfuscator", () => {
		it("obfuscates a user message with string content — secret replaced by #HASH# placeholder", () => {
			const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
			const blobStore = makeBlobStore();
			const entry = makeMessageEntry(makeUserMessage(`Please use ${SECRET} for the API call.`));

			const result = prepareEntryForPersistence(entry as FileEntry, blobStore, obfuscator);

			expect(result.type).toBe("message");
			if (result.type !== "message") return;
			const msg = result.message;
			expect(msg.role).toBe("user");
			if (msg.role !== "user") return;
			expect(typeof msg.content).toBe("string");
			expect(msg.content as string).not.toContain(SECRET);
			expect(msg.content as string).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);
		});

		it("obfuscates a user message with content blocks — text block secret replaced", () => {
			const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
			const blobStore = makeBlobStore();
			const entry = makeMessageEntry(makeUserMessageBlocks(`The key is ${SECRET}.`));

			const result = prepareEntryForPersistence(entry as FileEntry, blobStore, obfuscator);

			expect(result.type).toBe("message");
			if (result.type !== "message") return;
			const msg = result.message;
			expect(msg.role).toBe("user");
			if (msg.role !== "user") return;
			expect(Array.isArray(msg.content)).toBe(true);
			const blocks = msg.content as Array<{ type: string; text?: string }>;
			const textBlock = blocks.find(b => b.type === "text");
			expect(textBlock).toBeDefined();
			expect(textBlock?.text).not.toContain(SECRET);
			expect(textBlock?.text).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);
		});

		it("obfuscates a developer message with string content", () => {
			const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
			const blobStore = makeBlobStore();
			const entry = makeMessageEntry({
				role: "developer",
				content: `System note: ${SECRET} is the key.`,
				timestamp: Date.now(),
			} as AgentMessage);

			const result = prepareEntryForPersistence(entry as FileEntry, blobStore, obfuscator);

			expect(result.type).toBe("message");
			if (result.type !== "message") return;
			const msg = result.message;
			expect(msg.role).toBe("developer");
			if (msg.role !== "developer") return;
			expect(msg.content as string).not.toContain(SECRET);
			expect(msg.content as string).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);
		});

		it("obfuscates a toolResult message with content blocks", () => {
			const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
			const blobStore = makeBlobStore();
			const entry = makeMessageEntry({
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: `Output contains ${SECRET}.` }],
				isError: false,
				timestamp: Date.now(),
			} as AgentMessage);

			const result = prepareEntryForPersistence(entry as FileEntry, blobStore, obfuscator);

			expect(result.type).toBe("message");
			if (result.type !== "message") return;
			const msg = result.message;
			expect(msg.role).toBe("toolResult");
			if (msg.role !== "toolResult") return;
			const blocks = msg.content as Array<{ type: string; text?: string }>;
			const textBlock = blocks.find(b => b.type === "text");
			expect(textBlock?.text).not.toContain(SECRET);
			expect(textBlock?.text).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);
		});
	});

	describe("prepareEntryForPersistence without obfuscator (fail-open)", () => {
		it("passes plaintext through unchanged when obfuscator is undefined", () => {
			const blobStore = makeBlobStore();
			const original = `Please use ${SECRET} for the API call.`;
			const entry = makeMessageEntry(makeUserMessage(original));

			const result = prepareEntryForPersistence(entry as FileEntry, blobStore, undefined);

			expect(result.type).toBe("message");
			if (result.type !== "message") return;
			const msg = result.message;
			expect(msg.role).toBe("user");
			if (msg.role !== "user") return;
			expect(msg.content as string).toBe(original);
			expect(msg.content as string).toContain(SECRET);
		});

		it("passes plaintext through unchanged when obfuscator has no secrets", () => {
			const obfuscator = new SecretObfuscator([]);
			const blobStore = makeBlobStore();
			const original = `Please use ${SECRET} for the API call.`;
			const entry = makeMessageEntry(makeUserMessage(original));

			const result = prepareEntryForPersistence(entry as FileEntry, blobStore, obfuscator);

			expect(result.type).toBe("message");
			if (result.type !== "message") return;
			const msg = result.message;
			expect(msg.role).toBe("user");
			if (msg.role !== "user") return;
			expect(msg.content as string).toBe(original);
			expect(msg.content as string).toContain(SECRET);
		});
	});

	describe("assistant messages are not double-obfuscated", () => {
		it("preserves placeholders in assistant content — no double obfuscation", () => {
			const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
			const placeholder = obfuscator.obfuscate(SECRET);
			expect(placeholder).toMatch(/^\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$$/);

			const blobStore = makeBlobStore();
			// Assistant message that already contains a placeholder (from a
			// previous obfuscation pass). The seam must NOT re-process it.
			const entry = makeMessageEntry(makeAssistantMessage(`I see the key is ${placeholder}.`));

			const result = prepareEntryForPersistence(entry as FileEntry, blobStore, obfuscator);

			expect(result.type).toBe("message");
			if (result.type !== "message") return;
			const msg = result.message;
			expect(msg.role).toBe("assistant");
			if (msg.role !== "assistant") return;
			const blocks = msg.content as Array<{ type: string; text?: string }>;
			const textBlock = blocks.find(b => b.type === "text");
			// The placeholder is preserved verbatim — not double-obfuscated.
			expect(textBlock?.text).toContain(placeholder);
			expect(textBlock?.text).not.toContain(SECRET);
		});
	});

	describe("non-message entries pass through", () => {
		it("model_change entry is not affected by the obfuscator", () => {
			const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
			const blobStore = makeBlobStore();
			const entry = {
				type: "model_change",
				id: "mc-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				model: "anthropic/claude-test",
				role: "default",
			} as FileEntry;

			const result = prepareEntryForPersistence(entry, blobStore, obfuscator);

			expect(result.type).toBe("model_change");
		});
	});
});
