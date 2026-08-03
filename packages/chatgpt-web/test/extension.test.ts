import { describe, expect, test, vi } from "bun:test";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { createChatGptWebExtension } from "../src/extension";
import { createChatGptWebProviderModels } from "../src/models";

const browserOnlyConfig = { mode: "browser-only" as const, tunnelId: null, runtimeKeyConfigured: false };
const login = { authenticated: true as const, proAvailable: false, verifiedAt: "2026-08-02T00:00:00.000Z" };

function dependencies(overrides: Record<string, unknown> = {}) {
	const stream = vi.fn(() => ({}) as AssistantMessageEventStream);
	const createStream = vi.fn(() => stream);
	return {
		readConfig: vi.fn(async () => browserOnlyConfig),
		readLoginStatus: vi.fn(async () => login),
		createModels: createChatGptWebProviderModels,
		createStream,
		stream,
		...overrides,
	};
}

describe("ChatGPT Web extension", () => {
	test("registers the exact keyless route with bare model IDs and a lazy stream", async () => {
		const deps = dependencies();
		const capability = Object.freeze({});
		const issue = vi.fn(() => ({ keylessCapability: capability }));
		const register = vi.fn();
		await createChatGptWebExtension(deps)({
			issueKeylessProviderRegistration: issue,
			registerProvider: register,
		});

		expect(issue).toHaveBeenCalledWith({ api: "chatgpt-web", baseUrl: "chatgpt-web://local" });
		expect(register).toHaveBeenCalledTimes(1);
		const [provider, config] = register.mock.calls[0] as [string, Record<string, unknown>];
		expect(provider).toBe("chatgpt-web");
		expect(config.baseUrl).toBe("chatgpt-web://local");
		expect(config.api).toBe("chatgpt-web");
		expect(config.auth).toBe("none");
		expect(config.keylessCapability).toBe(capability);
		expect(config).not.toHaveProperty("apiKey");
		expect(config).not.toHaveProperty("oauth");
		const models = config.models as Array<{ id: string; supportsTools: boolean }>;
		expect(models.map(model => model.id)).toEqual(["light", "medium", "high", "extra-high"]);
		expect(models.every(model => model.supportsTools === false)).toBe(true);
		expect(deps.createStream).not.toHaveBeenCalled();

		const streamSimple = config.streamSimple as (...args: unknown[]) => unknown;
		streamSimple({} as never, {} as never, {} as never);
		streamSimple({} as never, {} as never, {} as never);
		expect(deps.createStream).toHaveBeenCalledTimes(1);
		expect(deps.createStream).toHaveBeenCalledWith({ config: browserOnlyConfig });
		expect(deps.stream).toHaveBeenCalledTimes(2);
	});

	test("does not request a capability until config and marker validation succeed", async () => {
		for (const overrides of [
			{ readConfig: vi.fn(async () => null) },
			{ readLoginStatus: vi.fn(async () => null) },
			{
				readConfig: vi.fn(async () => {
					throw new Error("invalid secure state");
				}),
			},
		]) {
			const deps = dependencies(overrides);
			const issue = vi.fn(() => ({ keylessCapability: {} }));
			const register = vi.fn();
			await createChatGptWebExtension(deps)({
				issueKeylessProviderRegistration: issue,
				registerProvider: register,
			});
			expect(issue).not.toHaveBeenCalled();
			expect(register).not.toHaveBeenCalled();
		}
	});

	test("refresh construction replaces Pro and tool capability metadata", async () => {
		const issue = vi.fn(() => ({ keylessCapability: Object.freeze({}) }));
		const register = vi.fn();
		const fullDeps = dependencies({
			readConfig: vi.fn(async () => ({
				mode: "full" as const,
				tunnelId: "tunnel_00000000000000000000000000000000",
				runtimeKeyConfigured: true,
			})),
			readLoginStatus: vi.fn(async () => ({ ...login, proAvailable: true })),
		});
		await createChatGptWebExtension(fullDeps)({
			issueKeylessProviderRegistration: issue,
			registerProvider: register,
		});
		// vi erases the contextual registerProvider argument type at the mock boundary.
		const registeredConfig = register.mock.calls[0]?.[1] as {
			models: Array<{ id: string; supportsTools: boolean }>;
		};
		const models = registeredConfig.models;
		expect(models.map(model => model.id)).toEqual(["light", "medium", "high", "extra-high", "pro"]);
		expect(models.find(model => model.id === "light")?.supportsTools).toBe(true);
		expect(models.find(model => model.id === "pro")?.supportsTools).toBe(false);
	});
});
