import { afterEach, describe, expect, test, vi } from "bun:test";
import { getCatalogProviderEntry, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	moonshotCnModelManagerOptions,
	moonshotModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { $pickenv } from "@oh-my-pi/pi-utils";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CN_MODELS_URL = "https://api.moonshot.cn/v1/models";

const ORIGINAL_ENV: Record<string, string | undefined> = {
	MOONSHOT_BASE_URL: Bun.env.MOONSHOT_BASE_URL,
	MOONSHOT_CN_BASE_URL: Bun.env.MOONSHOT_CN_BASE_URL,
	MOONSHOT_CN_API_KEY: Bun.env.MOONSHOT_CN_API_KEY,
};

function restoreEnv(): void {
	for (const key in ORIGINAL_ENV) {
		const value = ORIGINAL_ENV[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
}

function inputUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function makeFetchMock(calls: string[], ids: string[]): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		const url = inputUrl(input);
		if (url === MODELS_DEV_URL) {
			return new Response("{}", { status: 500 });
		}
		calls.push(url);
		return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as FetchImpl;
}

afterEach(() => {
	restoreEnv();
	vi.restoreAllMocks();
});

describe("Moonshot China provider (moonshot-cn)", () => {
	test("is a catalog provider keyed by MOONSHOT_CN_API_KEY with the CN default model", () => {
		const entry = getCatalogProviderEntry("moonshot-cn");
		expect(entry).toBeDefined();
		expect(entry?.envVars).toEqual(["MOONSHOT_CN_API_KEY"]);
		expect(entry?.defaultModel).toBe("kimi-k2.7-code");

		Bun.env.MOONSHOT_CN_API_KEY = "moonshot-cn-test-key";
		expect($pickenv(...(entry?.envVars ?? []))).toBe("moonshot-cn-test-key");
	});

	test("bundles the models.dev moonshotai-cn catalog against the CN endpoint", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "moonshot-cn");
		expect(descriptor).toBeDefined();
		// The runtime descriptor table drives both discovery hydration and the
		// generate-models bundling source; losing this row silently unbundles the
		// CN catalog on the next regen.
		const runtime = PROVIDER_DESCRIPTORS.find(d => d.providerId === "moonshot-cn");
		expect(runtime?.defaultModel).toBe("kimi-k2.7-code");
	});

	test("discovers models against api.moonshot.cn by default", async () => {
		delete Bun.env.MOONSHOT_CN_BASE_URL;
		const calls: string[] = [];
		const options = moonshotCnModelManagerOptions({
			apiKey: "sk-cn",
			fetch: makeFetchMock(calls, ["kimi-k2.7-code"]),
		});
		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain(CN_MODELS_URL);
		expect(models?.[0]).toMatchObject({
			provider: "moonshot-cn",
			baseUrl: "https://api.moonshot.cn/v1",
		});
	});

	test("stamps Kimi reasoning metadata on CN-discovered models without a bundled reference", async () => {
		const calls: string[] = [];
		// kimi-k3 is absent from models.dev and the bundled catalog; the shared
		// Moonshot mapper must still stamp official pricing and max-effort
		// thinking instead of reporting it "Free" (#5756).
		const options = moonshotCnModelManagerOptions({ apiKey: "sk-cn", fetch: makeFetchMock(calls, ["kimi-k3"]) });
		const models = await options.fetchDynamicModels?.();

		const k3 = models?.[0];
		expect(k3?.provider).toBe("moonshot-cn");
		expect(k3?.reasoning).toBe(true);
		expect(k3?.cost.input).toBeGreaterThan(0);
		expect(k3?.thinking).toMatchObject({ requiresEffort: true });
	});

	test("MOONSHOT_CN_BASE_URL redirects discovery; explicit config baseUrl wins", async () => {
		Bun.env.MOONSHOT_CN_BASE_URL = "https://cn-proxy.example/v1";
		const calls: string[] = [];
		const options = moonshotCnModelManagerOptions({ apiKey: "sk-cn", fetch: makeFetchMock(calls, ["kimi-k2.6"]) });
		await options.fetchDynamicModels?.();
		expect(calls).toContain("https://cn-proxy.example/v1/models");

		const overrideCalls: string[] = [];
		const overridden = moonshotCnModelManagerOptions({
			apiKey: "sk-cn",
			baseUrl: "https://explicit.example/v1",
			fetch: makeFetchMock(overrideCalls, ["kimi-k2.6"]),
		});
		await overridden.fetchDynamicModels?.();
		expect(overrideCalls).toContain("https://explicit.example/v1/models");
	});

	test("international moonshot discovery is unaffected by MOONSHOT_CN_BASE_URL", async () => {
		delete Bun.env.MOONSHOT_BASE_URL;
		Bun.env.MOONSHOT_CN_BASE_URL = "https://cn-proxy.example/v1";
		const calls: string[] = [];
		const options = moonshotModelManagerOptions({
			apiKey: "sk-intl",
			fetch: makeFetchMock(calls, ["kimi-k2.7-code"]),
		});
		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("https://api.moonshot.ai/v1/models");
		expect(models?.[0]?.provider).toBe("moonshot");
	});
});
