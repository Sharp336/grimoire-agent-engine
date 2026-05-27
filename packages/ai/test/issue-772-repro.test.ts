import { describe, expect, it } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";

import { xiaomiModelManagerOptions } from "../src/provider-models/openai-compat";
import { loginXiaomi } from "../src/utils/oauth/xiaomi";

const TOKEN_PLAN_CN_HOST = "token-plan-cn.xiaomimimo.com";
const TOKEN_PLAN_SGP_HOST = "token-plan-sgp.xiaomimimo.com";
const TOKEN_PLAN_AMS_HOST = "token-plan-ams.xiaomimimo.com";
const STANDARD_HOST = "api.xiaomimimo.com";

describe("issue-772: Xiaomi MiMo token-plan (tp-) keys", () => {
	it("loginXiaomi validates tp- keys against the CN token-plan host first", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response("{}", { status: 200 });
		});

		await loginXiaomi({
			onAuth: () => {},
			onPrompt: async () => "tp-test-key",
			onProgress: () => {},
		});

		expect(seen).toHaveLength(1);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_CN_HOST);
		expect(url).toContain("/chat/completions");
	});

	it("loginXiaomi falls back across token-plan clusters after 401 responses", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			if (seen.length < 3) {
				return new Response("{}", { status: 401 });
			}
			return new Response("{}", { status: 200 });
		});

		await loginXiaomi({
			onAuth: () => {},
			onPrompt: async () => "tp-test-key",
			onProgress: () => {},
		});

		expect(seen).toHaveLength(3);
		expect(seen[0]).toContain(TOKEN_PLAN_CN_HOST);
		expect(seen[1]).toContain(TOKEN_PLAN_SGP_HOST);
		expect(seen[2]).toContain(TOKEN_PLAN_AMS_HOST);
	});

	it("xiaomiModelManagerOptions discovers models from the CN token-plan host when given a tp- key", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key" });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(TOKEN_PLAN_CN_HOST);
		expect(url).toContain("/v1/models");
	});

	it("xiaomiModelManagerOptions keeps token-plan discovered models on openai-completions transport", async () => {
		using _hook = hookFetch(() => {
			return new Response(JSON.stringify({ data: [{ id: "mimo-v2.5", name: "MiMo-V2.5" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key" });
		const models = await opts.fetchDynamicModels?.();

		expect(models).toHaveLength(1);
		expect(models?.[0]?.id).toBe("mimo-v2.5");
		expect(models?.[0]?.api).toBe("openai-completions");
		expect(models?.[0]?.provider).toBe("xiaomi");
		expect(models?.[0]?.baseUrl).toContain(TOKEN_PLAN_CN_HOST);
	});

	it("xiaomiModelManagerOptions falls back across token-plan clusters after discovery failures", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			if (seen.length < 3) {
				return new Response("{}", { status: 401 });
			}
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "tp-test-key" });
		await opts.fetchDynamicModels?.();

		expect(seen).toHaveLength(3);
		expect(seen[0]).toContain(TOKEN_PLAN_CN_HOST);
		expect(seen[1]).toContain(TOKEN_PLAN_SGP_HOST);
		expect(seen[2]).toContain(TOKEN_PLAN_AMS_HOST);
	});

	for (const baseUrl of [
		"https://api.xiaomimimo.com/v1",
		"https://api.xiaomimimo.com/v1/",
		"https://api.xiaomimimo.com/anthropic",
		"https://api.xiaomimimo.com/anthropic/v1",
	]) {
		it(`xiaomiModelManagerOptions ignores standard baseUrl ${baseUrl} for tp- keys`, async () => {
			const seen: string[] = [];
			using _hook = hookFetch(input => {
				seen.push(String(input));
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			});

			const opts = xiaomiModelManagerOptions({
				apiKey: "tp-test-key",
				baseUrl,
			});
			await opts.fetchDynamicModels?.();

			expect(seen).toHaveLength(1);
			expect(seen[0]).toContain(TOKEN_PLAN_CN_HOST);
			expect(seen[0]).not.toContain(STANDARD_HOST);
		});
	}

	for (const baseUrl of [
		"https://token-plan-cn.xiaomimimo.com/v1",
		"https://token-plan-cn.xiaomimimo.com/anthropic",
		"https://token-plan-cn.xiaomimimo.com/anthropic/v1",
		"https://token-plan-sgp.xiaomimimo.com/v1",
		"https://token-plan-sgp.xiaomimimo.com/anthropic",
		"https://token-plan-sgp.xiaomimimo.com/anthropic/v1",
		"https://token-plan-ams.xiaomimimo.com/v1",
		"https://token-plan-ams.xiaomimimo.com/anthropic",
		"https://token-plan-ams.xiaomimimo.com/anthropic/v1",
	]) {
		it(`xiaomiModelManagerOptions keeps regional fallback for official token-plan baseUrl ${baseUrl}`, async () => {
			const seen: string[] = [];
			using _hook = hookFetch(input => {
				seen.push(String(input));
				if (seen.length < 3) {
					return new Response("{}", { status: 401 });
				}
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			});

			const opts = xiaomiModelManagerOptions({
				apiKey: "tp-test-key",
				baseUrl,
			});
			await opts.fetchDynamicModels?.();

			expect(seen).toHaveLength(3);
			expect(seen[0]).toContain(TOKEN_PLAN_CN_HOST);
			expect(seen[1]).toContain(TOKEN_PLAN_SGP_HOST);
			expect(seen[2]).toContain(TOKEN_PLAN_AMS_HOST);
		});
	}

	it("xiaomiModelManagerOptions honors explicit baseUrl overrides for tp- keys", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({
			apiKey: "tp-test-key",
			baseUrl: "https://proxy.example.com/v1",
		});
		await opts.fetchDynamicModels?.();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("https://proxy.example.com/v1/models");
		expect(seen[0]).not.toContain(TOKEN_PLAN_CN_HOST);
		expect(seen[0]).not.toContain(TOKEN_PLAN_SGP_HOST);
		expect(seen[0]).not.toContain(TOKEN_PLAN_AMS_HOST);
	});

	it("xiaomiModelManagerOptions still uses the standard host for sk- keys", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(input => {
			seen.push(String(input));
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const opts = xiaomiModelManagerOptions({ apiKey: "sk-test-key" });
		await opts.fetchDynamicModels?.();

		expect(seen.length).toBeGreaterThan(0);
		const url = seen[0]!;
		expect(url).toContain(STANDARD_HOST);
		expect(url).not.toContain(TOKEN_PLAN_CN_HOST);
		expect(url).not.toContain(TOKEN_PLAN_SGP_HOST);
		expect(url).not.toContain(TOKEN_PLAN_AMS_HOST);
	});
});
