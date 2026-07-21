import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { ToolCall, TSchema } from "@oh-my-pi/pi-ai";
import {
	adaptSchemaForStrict,
	toolWireSchema,
	validateJsonSchemaValue,
	validateStrictSchemaEnforcement,
} from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { type BrowserParams, BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}
describe("browser tool schema", () => {
	it("rejects run calls without code during execution", async () => {
		const tool = new BrowserTool(makeSession());
		const args: BrowserParams = { action: "run", name: "x" };
		const call: ToolCall = {
			type: "toolCall",
			id: "browser-run-without-code",
			name: "browser",
			arguments: args,
		};

		expect(validateJsonSchemaValue(toolWireSchema(tool), call.arguments).success).toBe(true);
		expect(validateToolCall([tool], call)).toEqual(call.arguments);
		await expect(tool.execute("browser-run-without-code", args)).rejects.toThrow(
			/Missing required parameter 'code' for action 'run'/,
		);
	});

	it("accepts run calls with code at schema validation", () => {
		const tool = new BrowserTool(makeSession());
		const call: ToolCall = {
			type: "toolCall",
			id: "browser-run-with-code",
			name: "browser",
			arguments: { action: "run", name: "x", code: "return document.title;" },
		};

		expect(validateJsonSchemaValue(toolWireSchema(tool), call.arguments).success).toBe(true);
		expect(validateToolCall([tool], call)).toEqual(call.arguments);
	});

	// Reproduces the regression the Codex review flagged on #3647: with default
	// `tools.intentTracing`, normalizeTools must keep the closed action variants
	// satisfiable for inputs that carry the injected `i` field. The earlier
	// version of injectIntentIntoSchema appended a root sibling
	// `properties: { i }, required: [i]` next to the closed `anyOf` branches,
	// which collided with each branch's `additionalProperties: false` and made
	// every input fail validation.
	it("keeps intent tracing satisfiable across action variants", () => {
		const normalized = normalizeTools([new BrowserTool(makeSession())], true)?.[0];
		const schema = normalized?.parameters as TSchema;

		expect(validateJsonSchemaValue(schema, { action: "run", name: "x" }).success).toBe(false);
		expect(
			validateJsonSchemaValue(schema, {
				[INTENT_FIELD]: "Inspecting page state",
				action: "run",
				name: "x",
				code: "return document.title;",
			}).success,
		).toBe(true);
		expect(
			validateJsonSchemaValue(schema, {
				[INTENT_FIELD]: "Opening docs tab",
				action: "open",
				name: "docs",
				url: "https://example.com",
			}).success,
		).toBe(true);
	});

	// Each branch is closed (`additionalProperties: false`) and intent
	// injection now lands inside every branch's `properties`/`required`, so
	// `enforceStrictSchema` keeps strict mode on and the result remains free of
	// strict-mode violations. Without the union-aware injection fix, the
	// post-injection schema would either lose strict (no satisfiable input) or
	// trip the additionalProperties / properties-coverage strict rules.
	it("survives OpenAI strict-mode enforcement after intent injection", () => {
		const normalized = normalizeTools([new BrowserTool(makeSession())], true)?.[0];
		const schema = normalized?.parameters as Record<string, unknown>;
		const strict = adaptSchemaForStrict(schema, true);

		expect(strict.strict).toBe(true);
		const enforcement = validateStrictSchemaEnforcement(schema, strict);
		expect(enforcement.compatible).toBe(true);
		expect(enforcement.violations).toEqual([]);

		// And the post-strict schema is still satisfiable for a real run call.
		expect(
			validateJsonSchemaValue(strict.schema, {
				[INTENT_FIELD]: "Reading page DOM",
				action: "run",
				name: "docs",
				url: null,
				app: null,
				viewport: null,
				wait_until: null,
				dialogs: null,
				code: "return 1;",
				domains: null,
				timeout: null,
				all: null,
				kill: null,
			}).success,
		).toBe(true);
	});

	// INV-579 Task 4: the two recording actions join the closed action enum. The
	// object stays closed (additionalProperties: false), so unknown fields and
	// unknown actions are rejected while both recording variants validate.
	it("accepts the recording actions and rejects unknown actions or fields", () => {
		const tool = new BrowserTool(makeSession());
		const wire = toolWireSchema(tool);
		expect(
			validateJsonSchemaValue(wire, {
				action: "start_recording",
				name: "docs",
				domains: ["https://example.com"],
			}).success,
		).toBe(true);
		expect(validateJsonSchemaValue(wire, { action: "stop_recording", name: "docs" }).success).toBe(true);
		expect(validateJsonSchemaValue(wire, { action: "pause_recording", name: "docs" }).success).toBe(false);
		expect(validateJsonSchemaValue(wire, { action: "start_recording", bogus: 1 }).success).toBe(false);
	});

	// Intent injection must keep both recording variants satisfiable, and the
	// OpenAI strict-mode adaptation must stay compatible with the extended enum
	// and the new `domains` field.
	it("keeps the recording actions satisfiable under intent tracing and strict-mode enforcement", () => {
		const normalized = normalizeTools([new BrowserTool(makeSession())], true)?.[0];
		const schema = normalized?.parameters as Record<string, unknown>;

		expect(
			validateJsonSchemaValue(schema as TSchema, {
				[INTENT_FIELD]: "Recording checkout traffic",
				action: "start_recording",
				name: "docs",
				domains: ["https://shop.example"],
			}).success,
		).toBe(true);

		const strict = adaptSchemaForStrict(schema, true);
		expect(strict.strict).toBe(true);
		const enforcement = validateStrictSchemaEnforcement(schema, strict);
		expect(enforcement.compatible).toBe(true);
		expect(enforcement.violations).toEqual([]);

		expect(
			validateJsonSchemaValue(strict.schema, {
				[INTENT_FIELD]: "Persisting the HAR",
				action: "stop_recording",
				name: "docs",
				url: null,
				app: null,
				viewport: null,
				wait_until: null,
				dialogs: null,
				code: null,
				domains: null,
				timeout: null,
				all: null,
				kill: null,
			}).success,
		).toBe(true);
	});
});
