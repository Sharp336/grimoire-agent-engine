import { describe, expect, it } from "bun:test";
import { toClinepassPublicModelId, toClinepassWireModelId } from "../src/clinepass-model-id";
import { buildOpenAICompat } from "../src/compat/openai";
import { Effort } from "../src/effort";
import { getBundledModels } from "../src/models";
import { buildClinepassSeed, CLINEPASS_STATIC_MODELS } from "../src/provider-models/openai-compat";
import type { ModelSpec } from "../src/types";

/**
 * ClinePass is Cline's flat-rate subscription gateway at `api.cline.bot`. It
 * namespaces every model under a `cline-pass/` wire prefix while the catalog
 * keeps the friendly bare id (`glm-5.2`). The `wireModelIdMode: "clinepass"`
 * compat flag performs the translation at request time.
 *
 * Note: current main no longer has per-family reasoningEffortMap compat
 * identity maps — the GLM xhigh→max / DeepSeek tier collapse moved into the
 * effort lists themselves. These tests verify the resolved compat fields
 * (wireModelIdMode, reasoningContentField, thinkingFormat) and the curated
 * MiMo effort clamp directly.
 */

const CLINEPASS_BASE_URL = "https://api.cline.bot/api/v1";

const baseModel: Omit<ModelSpec<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "glm-5.2",
	name: "GLM 5.2",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32_000,
	contextWindow: 200_000,
	reasoning: true,
};

function clinepassSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return { ...baseModel, provider: "clinepass", baseUrl: CLINEPASS_BASE_URL, ...overrides };
}

// ---------------------------------------------------------------------------
// Wire model id helpers
// ---------------------------------------------------------------------------

describe("toClinepassWireModelId / toClinepassPublicModelId", () => {
	it("prepends the cline-pass/ wire prefix", () => {
		expect(toClinepassWireModelId("glm-5.2")).toBe("cline-pass/glm-5.2");
	});

	it("is idempotent (already-prefixed value unchanged)", () => {
		expect(toClinepassWireModelId("cline-pass/glm-5.2")).toBe("cline-pass/glm-5.2");
	});

	it("strips the wire prefix to recover the public id", () => {
		expect(toClinepassPublicModelId("cline-pass/glm-5.2")).toBe("glm-5.2");
	});

	it("is idempotent on bare ids (no prefix to strip)", () => {
		expect(toClinepassPublicModelId("glm-5.2")).toBe("glm-5.2");
	});
});

// ---------------------------------------------------------------------------
// Compat resolution
// ---------------------------------------------------------------------------

describe("clinepass openai-compat resolution", () => {
	it("sets wireModelIdMode to clinepass", () => {
		expect(buildOpenAICompat(clinepassSpec()).wireModelIdMode).toBe("clinepass");
	});

	it("streams reasoning through the Cline reasoning field", () => {
		expect(buildOpenAICompat(clinepassSpec()).reasoningContentField).toBe("reasoning");
	});

	it("pins openai thinkingFormat for every backend", () => {
		expect(buildOpenAICompat(clinepassSpec()).thinkingFormat).toBe("openai");
	});

	it("pins openai thinkingFormat for Qwen SKUs (not qwen)", () => {
		// Without the gateway a Qwen model would resolve thinkingFormat "qwen";
		// clinepass forces "openai" so the full effort ladder survives.
		const compat = buildOpenAICompat(clinepassSpec({ id: "qwen3.7-max" }));
		expect(compat.thinkingFormat).toBe("openai");
	});

	it("gates on provider id, not host", () => {
		// Same baseUrl but a different provider id must NOT get clinepass treatment.
		const spec: ModelSpec<"openai-completions"> = {
			...baseModel,
			provider: "my-openai-compat",
			baseUrl: CLINEPASS_BASE_URL,
		};
		const compat = buildOpenAICompat(spec);
		expect(compat.wireModelIdMode).not.toBe("clinepass");
		expect(compat.reasoningContentField).toBe("reasoning_content");
	});

	it("clamps the MiMo effort ladder on the wire (minimal→low, xhigh→high)", () => {
		// MiMo accepts only low/medium/high. The resolved compat maps the wider
		// ladder down so a `minimal` or `xhigh` request still lands in-range —
		// this is the wire contract `buildOpenAICompat` produces, not the spec's
		// declared efforts list.
		const compat = buildOpenAICompat(clinepassSpec({ id: "mimo-v2.5", name: "MiMo V2.5" }));
		expect(compat.reasoningEffortMap).toMatchObject({ minimal: "low", xhigh: "high" });
	});
});

// ---------------------------------------------------------------------------
// Generator seed
// ---------------------------------------------------------------------------

describe("buildClinepassSeed", () => {
	it("has 11 models", () => {
		expect(buildClinepassSeed()).toHaveLength(11);
	});

	it("returns fresh copies on each call", () => {
		const a = buildClinepassSeed();
		const b = buildClinepassSeed();
		expect(a).not.toBe(b);
		expect(a[0]).not.toBe(b[0]);
	});

	it("matches CLINEPASS_STATIC_MODELS ids", () => {
		const seed = buildClinepassSeed();
		expect(seed.map(m => m.id)).toEqual(CLINEPASS_STATIC_MODELS.map(m => m.id));
	});

	it("keeps the seed synchronized with the bundled catalog", () => {
		const bundled = getBundledModels("clinepass");
		const seed = buildClinepassSeed();
		expect(bundled.map(m => m.id).sort()).toEqual(seed.map(m => m.id).sort());
	});
});

// ---------------------------------------------------------------------------
// Bundled catalog contents
// ---------------------------------------------------------------------------

const VISION_IDS: Record<string, true> = {
	"kimi-k2.6": true,
	"kimi-k2.7-code": true,
	"kimi-k3": true,
	"mimo-v2.5": true,
	"qwen3.7-plus": true,
};

describe("clinepass bundled catalog", () => {
	it("has 11 model ids", () => {
		expect(getBundledModels("clinepass")).toHaveLength(11);
	});

	it("includes xhigh on every full-ladder model", () => {
		// MiMo and Kimi K3 carry family-specific clamped ladders; every other
		// model exposes the full minimal..xhigh ladder.
		const fullLadder = getBundledModels("clinepass").filter(m => !m.id.startsWith("mimo-") && m.id !== "kimi-k3");
		expect(fullLadder.length).toBeGreaterThan(0);
		for (const model of fullLadder) {
			expect(model.thinking?.efforts).toContain(Effort.XHigh);
		}
	});

	it("caps MiMo models at high (no xhigh)", () => {
		const mimo = getBundledModels("clinepass").filter(m => m.id.startsWith("mimo-"));
		expect(mimo.length).toBe(2);
		for (const model of mimo) {
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
			expect(model.thinking?.efforts).not.toContain(Effort.XHigh);
		}
	});
	it("pins Kimi K3 to the wire-exact low/high/max scale (no xhigh)", () => {
		const byId = new Map(getBundledModels("clinepass").map(m => [m.id, m]));
		expect(byId.get("kimi-k3")?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(byId.get("kimi-k3")?.thinking?.efforts).not.toContain(Effort.XHigh);
	});

	it("declares vision capability on the right SKUs", () => {
		const bundled = getBundledModels("clinepass");
		for (const model of bundled) {
			if (VISION_IDS[model.id]) {
				expect(model.input).toEqual(["text", "image"]);
			} else {
				expect(model.input).toEqual(["text"]);
			}
		}
	});

	it("pins context windows", () => {
		const byId = new Map(getBundledModels("clinepass").map(m => [m.id, m]));
		expect(byId.get("glm-5.2")?.contextWindow).toBe(1_000_000);
		expect(byId.get("kimi-k2.7-code")?.contextWindow).toBe(262_144);
		expect(byId.get("kimi-k2.6")?.contextWindow).toBe(262_144);
		expect(byId.get("kimi-k3")?.contextWindow).toBe(1_048_576);
		expect(byId.get("deepseek-v4-pro")?.contextWindow).toBe(1_000_000);
		expect(byId.get("deepseek-v4-flash")?.contextWindow).toBe(1_000_000);
		expect(byId.get("mimo-v2.5")?.contextWindow).toBe(1_048_576);
		expect(byId.get("mimo-v2.5-pro")?.contextWindow).toBe(1_048_576);
		expect(byId.get("minimax-m3")?.contextWindow).toBe(1_000_000);
		expect(byId.get("qwen3.7-max")?.contextWindow).toBe(1_000_000);
		expect(byId.get("qwen3.7-plus")?.contextWindow).toBe(1_000_000);
	});

	it("gives DeepSeek models a 384K output budget", () => {
		const byId = new Map(getBundledModels("clinepass").map(m => [m.id, m]));
		expect(byId.get("deepseek-v4-pro")?.maxTokens).toBe(384_000);
		expect(byId.get("deepseek-v4-flash")?.maxTokens).toBe(384_000);
	});

	it("suffixes every display name with (ClinePass)", () => {
		for (const model of getBundledModels("clinepass")) {
			expect(model.name).toMatch(/\(ClinePass\)$/);
		}
	});
});
