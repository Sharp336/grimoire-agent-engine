import { describe, expect, it } from "bun:test";
import type { Model, UsageReport } from "@oh-my-pi/pi-ai";
import { ProviderAdmissionClient, ProviderAdmissionError } from "../src/engine/provider-admission";
import type { AuthStorage } from "../src/session/auth-storage";

describe("ProviderAdmissionClient", () => {
	it("admits each physical fetch and invalidates freshness after each result", async () => {
		let admissionBefore = 0;
		let admissionAfter = 0;
		let invalidations = 0;
		let usageReads = 0;
		let providerCalls = 0;
		const admissionFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { phase: string; usageReport?: UsageReport };
			if (body.phase === "before") {
				admissionBefore += 1;
				expect(body.usageReport?.raw).toBeUndefined();
			} else admissionAfter += 1;
			return Response.json({ allowed: true, status: "within_weekly_ceiling" });
		};
		const authStorage = {
			invalidateUsageCache: async () => {
				invalidations += 1;
			},
			fetchUsageReports: async () => {
				usageReads += 1;
				return [usageReport()];
			},
		} as unknown as AuthStorage;
		const wrapped = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", admissionFetch)
			.createHook(identity(), authStorage, "https://chatgpt.com/backend-api")
			.wrapFetch(model(), async () => {
				providerCalls += 1;
				return new Response("ok");
			});
		await wrapped("https://chatgpt.com/backend-api/codex/responses");
		await wrapped("https://chatgpt.com/backend-api/codex/responses");
		await Promise.resolve();
		expect({ admissionBefore, usageReads, providerCalls }).toEqual({
			admissionBefore: 2,
			usageReads: 2,
			providerCalls: 2,
		});
		expect(invalidations).toBe(4);
		expect(admissionAfter).toBe(2);
	});

	it("fails closed with a permanent typed error before provider dispatch", async () => {
		const admissionFetch = async () => Response.json({ allowed: false, status: "codex_weekly_ceiling_reached" });
		const authStorage = {
			invalidateUsageCache: async () => {},
			fetchUsageReports: async () => [usageReport()],
		} as unknown as AuthStorage;
		let providerCalls = 0;
		const wrapped = new ProviderAdmissionClient("http://127.0.0.1/provider-admission", "token", admissionFetch)
			.createHook(identity(), authStorage, "https://chatgpt.com/backend-api")
			.wrapFetch(model(), async () => {
				providerCalls += 1;
				return new Response("unexpected");
			});
		const error = await wrapped("https://chatgpt.com/backend-api/codex/responses").catch(reason => reason);
		expect(error).toBeInstanceOf(ProviderAdmissionError);
		expect(error).toMatchObject({ code: "codex_weekly_ceiling_reached", retryable: false });
		expect(providerCalls).toBe(0);
	});
});

function identity() {
	return {
		providerAccountRef: "gctx:2222222222222222",
		routeRef: "gctx:3333333333333333",
		providerKind: "openai_codex_subscription" as const,
		providerId: "openai-codex",
		accountBindingId: "acct-1",
	};
}

function model(): Model {
	return { id: "gpt-5.5", provider: "openai-codex" } as Model;
}

function usageReport(): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		metadata: { accountId: "acct-1" },
		limits: [],
		raw: { accessToken: "must-not-cross-boundary" },
	};
}
