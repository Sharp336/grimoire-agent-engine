import { describe, expect, it } from "bun:test";
import { PrimeBridgeHttpClient } from "../src/integrations/prime-bridge/client";

describe("PrimeBridgeHttpClient", () => {
	it("refuses redirects on authenticated requests", async () => {
		let requestInit: RequestInit | undefined;
		const client = new PrimeBridgeHttpClient({
			url: "http://127.0.0.1:4123",
			tokenPath: "/tmp/prime-bridge-token",
			readFile: async () => "bridge-token",
			fetch: async (_input, init) => {
				requestInit = init;
				return new Response(JSON.stringify([]), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});

		await client.get<unknown[]>("/v1/peers");

		expect(requestInit?.redirect).toBe("error");
	});
});
