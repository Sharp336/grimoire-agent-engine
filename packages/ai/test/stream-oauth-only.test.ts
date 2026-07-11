import { afterEach, describe, expect, test } from "bun:test";
import {
	AuthStorage,
	SqliteAuthCredentialStore,
	seedApiKeyResolver,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const PROVIDER = "xai-grok-build";
const API = "oauth-only-admission-test" as Api;
const SOURCE = "stream-oauth-only-test";
const model = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: API,
	provider: PROVIDER,
	baseUrl: "https://cli-chat-proxy.grok.com/v1",
	contextWindow: 500_000,
	maxTokens: 500_000,
} as Model<Api>;
const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assertMissingOAuth(run: () => AssistantMessageEventStream): void {
	try {
		run();
		throw new Error("expected OAuth admission failure");
	} catch (error) {
		expect(error).toBeInstanceOf(AIError.MissingApiKeyError);
		expect((error as Error).message).toBe("No OAuth credential for provider: xai-grok-build. Run /login.");
		expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(true);
	}
}

describe("OAuth-only stream admission", () => {
	afterEach(() => unregisterCustomApis(SOURCE));

	test("rejects static, arbitrary, cross-provider, and generic-seeded credentials before dispatch", async () => {
		let dispatches = 0;
		registerCustomApi(API, () => {
			dispatches += 1;
			return new AssistantMessageEventStream();
		}, SOURCE);
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store);
		const buildResolver = storage.createOAuthApiKeyResolver(PROVIDER);

		assertMissingOAuth(() => stream(model, context, { apiKey: "static" }));
		assertMissingOAuth(() => streamSimple(model, context, { apiKey: "static" }));
		assertMissingOAuth(() => streamSimple(model, context, { apiKey: () => "arbitrary" }));
		assertMissingOAuth(() => streamSimple(model, context, { apiKey: seedApiKeyResolver("sentinel", buildResolver) }));
		const otherModel = { ...model, provider: "xai-oauth" };
		assertMissingOAuth(() => streamSimple(model, context, { apiKey: storage.resolver(otherModel.provider) }));
		expect(dispatches).toBe(0);
		store.close();
	});

	test("dispatches only with a provider-bound resolver", async () => {
		let dispatches = 0;
		registerCustomApi(API, (_model, _context, options) => {
			dispatches += 1;
			expect(options?.apiKey).toBe("oauth-access");
			const events = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: API,
				provider: PROVIDER,
				model: model.id,
				timestamp: 1,
				stopReason: "stop",
				usage: usage(),
			};
			queueMicrotask(() => {
				events.push({ type: "start", partial: message });
				events.push({ type: "done", reason: "stop", message });
			});
			return events;
		}, SOURCE);
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store);
		await storage.set(PROVIDER, [
			{ type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60 * 60_000 },
		]);
		const events = streamSimple(model, context, { apiKey: storage.createOAuthApiKeyResolver(PROVIDER) });
		for await (const _event of events) {
			// drain
		}
		expect((await events.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(dispatches).toBe(1);
		store.close();
	});
});
