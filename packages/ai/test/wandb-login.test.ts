import { describe, expect, test, vi } from "bun:test";
import { loginWandb } from "@oh-my-pi/pi-ai/registry/wandb";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("Weights & Biases login", () => {
	test("validates API key against the W&B models endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.inference.wandb.ai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer wandb-test-key" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const apiKey = await loginWandb({
			onPrompt: async () => " wandb-test-key ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("wandb-test-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("surfaces validation errors from the W&B models endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response("Unauthorized", {
				status: 401,
				headers: { "Content-Type": "text/plain" },
			});
		});

		await expect(
			loginWandb({
				onPrompt: async () => "wandb-test-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Weights & Biases API key validation failed (401)");
	});
});
