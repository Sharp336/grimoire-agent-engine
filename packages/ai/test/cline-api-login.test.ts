import { describe, expect, it } from "bun:test";
import { loginClineApi } from "@oh-my-pi/pi-ai/registry/cline-api";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("loginClineApi", () => {
	it("validates the usage-credit route with an unmodified provider/model id", async () => {
		let body: Record<string, unknown> = {};
		const fetchImpl: FetchImpl = async (_input, init) => {
			body = JSON.parse(String(init?.body ?? "{}"));
			return new Response(JSON.stringify({ choices: [] }), { status: 200 });
		};
		const key = await loginClineApi({
			fetch: fetchImpl,
			onPrompt: async () => "sk_CLINE_API",
			onAuth: () => {},
			onProgress: () => {},
		});

		expect(key).toBe("sk_CLINE_API");
		expect(body.model).toBe("zai/glm-5.2");
		expect(body.max_completion_tokens).toBe(256);
		expect(body.stream).toBe(false);
	});
});
