import { describe, expect, it } from "bun:test";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * An extension model alias pairs a local `id` (selection/caching/attribution)
 * with a `requestModelId` (the wire model id). Ollama's `createChatBody` puts
 * `model` on the request body; it must carry the alias's `requestModelId`, not
 * the local `id`, or the Ollama server rejects the alias as an unknown model.
 */
describe("Ollama alias requestModelId on the wire", () => {
	it("sends the alias requestModelId as the request body model, not the local id", async () => {
		let wireModel: string | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body = JSON.parse(String(init?.body)) as { model?: unknown };
			wireModel = typeof body.model === "string" ? body.model : undefined;
			return new Response(
				'{"message":{"content":"ok"},"done":true,"done_reason":"stop","prompt_eval_count":1,"eval_count":1}\n',
				{ status: 200 },
			);
		};

		// Local alias id differs from the upstream wire id it requests.
		const alias = buildModel({
			id: "my-local-alias",
			name: "My Local Alias",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8192,
			requestModelId: "qwen3.6-coder:27b",
		});

		const context: Context = {
			messages: [{ role: "user", content: "Reply ok.", timestamp: 0 }],
		};

		const result = await streamOllama(alias, context, { apiKey: "ollama", fetch: fetchMock }).result();

		// The wire body carries the alias's requestModelId, not the local id.
		expect(wireModel).toBe("qwen3.6-coder:27b");
		expect(wireModel).not.toBe("my-local-alias");
		// Local identity is preserved on the assistant message attribution.
		expect(result.model).toBe("my-local-alias");
	});
});
