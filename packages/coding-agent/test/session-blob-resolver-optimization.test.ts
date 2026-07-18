import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { BlobStore } from "../src/session/blob-store";
import type { SessionMessageEntry } from "../src/session/session-entries";
import { resolveBlobRefsInEntries } from "../src/session/session-loader";

const ref = (hash: string): string => `blob:sha256:${hash}`;

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return {
		type: "message",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: "2026-07-17T00:00:00.000Z",
		message,
	};
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

class ScriptedStore extends BlobStore {
	readonly reads: string[] = [];

	constructor(
		dir: string,
		private readonly read: (hash: string) => Promise<Buffer | null>,
	) {
		super(dir);
	}

	override async get(hash: string): Promise<Buffer | null> {
		this.reads.push(hash);
		return this.read(hash);
	}
}

describe("blob resolver optimization invariants", () => {
	it("retains the matched-payload early return", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-early-return-");
		const store = new ScriptedStore(tempDir.path(), async hash => Buffer.from(hash));
		// Transport-native history keeps provider image URLs on the same block as
		// the inline image payload; resolving `data` must not descend into it.
		const image: ImageContent & { image_url: string } = {
			type: "image",
			data: ref("payload"),
			mimeType: "image/png",
			image_url: ref("nested-provider-url"),
		};
		const message: UserMessage = { role: "user", content: [image], timestamp: 0 };

		await resolveBlobRefsInEntries([messageEntry(message)], store);

		expect(image.data).toBe(Buffer.from("payload").toString("base64"));
		expect(image.image_url).toBe(ref("nested-provider-url"));
		expect(store.reads).toEqual(["payload"]);
	});

	it("retains the content/images key gate", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-key-gate-");
		const store = new ScriptedStore(tempDir.path(), async hash => Buffer.from(hash));
		const detailsImage = { type: "image", data: ref("details"), mimeType: "image/png" };
		const contentImage: ImageContent = { type: "image", data: ref("content"), mimeType: "image/png" };
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-key-gate",
			toolName: "read",
			content: [contentImage],
			details: detailsImage,
			isError: false,
			timestamp: 0,
		};

		await resolveBlobRefsInEntries([messageEntry(message)], store);

		expect(detailsImage.data).toBe(ref("details"));
		expect(contentImage.data).toBe(Buffer.from("content").toString("base64"));
		expect(store.reads).toEqual(["content"]);
	});

	it("ignores inherited traversal keys", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-own-keys-");
		const store = new ScriptedStore(tempDir.path(), async hash => Buffer.from(hash));
		const inheritedImage = { type: "image", data: ref("inherited"), mimeType: "image/png" };
		const wrapper: Record<string, object> = Object.create({ content: [inheritedImage] });
		wrapper.own = { note: "plain" };
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-own-keys",
			toolName: "read",
			content: [],
			details: wrapper,
			isError: false,
			timestamp: 0,
		};

		await resolveBlobRefsInEntries([messageEntry(message)], store);

		expect(inheritedImage.data).toBe(ref("inherited"));
		expect(store.reads).toEqual([]);
	});

	it("preserves warning order across result, image_url, and descendants", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-warning-order-");
		const slowResult = Promise.withResolvers<Buffer | null>();
		const store = new ScriptedStore(tempDir.path(), async hash =>
			hash === "slow-result" ? slowResult.promise : null,
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// OpenAI Responses items persist on the assistant provider payload.
		const node: Record<string, unknown> = {
			type: "image_generation_call",
			result: ref("slow-result"),
			image_url: ref("provider-url"),
			content: [{ type: "image", data: ref("child-image"), mimeType: "image/png" }],
		};
		const message = assistantMessage({ providerPayload: { type: "openaiResponsesHistory", items: [node] } });

		try {
			const resolving = resolveBlobRefsInEntries([messageEntry(message)], store);
			expect(store.reads).toEqual(["slow-result"]);
			slowResult.resolve(null);
			await resolving;
			expect(warn.mock.calls.map(([message, fields]) => [message, fields?.hash])).toEqual([
				["Blob not found for image reference", "slow-result"],
				["Blob not found for persisted image data URL", "provider-url"],
				["Blob not found for image reference", "child-image"],
			]);
			expect(store.reads).toEqual(["slow-result", "provider-url", "child-image"]);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not snapshot aliased descendant refs before their dependency", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-shared-mutation-");
		const parentResponse = Promise.withResolvers<Buffer | null>();
		const sharedMutation = Promise.withResolvers<void>();
		let sharedReads = 0;
		const store = new ScriptedStore(tempDir.path(), async hash => {
			if (hash === "parent") return parentResponse.promise;
			if (hash === "shared") {
				sharedReads += 1;
				if (sharedReads > 1) throw new Error("duplicate shared read");
				return Buffer.from("shared");
			}
			throw new Error(`unexpected read: ${hash}`);
		});
		let sharedData = ref("shared");
		const shared: ImageContent = {
			type: "image",
			get data(): string {
				return sharedData;
			},
			set data(value: string) {
				sharedData = value;
				sharedMutation.resolve();
			},
			mimeType: "image/png",
		};
		const node: Record<string, unknown> = {
			type: "image_generation_call",
			result: ref("parent"),
			content: [shared],
		};
		const message = assistantMessage({
			content: [shared],
			providerPayload: { type: "openaiResponsesHistory", items: [node] },
		});

		const resolving = resolveBlobRefsInEntries([messageEntry(message)], store);
		await sharedMutation.promise;
		parentResponse.resolve(Buffer.from("parent"));
		await resolving;

		expect(sharedReads).toBe(1);
		expect(shared.data).toBe(Buffer.from("shared").toString("base64"));
		expect(node.result).toBe(Buffer.from("parent").toString("base64"));
		expect(store.reads).toEqual(["shared", "parent"]);
	});

	it("scans each entry at the original map initiation point", async () => {
		using tempDir = TempDir.createSync("@blob-resolver-entry-mutation-");
		const secondMessage: UserMessage = { role: "user", content: "plain before the first read starts", timestamp: 0 };
		const store = new ScriptedStore(tempDir.path(), async hash => {
			if (hash === "first") {
				secondMessage.content = [{ type: "image", data: ref("second"), mimeType: "image/png" }];
				return Buffer.from("first");
			}
			if (hash === "second") return Buffer.from("second");
			throw new Error(`unexpected read: ${hash}`);
		});
		const firstImage: ImageContent = { type: "image", data: ref("first"), mimeType: "image/png" };
		const firstMessage: UserMessage = { role: "user", content: [firstImage], timestamp: 0 };

		await resolveBlobRefsInEntries([messageEntry(firstMessage), messageEntry(secondMessage)], store);

		expect(Array.isArray(secondMessage.content)).toBe(true);
		if (!Array.isArray(secondMessage.content)) throw new Error("entry mutation was not applied");
		const resolvedImage = secondMessage.content[0];
		expect(resolvedImage?.type).toBe("image");
		if (resolvedImage?.type !== "image") throw new Error("expected resolved image content");
		expect(resolvedImage.data).toBe(Buffer.from("second").toString("base64"));
		expect(store.reads).toEqual(["first", "second"]);
	});
});
