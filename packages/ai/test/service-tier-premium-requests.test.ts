import { describe, expect, it } from "bun:test";
import type { Api } from "@oh-my-pi/pi-ai/types";
import {
	coerceServiceTierByFamily,
	getPriorityPremiumRequests,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "@oh-my-pi/pi-ai/types";

const m = (
	provider: string,
	api: Api,
	id: string,
	requestModelId?: string,
): { provider: string; api: Api; id: string; requestModelId?: string } => ({
	provider,
	api,
	id,
	...(requestModelId !== undefined ? { requestModelId } : {}),
});

const openai = m("openai", "openai-responses", "gpt-5");
const codex = m("openai-codex", "openai-codex-responses", "gpt-5.5");
const anthropic = m("anthropic", "anthropic-messages", "claude-opus-4-6");
const vertexClaude = m("google-vertex", "anthropic-messages", "claude-opus-4-6");
const gemini = m("google", "google-generative-ai", "gemini-3-flash");
const vertexGemini = m("google-vertex", "google-vertex", "gemini-3-flash");
const fireworks = m("fireworks", "openai-completions", "qwen3");
const fireworksOpenAI = m("fireworks", "openai-completions", "gpt-oss-120b");
const orOpenAI = m("openrouter", "openai-responses", "openai/gpt-5.5");
const orGoogle = m("openrouter", "openai-completions", "google/gemini-3-flash");
const orAnthropic = m("openrouter", "openai-completions", "anthropic/claude-opus-4-6");
const customOpenAI = m("custom-relay", "openai-completions", "gpt-5.5");
const customCodex = m("custom-relay", "openai-codex-responses", "gpt-5.5");
const customOpenAIAliases = [
	m("custom-relay", "openai-responses", "gpt-4o"),
	m("custom-relay", "openai-responses", "o3"),
	m("custom-relay", "openai-responses", "o4-mini"),
	m("custom-relay", "openai-responses", "codex-mini-latest"),
];

const qoder = (api: Api, id: string) => m("qoder", api, id);
const qoderKmodel = qoder("openai-completions", "kmodel");
const qoderKmodelLatest = qoder("openai-completions", "kmodel_latest");
const qoderAuto = qoder("openai-completions", "auto");
const qoderUltimate = qoder("openai-completions", "ultimate");

describe("serviceTierFamily", () => {
	it("classifies first-party providers by provider/api", () => {
		expect(serviceTierFamily(openai)).toBe("openai");
		expect(serviceTierFamily(codex)).toBe("openai");
		expect(serviceTierFamily(anthropic)).toBe("anthropic");
		expect(serviceTierFamily(vertexClaude)).toBe("anthropic"); // Claude on Vertex is the anthropic family
		expect(serviceTierFamily(gemini)).toBe("google");
		expect(serviceTierFamily(vertexGemini)).toBe("google");
		expect(serviceTierFamily(fireworks)).toBeUndefined();
		expect(serviceTierFamily(fireworksOpenAI)).toBeUndefined();
	});

	it("classifies OpenAI-compatible custom providers by api", () => {
		expect(serviceTierFamily(customOpenAI)).toBe("openai");
		expect(serviceTierFamily(customCodex)).toBe("openai");
		for (const model of customOpenAIAliases) {
			expect(serviceTierFamily(model)).toBe("openai");
		}
	});

	it("classifies relay aliases by their wire id, not the local alias id", () => {
		const alias = m("custom-relay", "openai-completions", "my-alias", "gpt-4o");
		expect(serviceTierFamily(alias)).toBe("openai");
		expect(resolveModelServiceTier({ openai: "priority" }, alias)).toBe("priority");
		expect(realizesPriorityServiceTier("priority", alias)).toBe(true);
		// A relay alias whose wire id is not OpenAI-shaped stays unclassified.
		expect(serviceTierFamily(m("custom-relay", "openai-completions", "gpt-4o", "llama-3-70b"))).toBeUndefined();
	});

	it("classifies OpenRouter models by id namespace", () => {
		expect(serviceTierFamily(orOpenAI)).toBe("openai");
		expect(serviceTierFamily(orGoogle)).toBe("google");
		expect(serviceTierFamily(orAnthropic)).toBe("anthropic");
		expect(serviceTierFamily(m("openrouter", "openai-completions", "z-ai/glm-4.7"))).toBeUndefined();
	});

	it("classifies only qoder kmodel as qoder", () => {
		expect(serviceTierFamily(qoderKmodel)).toBe("qoder");
	});

	it("classifies local aliases whose wire id is kmodel as qoder", () => {
		const alias = m("qoder", "openai-completions", "kimi-local", "kmodel");
		expect(serviceTierFamily(alias)).toBe("qoder");
		expect(resolveModelServiceTier({ qoder: "priority" }, alias)).toBe("priority");
		expect(realizesPriorityServiceTier("priority", alias)).toBe(true);
	});

	it("leaves other qoder models unclassified", () => {
		expect(serviceTierFamily(qoderAuto)).toBeUndefined();
		expect(serviceTierFamily(qoderUltimate)).toBeUndefined();
		expect(serviceTierFamily(qoderKmodelLatest)).toBeUndefined();
		// Local id kmodel with a non-kmodel wire id must not classify as qoder.
		expect(serviceTierFamily(m("qoder", "openai-completions", "kmodel", "kmodel_latest"))).toBeUndefined();
	});
});

describe("resolveModelServiceTier", () => {
	it("reduces a per-family map to the model's family entry", () => {
		const tiers = { openai: "priority", anthropic: "priority", google: "flex" } as const;
		expect(resolveModelServiceTier(tiers, openai)).toBe("priority");
		expect(resolveModelServiceTier(tiers, gemini)).toBe("flex");
		expect(resolveModelServiceTier(tiers, orAnthropic)).toBe("priority");
		expect(resolveModelServiceTier(tiers, customCodex)).toBe("priority");
		expect(resolveModelServiceTier(tiers, fireworks)).toBeUndefined(); // no family
		expect(resolveModelServiceTier(tiers, fireworksOpenAI)).toBeUndefined(); // dedicated provider tier
		expect(resolveModelServiceTier(undefined, openai)).toBeUndefined();
		expect(resolveModelServiceTier({ google: "priority" }, openai)).toBeUndefined();
	});

	it("resolves qoder kmodel from the qoder family entry", () => {
		const tiers = { qoder: "priority" } as const;
		expect(resolveModelServiceTier(tiers, qoderKmodel)).toBe("priority");
		expect(resolveModelServiceTier(tiers, qoderAuto)).toBeUndefined();
		expect(resolveModelServiceTier({ openai: "priority" }, qoderKmodel)).toBeUndefined();
	});
});

describe("shouldSendServiceTier", () => {
	it("sends flex/scale/priority on the OpenAI family and OpenRouter", () => {
		for (const p of ["openai", "openai-codex", "openrouter"]) {
			expect(shouldSendServiceTier("flex", p)).toBe(true);
			expect(shouldSendServiceTier("scale", p)).toBe(true);
			expect(shouldSendServiceTier("priority", p)).toBe(true);
			expect(shouldSendServiceTier("default", p)).toBe(false);
			expect(shouldSendServiceTier("auto", p)).toBe(false);
		}
		expect(shouldSendServiceTier("priority", customCodex)).toBe(true);
		expect(shouldSendServiceTier("scale", customOpenAI)).toBe(true);
		expect(shouldSendServiceTier("default", customOpenAI)).toBe(false);
		for (const model of customOpenAIAliases) {
			expect(shouldSendServiceTier("priority", model)).toBe(true);
		}
	});

	it("sends flex/priority on direct Google, priority-only on Vertex (no scale)", () => {
		expect(shouldSendServiceTier("flex", "google")).toBe(true);
		expect(shouldSendServiceTier("priority", "google")).toBe(true);
		expect(shouldSendServiceTier("scale", "google")).toBe(false);
		expect(shouldSendServiceTier("priority", "google-vertex")).toBe(true);
		expect(shouldSendServiceTier("flex", "google-vertex")).toBe(false); // Vertex flex has no wire control
	});

	it("sends only priority on Fireworks, nothing on Anthropic", () => {
		expect(shouldSendServiceTier("priority", "fireworks")).toBe(true);
		expect(shouldSendServiceTier("flex", "fireworks")).toBe(false);
		expect(shouldSendServiceTier("priority", "anthropic")).toBe(false);
	});

	it("never sends an OpenAI service_tier field for qoder", () => {
		for (const tier of ["auto", "default", "flex", "scale", "priority"] as const) {
			expect(shouldSendServiceTier(tier, qoderKmodel)).toBe(false);
			expect(shouldSendServiceTier(tier, "qoder")).toBe(false);
		}
	});

	it("returns false for unset tiers", () => {
		expect(shouldSendServiceTier(undefined, "openai")).toBe(false);
		expect(shouldSendServiceTier(null, "openai")).toBe(false);
	});
});

describe("realizesPriorityServiceTier", () => {
	it("realizes priority where the wire actually applies it", () => {
		expect(realizesPriorityServiceTier("priority", openai)).toBe(true);
		expect(realizesPriorityServiceTier("priority", anthropic)).toBe(true); // direct fast mode
		expect(realizesPriorityServiceTier("priority", gemini)).toBe(true);
		expect(realizesPriorityServiceTier("priority", vertexGemini)).toBe(true);
		expect(realizesPriorityServiceTier("priority", fireworks)).toBe(true);
		expect(realizesPriorityServiceTier("priority", orOpenAI)).toBe(true);
		expect(realizesPriorityServiceTier("priority", orGoogle)).toBe(true);
		expect(realizesPriorityServiceTier("priority", customCodex)).toBe(true);
		for (const model of customOpenAIAliases) {
			expect(realizesPriorityServiceTier("priority", model)).toBe(true);
		}
	});

	it("does not realize priority where the wire drops it", () => {
		expect(realizesPriorityServiceTier("priority", vertexClaude)).toBe(false); // no fast mode on Vertex
		expect(realizesPriorityServiceTier("priority", orAnthropic)).toBe(false); // OpenRouter Anthropic
		expect(realizesPriorityServiceTier("flex", openai)).toBe(false);
		expect(realizesPriorityServiceTier(undefined, openai)).toBe(false);
	});

	it("realizes priority only for qoder kmodel", () => {
		expect(realizesPriorityServiceTier("priority", qoderKmodel)).toBe(true);
		expect(realizesPriorityServiceTier("priority", qoderKmodelLatest)).toBe(false);
		expect(realizesPriorityServiceTier("priority", qoderAuto)).toBe(false);
		expect(realizesPriorityServiceTier("priority", qoderUltimate)).toBe(false);
		expect(realizesPriorityServiceTier("flex", qoderKmodel)).toBe(false);
	});
});

describe("getPriorityPremiumRequests", () => {
	it("counts one premium request per realized priority on billing providers", () => {
		expect(getPriorityPremiumRequests("priority", openai)).toBe(1);
		expect(getPriorityPremiumRequests("priority", codex)).toBe(1);
		expect(getPriorityPremiumRequests("priority", anthropic)).toBe(1);
		expect(getPriorityPremiumRequests("priority", gemini)).toBe(1);
		expect(getPriorityPremiumRequests("priority", vertexGemini)).toBe(1);
	});

	it("does not bill OpenRouter, unrealized, or non-priority traffic", () => {
		expect(getPriorityPremiumRequests("priority", orOpenAI)).toBe(0); // OpenRouter bills its own way
		expect(getPriorityPremiumRequests("priority", vertexClaude)).toBe(0); // not realized
		expect(getPriorityPremiumRequests("priority", fireworks)).toBe(0); // realized but not Copilot-premium
		expect(getPriorityPremiumRequests("priority", fireworksOpenAI)).toBe(0); // dedicated provider tier
		expect(getPriorityPremiumRequests("flex", openai)).toBe(0);
		expect(getPriorityPremiumRequests(undefined, openai)).toBe(0);
		expect(getPriorityPremiumRequests("priority", qoderKmodel)).toBe(0); // Qoder priority is realized but not billed as premium
	});
});

describe("coerceServiceTierByFamily", () => {
	it("migrates legacy scalar values to a per-family map", () => {
		expect(coerceServiceTierByFamily("priority")).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
			qoder: "priority",
		});
		expect(coerceServiceTierByFamily("openai-only")).toEqual({ openai: "priority" });
		expect(coerceServiceTierByFamily("claude-only")).toEqual({ anthropic: "priority" });
		expect(coerceServiceTierByFamily("flex")).toEqual({ openai: "flex" });
		expect(coerceServiceTierByFamily("none")).toBeUndefined();
		expect(coerceServiceTierByFamily(null)).toBeUndefined();
	});

	it("passes a per-family map through, dropping invalid entries", () => {
		expect(coerceServiceTierByFamily({ openai: "priority", google: "flex" })).toEqual({
			openai: "priority",
			google: "flex",
		});
		expect(coerceServiceTierByFamily({ openai: "bogus" })).toBeUndefined();
		expect(coerceServiceTierByFamily({ qoder: "priority", openai: "priority" })).toEqual({
			qoder: "priority",
			openai: "priority",
		});
		expect(coerceServiceTierByFamily({ qoder: "bogus" })).toBeUndefined();
	});
});
