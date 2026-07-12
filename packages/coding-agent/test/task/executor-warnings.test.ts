import { describe, expect, it } from "bun:test";
import {
	finalizeSubprocessOutput,
	SUBAGENT_WARNING_MISSING_YIELD,
	SUBAGENT_WARNING_NULL_YIELD,
	SUBAGENT_WARNING_SCHEMA_OVERRIDDEN,
} from "@oh-my-pi/pi-coding-agent/task/executor";

const strictObjectSchema = {
	type: "object",
	required: ["ok"],
	properties: { ok: { type: "boolean" } },
};

function finalizeStrict(overrides: Partial<Parameters<typeof finalizeSubprocessOutput>[0]> = {}) {
	return finalizeSubprocessOutput({
		rawOutput: "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		outputSchema: strictObjectSchema,
		schemaMode: "strict",
		...overrides,
	});
}

describe("subagent warning injection", () => {
	it("injects null-data warning when yield is success without data", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success" }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_NULL_YIELD}\n\npartial output`);
		expect(result.hasYield).toBe(true);
	});

	it("injects missing-submit warning when subagent exits cleanly without yield", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { properties: { ok: { type: "boolean" } } },
		});

		expect(result.rawOutput).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		expect(result.hasYield).toBe(false);
	});

	it("does not inject missing-submit warning when fallback completion is recoverable", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: '{"data":{"ok":true}}',
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("prefixes missing-submit warning on stop outputs", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "agent stopped after writing analysis",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_MISSING_YIELD}\n\nagent stopped after writing analysis`);
	});

	it("does not inject missing-submit warning when execution exits non-zero", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 1,
			stderr: "subagent terminated",
			doneAborted: true,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.rawOutput).toBe("");
		expect(result.stderr).toBe("subagent terminated");
		expect(result.exitCode).toBe(1);
	});

	it("normalizes explicit aborted yield into aborted payload", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 1,
			stderr: "old error",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "aborted", error: "blocked by permissions" }],
			outputSchema: undefined,
		});

		expect(result.abortedViaYield).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("blocked by permissions");
		expect(result.rawOutput).toContain('"aborted": true');
		expect(result.rawOutput).toContain('"blocked by permissions"');
	});

	it("accepts successful yield data without warning", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "should be replaced",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
	});

	it("does not inject missing-submit warning when no schema and raw text exists", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "plain text notes",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: undefined,
			outputSchema: undefined,
		});

		expect(result.rawOutput).toBe("plain text notes");
		expect(result.rawOutput.includes("SYSTEM WARNING")).toBe(false);
		expect(result.exitCode).toBe(0);
	});

	it("honors schemaOverridden flag from yield and surfaces data with warning", () => {
		// Reviewer subagent exhausted its in-tool schema-retry budget, then was
		// accepted with empty finding objects. Without honoring the override, the
		// executor's post-mortem validator silently rejected the same payload with
		// `schema_violation`, opaquely swapping the agent's accepted output for an
		// error blob. Reports #2, #8, #11, #16, #17, #20.
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { findings: [{}, {}] }, schemaOverridden: true }],
			outputSchema: {
				type: "object",
				required: ["findings"],
				properties: {
					findings: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							required: ["severity", "file", "line"],
							properties: {
								severity: { type: "string" },
								file: { type: "string" },
								line: { type: "number" },
							},
						},
					},
				},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe(SUBAGENT_WARNING_SCHEMA_OVERRIDDEN);
		expect(JSON.parse(result.rawOutput)).toEqual({ findings: [{}, {}] });
	});

	it("treats malformed output schemas as no validation instead of schema_violation", () => {
		// Empty-string schema is a caller mistake; the yield tool already degrades
		// to a loose schema and accepts the data. The executor's finalizer used to
		// emit `schema_violation: invalid output schema` even though yield accepted
		// it, which surprised users dispatching prose review batches. Report #60.
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { verdict: "looks good" } }],
			outputSchema: "",
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.rawOutput)).toEqual({ verdict: "looks good" });
		expect(result.stderr.startsWith("invalid output schema:")).toBe(true);
	});

	it("assembles incremental typed yield sections on idle", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{ status: "success", type: ["summary"], data: "first" },
				{ status: "success", type: ["summary", "notes"], data: { detail: "second" } },
			],
			outputSchema: {
				type: "object",
				required: ["summary", "notes"],
				properties: {
					summary: { type: "array", minItems: 2 },
					notes: { type: "object", required: ["detail"], properties: { detail: { type: "string" } } },
				},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.hasYield).toBe(true);
		expect(JSON.parse(result.rawOutput)).toEqual({
			summary: ["first", { detail: "second" }],
			notes: { detail: "second" },
		});
	});

	it("validates assembled typed yield data against the output schema", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", type: ["summary"], data: "text only" }],
			outputSchema: {
				type: "object",
				required: ["summary", "notes"],
				properties: {
					summary: { type: "string" },
					notes: { type: "string" },
				},
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("schema_violation");
		expect(JSON.parse(result.rawOutput)).toMatchObject({
			error: "schema_violation",
			missingRequired: ["notes"],
		});
	});

	it("assembles a single incremental array-typed section into a one-element list", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{ status: "success", type: ["findings"], data: { title: "Handle null response", body: "Crashes" } },
				{ status: "success", type: ["overall_correctness"], data: "incorrect" },
				{ status: "success", type: ["explanation"], data: "One bug blocks approval." },
				{ status: "success", type: ["confidence"], data: 0.8 },
			],
			// JTD reviewer-style schema: only `findings` is array-valued (elements).
			outputSchema: {
				properties: {
					overall_correctness: { enum: ["correct", "incorrect"] },
					explanation: { type: "string" },
					confidence: { type: "number" },
				},
				optionalProperties: {
					findings: {
						elements: { properties: { title: { type: "string" }, body: { type: "string" } } },
					},
				},
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.rawOutput)).toEqual({
			findings: [{ title: "Handle null response", body: "Crashes" }],
			overall_correctness: "incorrect",
			explanation: "One bug blocks approval.",
			confidence: 0.8,
		});
	});

	it("uses last assistant text as the raw result for terminal string-typed yields without data", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", type: "final" }],
			outputSchema: undefined,
			lastAssistantText: "final answer from the assistant",
		});

		expect(result.exitCode).toBe(0);
		expect(result.rawOutput).toBe("final answer from the assistant");
	});

	it("keeps accumulated sections when a data-less terminal yield finalizes", () => {
		// Previously a data-less `type: "final"` collapsed to the last assistant
		// turn and dropped earlier incremental sections; the sections are the work
		// product, so they must survive the finalize.
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{ status: "success", type: ["summary"], data: "first" },
				{ status: "success", type: "final" },
			],
			outputSchema: undefined,
			lastAssistantText: "plain final answer",
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.rawOutput)).toEqual({ summary: "first" });
	});

	it("finalizes a string-typed terminal yield that carries data as the top-level result", () => {
		// Regression: a `type: "result"` finalize with the full structured object
		// was treated as a section labeled "result", nesting the payload one level
		// deep so every required field read as missing (schema_violation).
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [
				{
					status: "success",
					type: "result",
					data: { summary: "did it", filesChanged: ["a.ts"], notes: ["ok"] },
				},
			],
			outputSchema: {
				properties: {
					summary: { type: "string" },
					filesChanged: { elements: { type: "string" } },
					notes: { elements: { type: "string" } },
				},
			},
			lastAssistantText: "some prose that must not become the result",
		});

		expect(result.stderr).not.toContain("schema_violation");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.rawOutput)).toEqual({
			summary: "did it",
			filesChanged: ["a.ts"],
			notes: ["ok"],
		});
	});

	it("serializes untyped useLastTurn yield as raw text", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", useLastTurn: true }],
			outputSchema: undefined,
			lastAssistantText: "plain final answer",
		});

		expect(result.exitCode).toBe(0);
		expect(result.rawOutput).toBe("plain final answer");
	});
});

describe("strict schema finalization", () => {
	it("keeps valid terminal yield data unchanged", () => {
		const result = finalizeStrict({ yieldItems: [{ status: "success", data: { ok: true } }] });

		expect(result.exitCode).toBe(0);
		expect(result.failure).toBeUndefined();
		expect(result.rawOutput).toBe('{\n  "ok": true\n}');
	});

	it("rejects a schema override as a typed, nonzero failure", () => {
		const result = finalizeStrict({
			yieldItems: [{ status: "success", data: { ok: true }, schemaOverridden: true }],
		});

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.failure).toMatchObject({ error: "schema_violation" });
		expect(result.stderr).toContain("rejects schema-validation overrides");
		expect(JSON.parse(result.rawOutput)).toEqual(result.failure);
	});

	it("never salvages valid or malformed raw output without an explicit strict yield", () => {
		for (const rawOutput of ['{"ok":true}', "not valid JSON"]) {
			const result = finalizeStrict({ rawOutput });

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.failure).toMatchObject({ error: "schema_violation" });
			expect(result.stderr).toContain("requires a valid yield submission");
			expect(result.rawOutput).not.toBe(rawOutput);
		}
	});

	it("rejects null and omitted yield data as typed strict failures", () => {
		const nullResult = finalizeStrict({ yieldItems: [{ status: "success", data: null }] });
		const missingResult = finalizeStrict({ yieldItems: [{ status: "success" }] });

		for (const result of [nullResult, missingResult]) {
			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.failure).toMatchObject({ error: "schema_violation" });
			expect(JSON.parse(result.rawOutput)).toEqual(result.failure);
		}
		expect(missingResult.stderr).toContain("requires complete explicit yield data");
	});

	it("validates complete incremental assembly and rejects an incomplete one", () => {
		const schema = {
			type: "object",
			required: ["summary", "count"],
			properties: { summary: { type: "string" }, count: { type: "number" } },
		};
		const complete = finalizeStrict({
			outputSchema: schema,
			yieldItems: [
				{ status: "success", type: ["summary"], data: "finished" },
				{ status: "success", type: ["count"], data: 2 },
			],
		});
		const incomplete = finalizeStrict({
			outputSchema: schema,
			yieldItems: [{ status: "success", type: ["summary"], data: "unfinished" }],
		});

		expect(complete.exitCode).toBe(0);
		expect(JSON.parse(complete.rawOutput)).toEqual({ summary: "finished", count: 2 });
		expect(incomplete.exitCode).toBeGreaterThan(0);
		expect(incomplete.failure?.missingRequired).toEqual(["count"]);
	});

	it("validates the assembled whole even when each incremental section is individually valid", () => {
		const result = finalizeStrict({
			outputSchema: {
				type: "object",
				required: ["left", "right"],
				properties: {
					left: { enum: ["a", "b"] },
					right: { enum: ["a", "b"] },
				},
				oneOf: [
					{ properties: { left: { const: "a" }, right: { const: "b" } } },
					{ properties: { left: { const: "b" }, right: { const: "a" } } },
				],
			},
			yieldItems: [
				{ status: "success", type: ["left"], data: "a" },
				{ status: "success", type: ["right"], data: "a" },
			],
		});

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.failure).toMatchObject({ error: "schema_violation" });
	});

	it("preserves explicit JSON-looking strings and falsy terminal values exactly", () => {
		const cases: Array<{ schema: unknown; value: unknown }> = [
			{ schema: { type: "string" }, value: '{"ok":true}' },
			{ schema: { type: "boolean" }, value: false },
			{ schema: { type: "number" }, value: 0 },
		];

		for (const { schema, value } of cases) {
			const result = finalizeStrict({
				outputSchema: schema,
				yieldItems: [{ status: "success", data: value }],
			});

			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.rawOutput)).toEqual(value);
		}
	});

	it("requires strict yields to include report findings explicitly", () => {
		const schema = {
			type: "object",
			required: ["summary", "findings"],
			properties: {
				summary: { type: "string" },
				findings: { type: "array", minItems: 1 },
			},
		};
		const reportFindings = [
			{
				title: "Missing guard",
				body: "The request can be null.",
				priority: 1,
				confidence: 0.9,
				file_path: "src/example.ts",
				line_start: 4,
				line_end: 4,
			},
		];
		const strict = finalizeStrict({
			outputSchema: schema,
			yieldItems: [{ status: "success", data: { summary: "reviewed" } }],
			reportFindings,
		});
		const permissive = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			outputSchema: schema,
			yieldItems: [{ status: "success", data: { summary: "reviewed" } }],
			reportFindings,
		});

		expect(strict.exitCode).toBeGreaterThan(0);
		expect(strict.failure?.missingRequired).toEqual(["findings"]);
		expect(permissive.exitCode).toBe(0);
		expect(JSON.parse(permissive.rawOutput)).toMatchObject({
			summary: "reviewed",
			findings: [{ title: "Missing guard" }],
		});
	});

	it("keeps signal, completed-run abort, and explicit abort distinct from schema violations", () => {
		const signalResult = finalizeStrict({
			rawOutput: "partial result",
			stderr: "cancelled by caller",
			signalAborted: true,
			yieldItems: [{ status: "success", data: { ok: true } }],
		});
		const completedAbortResult = finalizeStrict({
			rawOutput: "partial result",
			stderr: "runtime limit exceeded",
			doneAborted: true,
			yieldItems: [{ status: "success", data: { ok: true } }],
		});
		const explicitAbortResult = finalizeStrict({
			yieldItems: [{ status: "aborted", error: "blocked by permissions" }],
		});

		for (const result of [signalResult, completedAbortResult, explicitAbortResult]) {
			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.failure).toBeUndefined();
			expect(result.stderr).not.toContain("schema_violation");
		}
		expect(signalResult.rawOutput).toBe("partial result");
		expect(completedAbortResult.rawOutput).toBe("partial result");
		expect(JSON.parse(explicitAbortResult.rawOutput)).toEqual({
			aborted: true,
			error: "blocked by permissions",
		});
	});

	it("retains permissive override and raw-output fallback behavior when mode is omitted", () => {
		const overridden = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			outputSchema: strictObjectSchema,
			yieldItems: [{ status: "success", data: { wrong: true }, schemaOverridden: true }],
		});
		const fallback = finalizeSubprocessOutput({
			rawOutput: '{"data":{"ok":true}}',
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			outputSchema: strictObjectSchema,
		});

		expect(overridden.exitCode).toBe(0);
		expect(overridden.stderr).toBe(SUBAGENT_WARNING_SCHEMA_OVERRIDDEN);
		expect(fallback.exitCode).toBe(0);
		expect(JSON.parse(fallback.rawOutput)).toEqual({ ok: true });
	});
});
