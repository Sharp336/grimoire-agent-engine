import { describe, expect, it } from "bun:test";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getModelSeries } from "../../src/config/model-equivalence";
import type { SessionEntry } from "../../src/session/session-manager";
import {
	buildTranscript,
	clampEffort,
	decodeFingerprint,
	encodeFingerprint,
	parseVerdict,
	type ReviewerSource,
	renderEntry,
	resolveDefaultReviewer,
	shouldShowPicker,
	textFromContent,
} from "../../src/tools/second-opinion";

function model(partial: { provider: string; id: string; reasoning?: boolean; levels?: readonly Effort[] }): Model<Api> {
	return {
		provider: partial.provider,
		id: partial.id,
		name: partial.id,
		api: "anthropic-messages",
		reasoning: partial.reasoning ?? false,
		thinking: partial.levels
			? { minLevel: partial.levels[0], maxLevel: partial.levels[partial.levels.length - 1], levels: partial.levels }
			: undefined,
	} as unknown as Model<Api>;
}

function messageEntry(role: string, content: unknown, toolName?: string): SessionEntry {
	return {
		type: "message",
		id: "x",
		parentId: null,
		timestamp: "0",
		message: { role, content, toolName },
	} as unknown as SessionEntry;
}

// Deterministic family: leading token before the first hyphen.
const familyOf = (m: Model<Api>): string => m.id.split("-")[0];

describe("getModelSeries", () => {
	it("is version-insensitive within a vendor lineage", () => {
		expect(getModelSeries("anthropic/claude-opus-4.7")).toBe("claude");
		expect(getModelSeries("claude-opus-4.8")).toBe("claude");
		expect(getModelSeries("openai/gpt-5.2")).toBe("gpt");
		expect(getModelSeries("gpt-5.1-codex")).toBe("gpt");
	});

	it("folds near-equivalent series and o-series onto their lineage", () => {
		expect(getModelSeries("google/gemini-3-pro")).toBe("gemini");
		expect(getModelSeries("gemma-3-27b")).toBe("gemini");
		expect(getModelSeries("openai/o3-mini")).toBe("gpt");
		expect(getModelSeries("magistral-small")).toBe("mistral");
	});

	it("distinguishes different vendors and returns undefined for unknown series", () => {
		expect(getModelSeries("xai/grok-4")).toBe("grok");
		expect(getModelSeries("deepseek/deepseek-v3")).toBe("deepseek");
		expect(getModelSeries("claude-opus-4.7")).not.toBe(getModelSeries("openai/gpt-5.2"));
		expect(getModelSeries("acme/widget-1")).toBeUndefined();
	});
});

describe("second_opinion shouldShowPicker", () => {
	const fp = { sessionFamily: "claude", slowFamily: "claude", confirmedReviewer: "openai/gpt-5.2" };

	it("fires on first run (no fingerprint)", () => {
		expect(shouldShowPicker({ fingerprint: undefined, sessionFamily: "claude", slowFamily: "claude" })).toBe(true);
	});

	it("stays quiet when families are unchanged", () => {
		expect(shouldShowPicker({ fingerprint: fp, sessionFamily: "claude", slowFamily: "claude" })).toBe(false);
	});

	it("fires when the session family changed", () => {
		expect(shouldShowPicker({ fingerprint: fp, sessionFamily: "gpt", slowFamily: "claude" })).toBe(true);
	});

	it("fires when the slow family changed", () => {
		expect(shouldShowPicker({ fingerprint: fp, sessionFamily: "claude", slowFamily: "gpt" })).toBe(true);
	});
});

describe("second_opinion resolveDefaultReviewer", () => {
	const claudeSession = model({ provider: "anthropic", id: "claude-opus" });
	const gptSlow = model({ provider: "openai", id: "gpt-5" });
	const claudeSlow = model({ provider: "anthropic", id: "claude-sonnet" });
	const gemini = model({ provider: "google", id: "gemini-3" });

	function pick(
		args: Parameters<typeof resolveDefaultReviewer>[0],
	): [Model<Api> | undefined, ReviewerSource | undefined] {
		const r = resolveDefaultReviewer(args);
		return [r?.model, r?.source];
	}

	it("prefers a configured reviewer", () => {
		const [m, source] = pick({
			configuredModel: gemini,
			slowModel: gptSlow,
			sessionModel: claudeSession,
			available: [gemini, gptSlow],
			familyOf,
		});
		expect(m).toBe(gemini);
		expect(source).toBe("configured");
	});

	it("uses slow when it is cross-family with the session", () => {
		const [m, source] = pick({
			configuredModel: undefined,
			slowModel: gptSlow,
			sessionModel: claudeSession,
			available: [gptSlow, claudeSlow],
			familyOf,
		});
		expect(m).toBe(gptSlow);
		expect(source).toBe("slow");
	});

	it("avoids a same-family slow by picking an available cross-family model", () => {
		const [m, source] = pick({
			configuredModel: undefined,
			slowModel: claudeSlow,
			sessionModel: claudeSession,
			available: [claudeSlow, gemini],
			familyOf,
		});
		expect(m).toBe(gemini);
		expect(source).toBe("fallback");
	});

	it("skips a same-family first available model when no slow model is configured", () => {
		const [m, source] = pick({
			configuredModel: undefined,
			slowModel: undefined,
			sessionModel: claudeSession,
			available: [claudeSlow, gemini],
			familyOf,
		});
		expect(m).toBe(gemini);
		expect(source).toBe("fallback");
	});

	it("falls back to the first available model after exhausting cross-family candidates", () => {
		const [m, source] = pick({
			configuredModel: undefined,
			slowModel: undefined,
			sessionModel: claudeSession,
			available: [claudeSlow],
			familyOf,
		});
		expect(m).toBe(claudeSlow);
		expect(source).toBe("fallback");
	});

	it("falls back to slow when no cross-family model is available", () => {
		const [m, source] = pick({
			configuredModel: undefined,
			slowModel: claudeSlow,
			sessionModel: claudeSession,
			available: [claudeSlow],
			familyOf,
		});
		expect(m).toBe(claudeSlow);
		expect(source).toBe("slow");
	});

	it("returns undefined when nothing is available and no slow exists", () => {
		expect(
			resolveDefaultReviewer({
				configuredModel: undefined,
				slowModel: undefined,
				sessionModel: claudeSession,
				available: [],
				familyOf,
			}),
		).toBeUndefined();
	});
});

describe("second_opinion fingerprint codec", () => {
	it("round-trips and tolerates malformed input", () => {
		const fp = { sessionFamily: "claude", slowFamily: "gpt", confirmedReviewer: "openai/gpt-5.2" };
		expect(decodeFingerprint(encodeFingerprint(fp))).toEqual(fp);
		expect(decodeFingerprint(undefined)).toBeUndefined();
		expect(decodeFingerprint("not json")).toBeUndefined();
		expect(decodeFingerprint("{}")).toEqual({ sessionFamily: null, slowFamily: null, confirmedReviewer: null });
	});
});

describe("second_opinion parseVerdict", () => {
	const assistant = (content: unknown[]) => ({ role: "assistant", content }) as never;

	it("reads the forced tool call", () => {
		const r = parseVerdict(
			assistant([
				{ type: "toolCall", name: "submit_review", arguments: { verdict: "FLAWED", review: "off-by-one in loop" } },
			]),
		);
		expect(r).toEqual({ verdict: "FLAWED", review: "off-by-one in loop", structured: true });
	});

	it("ignores extra fields in tool-call arguments", () => {
		const r = parseVerdict(
			assistant([
				{
					type: "toolCall",
					name: "submit_review",
					arguments: { verdict: "SOUND", review: "usable", reasoning: "extra", confidence: 0.8 },
				},
			]),
		);
		expect(r).toEqual({ verdict: "SOUND", review: "usable", structured: true });
	});

	it("falls back to a JSON payload in the text", () => {
		const r = parseVerdict(assistant([{ type: "text", text: '{"verdict":"SOUND","review":"looks fine"}' }]));
		expect(r.verdict).toBe("SOUND");
		expect(r.structured).toBe(true);
	});

	it("scans prose for a verdict when unstructured", () => {
		const r = parseVerdict(
			assistant([{ type: "text", text: "Overall this is SOUND-WITH-CAVEATS: watch the retry path." }]),
		);
		expect(r.verdict).toBe("SOUND_WITH_CAVEATS");
		expect(r.structured).toBe(false);
		expect(r.review).toContain("retry path");
	});
});

describe("second_opinion clampEffort", () => {
	it("returns undefined for off or non-reasoning models", () => {
		const reasoner = model({
			provider: "anthropic",
			id: "claude",
			reasoning: true,
			levels: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(clampEffort(reasoner, "off")).toBeUndefined();
		expect(clampEffort(model({ provider: "anthropic", id: "haiku", reasoning: false }), "high")).toBeUndefined();
	});

	it("passes through supported effort and clamps when exceeded", () => {
		const full = model({
			provider: "anthropic",
			id: "claude",
			reasoning: true,
			levels: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(clampEffort(full, "high")).toBe(Effort.High);
		const capped = model({
			provider: "anthropic",
			id: "claude",
			reasoning: true,
			levels: [Effort.Low, Effort.Medium],
		});
		expect(clampEffort(capped, "high")).toBe(Effort.Medium);
	});
});

describe("second_opinion transcript rendering", () => {
	it("renders turns, skips empties, truncates tool results", () => {
		const { text, count } = buildTranscript([messageEntry("user", "hello"), messageEntry("assistant", "hi back")]);
		expect(count).toBe(2);
		expect(text).toContain("## USER\nhello");
		expect(renderEntry(messageEntry("assistant", "   "))).toBeNull();
		const big = "x".repeat(600);
		const rendered = renderEntry(messageEntry("toolResult", big, "search"));
		expect(rendered?.role).toBe("tool");
		expect(rendered?.text).toContain("…[truncated]");
	});

	it("marks tool calls and drops thinking blocks", () => {
		expect(
			textFromContent([
				{ type: "text", text: "plan" },
				{ type: "thinking", text: "secret" },
				{ type: "toolCall", name: "read" },
			]),
		).toBe("plan\n[tool call: read]");
	});

	it("honors lookback by keeping only the newest N turns", () => {
		const { text, count } = buildTranscript(
			[messageEntry("user", "one"), messageEntry("assistant", "two"), messageEntry("user", "three")],
			2,
		);
		expect(count).toBe(2);
		expect(text).not.toContain("one");
		expect(text).toContain("three");
	});
});
