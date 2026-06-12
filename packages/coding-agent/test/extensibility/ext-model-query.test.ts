import { describe, expect, test } from "bun:test";
import {
	type Api,
	type AssistantMessage,
	type Context,
	Effort,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionModelQuery } from "../../src/extensibility/extensions/model-api";

function model(id: string, name: string, provider: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const claude = model("claude-opus-4-8", "Claude Opus 4.8", "anthropic");
const claudePrev = model("claude-opus-4-7", "Claude Opus 4.7", "anthropic");
const gpt = model("gpt-5.4", "GPT-5.4", "openai");

const available = [claude, gpt] as Model<Api>[];
const apiKeyResolver = async () => "test-key";

/** Minimal registry stub: only the methods the facade and core resolver touch. */
function registry(getApiKey: () => Promise<string | undefined> = async () => "test-key"): ModelRegistry {
	return {
		getAvailable: () => available,
		getCanonicalId: (m: Model<Api>) => m.id,
		getApiKey,
		resolver: () => apiKeyResolver,
	} as unknown as ModelRegistry;
}

describe("createExtensionModelQuery", () => {
	test("list() and current() pass through to the registry and session model", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => gpt);
		expect(q.list()).toEqual(available);
		expect(q.current()).toBe(gpt);
	});

	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), undefined, () => active);
		expect(q.current()).toBe(claude);
		active = gpt;
		expect(q.current()).toBe(gpt);
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.resolve("anthropic/claude-opus-4-8")).toBe(claude);
		expect(q.resolve("gpt-5.4")?.provider).toBe("openai");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("resolve() honors configured role aliases via the same settings-backed path as core", () => {
		const settings = {
			getModelRole: (role: string) => (role === "slow" ? "anthropic/claude-opus-4-8" : undefined),
			get: () => undefined,
		} as unknown as Settings;
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.resolve("pi/slow")).toBe(claude);
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.family(claude)).toBe(q.family(claudePrev));
		expect(q.family(claude)).not.toBe(q.family(gpt));
	});

	test("family() folds an opaque proxy id onto its canonical lineage", () => {
		// "proxy-xyz-1" classifies to no family on its own; canonical resolution maps it
		// onto claude-opus-4-8, so it must group with Claude rather than its own provider.
		const proxy = model("proxy-xyz-1", "Proxy Claude", "someproxy") as Model<Api>;
		const reg = {
			getAvailable: () => available,
			getCanonicalId: (m: Model<Api>) => (m === proxy ? "claude-opus-4-8" : m.id),
		} as unknown as ModelRegistry;
		const q = createExtensionModelQuery(reg, undefined, () => undefined);
		expect(q.family(proxy)).toBe(q.family(claude));
	});

	test("list() and resolve() honor the session enabledModels allow-list", () => {
		const settings = {
			get: (key: string) => (key === "enabledModels" ? ["anthropic/*"] : undefined),
			getModelRole: () => undefined,
		} as unknown as Settings;
		const reg = {
			getAvailable: () => available,
			getCanonicalId: (m: Model<Api>) => m.id,
			getCanonicalVariants: () => [],
		} as unknown as ModelRegistry;
		const q = createExtensionModelQuery(reg, settings, () => undefined);
		// gpt is authenticated but outside the anthropic-only scope: hidden + unresolvable.
		expect(q.list()).toEqual([claude]);
		expect(q.resolve("gpt-5.4")).toBeUndefined();
		expect(q.resolve("anthropic/claude-opus-4-8")).toBe(claude);
		// An explicit session model outside the scope (e.g. a `--model` override, which
		// core honors over enabledModels) stays listable and resolvable.
		const qOverride = createExtensionModelQuery(reg, settings, () => gpt);
		expect(qOverride.list()).toContain(gpt);
		expect(qOverride.resolve("openai/gpt-5.4")).toBe(gpt);
	});
});

const request = {
	systemPrompt: ["review this"],
	messages: [{ role: "user", content: [{ type: "text", text: "transcript" }], timestamp: 0 }],
	tools: [],
} as unknown as Context;

const reply = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	stopReason: "end_turn",
} as unknown as AssistantMessage;

describe("createExtensionModelQuery.complete", () => {
	function spy() {
		const calls: { model: Model<Api>; ctx: Context; options: SimpleStreamOptions }[] = [];
		const completeImpl = async (
			model: Model<Api>,
			ctx: Context,
			options: SimpleStreamOptions,
		): Promise<AssistantMessage> => {
			calls.push({ model, ctx, options });
			return reply;
		};
		return { calls, completeImpl };
	}

	test("resolves a string spec, passes the registry resolver, and runs the caller's own context", async () => {
		const { calls, completeImpl } = spy();
		const ac = new AbortController();
		const q = createExtensionModelQuery(registry(), undefined, () => undefined, { completeImpl });
		const out = await q.complete("anthropic/claude-opus-4-8", request, {
			effort: Effort.High,
			signal: ac.signal,
			toolChoice: { type: "tool", name: "submit" },
		});
		expect(out).toBe(reply);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.model).toBe(claude);
		expect(calls[0]?.ctx).toBe(request); // its OWN context — never the session transcript
		// The registry resolver (not a pre-resolved string) is forwarded so streamSimple can rotate credentials.
		expect(calls[0]?.options.apiKey).toBe(apiKeyResolver);
		expect(calls[0]?.options.signal).toBe(ac.signal);
		expect(calls[0]?.options.reasoning).toBe(Effort.High);
		expect(calls[0]?.options.toolChoice).toEqual({ type: "tool", name: "submit" });
	});

	test("accepts a resolved Model directly", async () => {
		const { calls, completeImpl } = spy();
		const q = createExtensionModelQuery(registry(), undefined, () => undefined, { completeImpl });
		await q.complete(gpt, request);
		expect(calls[0]?.model).toBe(gpt);
	});

	test("rejects when a string spec resolves to nothing", async () => {
		const { completeImpl } = spy();
		const q = createExtensionModelQuery(registry(), undefined, () => undefined, { completeImpl });
		await expect(q.complete("nope/nope", request)).rejects.toThrow(/no model matches/);
	});

	test("rejects when no API key is available for the model", async () => {
		const { completeImpl } = spy();
		const q = createExtensionModelQuery(
			registry(async () => undefined),
			undefined,
			() => undefined,
			{ completeImpl },
		);
		await expect(q.complete(gpt, request)).rejects.toThrow(/no API key/);
	});

	test("threads the session id into both the key guard and the resolver", async () => {
		const seen: { guard?: string; resolver?: string } = {};
		const reg = {
			getAvailable: () => available,
			getCanonicalId: (m: Model<Api>) => m.id,
			getApiKey: async (_m: Model<Api>, sid?: string) => {
				seen.guard = sid;
				return "k";
			},
			resolver: (_m: Model<Api>, sid?: string) => {
				seen.resolver = sid;
				return apiKeyResolver;
			},
		} as unknown as ModelRegistry;
		const { completeImpl } = spy();
		const q = createExtensionModelQuery(reg, undefined, () => undefined, {
			completeImpl,
			getSessionId: () => "sess-123",
		});
		await q.complete(gpt, request);
		expect(seen.guard).toBe("sess-123");
		expect(seen.resolver).toBe("sess-123");
	});

	test("applies prepareSideRequest: obfuscated context goes out, reply is finalized", async () => {
		const { calls, completeImpl } = spy();
		const obfCtx = { ...request, marker: "obfuscated" } as unknown as Context;
		const finalReply = { ...reply, content: [{ type: "text", text: "deobfuscated" }] } as unknown as AssistantMessage;
		const q = createExtensionModelQuery(registry(), undefined, () => undefined, {
			completeImpl,
			prepareSideRequest: (_model, _context, options) => ({ context: obfCtx, options, finalize: () => finalReply }),
		});
		const out = await q.complete(gpt, request);
		// The prepared (obfuscated) context reached the provider, not the caller's raw one.
		expect(calls[0]?.ctx).toBe(obfCtx);
		// The reply was finalized (deobfuscated) before returning to the extension.
		expect(out).toBe(finalReply);
	});

	test("rejects a directly-passed Model outside the enabledModels scope", async () => {
		const settings = {
			get: (key: string) => (key === "enabledModels" ? ["anthropic/*"] : undefined),
			getModelRole: () => undefined,
		} as unknown as Settings;
		const reg = {
			getAvailable: () => available,
			getCanonicalId: (m: Model<Api>) => m.id,
			getCanonicalVariants: () => [],
			getApiKey: async () => "k",
			resolver: () => apiKeyResolver,
		} as unknown as ModelRegistry;
		const { completeImpl } = spy();
		const q = createExtensionModelQuery(reg, settings, () => undefined, { completeImpl });
		// gpt (openai) is authenticated but outside the anthropic-only scope.
		await expect(q.complete(gpt, request)).rejects.toThrow(/enabledModels scope/);
		// an in-scope model still completes.
		await expect(q.complete(claude, request)).resolves.toBe(reply);
	});
});
