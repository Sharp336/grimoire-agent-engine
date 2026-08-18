import { describe, expect, it, vi } from "bun:test";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { loginBfl } from "@oh-my-pi/pi-ai/registry/oauth/black-forest-labs";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("bfl login", () => {
	it("validates the trimmed pasted key via x-key against the credits endpoint and rejects on 403", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.bfl.ai/v1/credits");
			expect(init?.method).toBe("GET");
			// BFL authenticates via x-key only - never Authorization: Bearer.
			expect(init?.headers).toEqual({ "x-key": "bfl-test-key" });
			return new Response(JSON.stringify({ detail: "Not authenticated" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(
			loginBfl({
				onPrompt: async () => "  bfl-test-key  ",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Black Forest Labs API key validation failed (403): Not authenticated");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fails open when the validation request cannot reach the network", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			throw new Error("network unreachable");
		});

		const apiKey = await loginBfl({
			onPrompt: async () => "bfl-offline-key",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("bfl-offline-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects a malformed key with the 422 detail from the API", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(JSON.stringify({ detail: "Invalid API key format" }), {
				status: 422,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(
			loginBfl({
				onPrompt: async () => "not-a-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Black Forest Labs API key validation failed (422): Invalid API key format");
	});

	it("surfaces cancellation instead of failing open when the user aborts mid-validation", async () => {
		const controller = new AbortController();
		const fetchMock: FetchImpl = vi.fn(async () => {
			controller.abort();
			throw new Error("request aborted");
		});

		await expect(
			loginBfl({
				onPrompt: async () => "bfl-aborted-key",
				fetch: fetchMock,
				signal: controller.signal,
			}),
		).rejects.toThrow(LoginCancelledError);
	});
});
