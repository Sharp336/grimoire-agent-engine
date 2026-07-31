import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { isUnsupportedKwarg } from "@oh-my-pi/pi-ai/error/flags";
import {
	type KwargRetryLadder,
	type KwargStripRung,
	nextKwargStripRung,
	UNSUPPORTED_KWARG_NAME_PATTERN,
} from "@oh-my-pi/pi-ai/utils/kwarg-retry-ladder";

type Params = {
	temperature?: number;
	thinking?: { budget_tokens: number };
	output_config?: { effort: string };
	tool_choice?: { type: "auto" | "any" | "tool" };
};

const ladder: KwargRetryLadder<Params> = [
	{
		id: "output_config",
		matchers: [/\boutput_config\b/i, /\beffort\b/i],
		strip: p => {
			delete p.output_config;
		},
	},
	{
		id: "thinking",
		matchers: [/\bthinking\b/i, /\bbudget_tokens\b/i],
		strip: p => {
			delete p.thinking;
		},
	},
	{
		id: "temperature",
		matchers: [/\btemperature\b/i],
		strip: p => {
			delete p.temperature;
		},
	},
	{
		id: "tool_choice_required",
		matchers: [/tool_choice.*(?:required|is not compatible)/i],
		strip: p => {
			if (p.tool_choice && (p.tool_choice.type === "any" || p.tool_choice.type === "tool")) {
				p.tool_choice = { type: "auto" };
			}
		},
	},
];

describe("nextKwargStripRung", () => {
	it("returns the rung whose matcher hits the error text", () => {
		const rung = nextKwargStripRung("400 temperature is not supported", ladder, new Set());
		expect(rung?.id).toBe("temperature");
	});

	it("respects ladder ordering: a message naming both thinking and temperature selects thinking first", () => {
		const rung = nextKwargStripRung("thinking and temperature are not supported", ladder, new Set());
		expect(rung?.id).toBe("thinking");
	});

	it("skips already-applied rungs and advances to the next match", () => {
		const applied = new Set(["thinking"]);
		const rung = nextKwargStripRung("thinking and temperature are not supported", ladder, applied);
		expect(rung?.id).toBe("temperature");
	});

	it("returns undefined when no remaining rung matches", () => {
		const rung = nextKwargStripRung("context window exceeded", ladder, new Set());
		expect(rung).toBeUndefined();
	});

	it("returns undefined when all matching rungs have been applied (ladder exhausted)", () => {
		const applied = new Set(["thinking", "temperature"]);
		const rung = nextKwargStripRung("thinking and temperature are not supported", ladder, applied);
		expect(rung).toBeUndefined();
	});

	it("matchers are case-insensitive (Temperature matches, temp does not)", () => {
		expect(nextKwargStripRung("400 Temperature is not supported", ladder, new Set())?.id).toBe("temperature");
		expect(nextKwargStripRung("400 temp is not supported", ladder, new Set())).toBeUndefined();
	});

	it("strip is idempotent: applying a rung twice is a no-op on the second pass", () => {
		const rung = nextKwargStripRung("400 temperature is not supported", ladder, new Set()) as KwargStripRung<Params>;
		const params: Params = { temperature: 0.7, thinking: { budget_tokens: 1024 } };
		rung.strip(params);
		expect(params.temperature).toBeUndefined();
		rung.strip(params);
		expect(params.temperature).toBeUndefined();
		expect(params.thinking).toEqual({ budget_tokens: 1024 });
	});

	it("tool_choice rung downgrades forced choice to auto instead of deleting", () => {
		const rung = ladder.find(r => r.id === "tool_choice_required") as KwargStripRung<Params>;
		const params: Params = { tool_choice: { type: "any" } };
		rung.strip(params);
		expect(params.tool_choice).toEqual({ type: "auto" });
	});
});

describe("UNSUPPORTED_KWARG_NAME_PATTERN", () => {
	it("matches known strippable wire keys", () => {
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("temperature is not supported")).toBe(true);
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("output_config is not supported")).toBe(true);
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("thinking is not supported")).toBe(true);
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("tool_choice is not compatible")).toBe(true);
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("reasoning_effort is not supported")).toBe(true);
	});

	it("does not match a prefix like 'temp' for 'temperature'", () => {
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("temp is not supported")).toBe(false);
	});

	it("does not match non-kwarg 400 text", () => {
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("prompt is too long")).toBe(false);
		expect(UNSUPPORTED_KWARG_NAME_PATTERN.test("compiled grammar too large")).toBe(false);
	});
});

describe("isUnsupportedKwarg classifier", () => {
	it("classifies a 400 invalid_request_error naming temperature as UnsupportedKwarg", () => {
		const error = new ProviderHttpError(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"temperature is not supported when thinking is enabled"}}',
			400,
			{ code: "invalid_request_error" },
		);
		expect(isUnsupportedKwarg(error)).toBe(true);
	});

	it("classifies a 400 naming output_config with an unsupported-parameter envelope", () => {
		const error = new ProviderHttpError('400 {"detail":"Unsupported parameter: output_config"}', 400);
		expect(isUnsupportedKwarg(error)).toBe(true);
	});

	it("classifies a 400 naming thinking with an extra-inputs envelope", () => {
		const error = new ProviderHttpError(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking is not supported by this model"}}',
			400,
			{ code: "invalid_request_error" },
		);
		expect(isUnsupportedKwarg(error)).toBe(true);
	});

	it("does not classify a context-overflow 400 as UnsupportedKwarg", () => {
		const error = new ProviderHttpError("400 prompt is too long", 400);
		expect(isUnsupportedKwarg(error)).toBe(false);
	});

	it("does not classify a 401 as UnsupportedKwarg", () => {
		const error = new ProviderHttpError("401 Unauthorized", 401);
		expect(isUnsupportedKwarg(error)).toBe(false);
	});

	it("does not classify a 429 as UnsupportedKwarg", () => {
		const error = new ProviderHttpError(
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"temperature too many requests"}}',
			429,
			{ code: "rate_limit_error" },
		);
		expect(isUnsupportedKwarg(error)).toBe(false);
	});

	it("does not classify a 400 that names no strippable kwarg", () => {
		const error = new ProviderHttpError(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages must be non-empty"}}',
			400,
			{ code: "invalid_request_error" },
		);
		expect(isUnsupportedKwarg(error)).toBe(false);
	});
});
