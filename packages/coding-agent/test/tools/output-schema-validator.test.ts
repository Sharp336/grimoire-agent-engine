import { describe, expect, it } from "bun:test";
import {
	buildOutputValidator,
	computeMissingRequired,
	createSchemaViolationResult,
	extractRequiredFields,
	formatAllValidationIssues,
	formatValidationIssueHeadline,
	prepareOutputSchema,
	summarizeValidationFailure,
} from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";

describe("buildOutputValidator", () => {
	it("returns the empty result for an absent schema", () => {
		const result = buildOutputValidator(undefined);
		expect(result).toEqual({});
	});

	it("returns `normalized: true` (no validator) for an unconstrained schema so callers can distinguish from absent", () => {
		const result = buildOutputValidator(true);
		expect(result.validator).toBeUndefined();
		expect(result.jsonSchema).toBeUndefined();
		expect(result.normalized).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("errors on a boolean false schema (rejects all inputs)", () => {
		const result = buildOutputValidator(false);
		expect(result.error).toBe("boolean false schema rejects all outputs");
		expect(result.validator).toBeUndefined();
	});

	it("errors on a malformed JSON Schema", () => {
		const result = buildOutputValidator({
			type: "object",
			properties: { x: { type: "not-a-real-type" } },
		});
		expect(result.error).toBe("invalid JSON schema");
	});

	it("builds a validator that accepts conforming JTD payloads and rejects shape mismatches", () => {
		const { validator, jsonSchema } = buildOutputValidator({
			properties: {
				summary: { type: "string" },
				files: {
					elements: {
						properties: {
							path: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		});
		expect(validator).toBeDefined();
		expect(jsonSchema).toBeDefined();
		expect(validator?.requiredFields).toEqual(["summary", "files"]);

		const good = { summary: "ok", files: [{ path: "a.md", description: "d" }] };
		expect(validator?.validate(good).success).toBe(true);

		const bad = { summary: "ok", files: [{ ref: "a.md", surface: "g" }] };
		const r = validator?.validate(bad);
		expect(r?.success).toBe(false);
		const issues = r?.success === false ? r.issues : [];
		// All four problems surface: missing `path`, missing `description`, extra `ref`, extra `surface`.
		expect(issues.map(i => i.keyword).sort()).toEqual([
			"additionalProperties",
			"additionalProperties",
			"required",
			"required",
		]);
	});

	it("exposes per-label sub-validators that accept items (not whole arrays) for elements properties", () => {
		const { validator } = buildOutputValidator({
			properties: {
				overall_correctness: { enum: ["correct", "incorrect"] },
				explanation: { type: "string" },
			},
			optionalProperties: {
				findings: {
					elements: {
						properties: { title: { type: "string" }, body: { type: "string" } },
					},
				},
			},
		});
		expect(validator).toBeDefined();
		const sections = validator?.validateSection;
		expect(sections).toBeDefined();
		// Scalar enum: per-section validator enforces the enum directly.
		expect(sections?.get("overall_correctness")?.("correct").success).toBe(true);
		expect(sections?.get("overall_correctness")?.("Correct").success).toBe(false);
		// String property: any string passes, non-strings fail.
		expect(sections?.get("explanation")?.("ok").success).toBe(true);
		expect(sections?.get("explanation")?.(123).success).toBe(false);
		// Array property: each section validates ONE item against the items schema, not the whole array.
		expect(sections?.get("findings")?.({ title: "t", body: "b" }).success).toBe(true);
		expect(sections?.get("findings")?.([{ title: "t", body: "b" }]).success).toBe(false);
		// Unknown labels have no validator so user-defined sections stay loose.
		expect(sections?.has("scratchpad")).toBe(false);
		expect(validator?.sectionRequiredFields.get("findings")).toEqual(["title", "body"]);
	});
});
describe("summarizeValidationFailure", () => {
	it("returns an empty summary when the result is a success", () => {
		const summary = summarizeValidationFailure({ success: true, issues: [] }, {}, []);
		expect(summary).toEqual({ message: "", missingRequired: [] });
	});

	it("uses the first issue as the headline and reports missing required fields", () => {
		const { validator } = buildOutputValidator({
			properties: { a: { type: "string" }, b: { type: "string" } },
		});
		const result = validator?.validate({ a: "hi" });
		expect(result?.success).toBe(false);
		const summary = summarizeValidationFailure(result!, { a: "hi" }, validator?.requiredFields ?? []);
		expect(summary.missingRequired).toEqual(["b"]);
		expect(summary.message).toMatch(/b: is required/);
	});
});

describe("formatValidationIssueHeadline", () => {
	it("joins paths with dots and falls back to `(root)` for empty paths", () => {
		expect(
			formatValidationIssueHeadline({ path: ["files", 0, "path"], message: "is required", keyword: "required" }),
		).toBe("files.0.path: is required");
		expect(formatValidationIssueHeadline({ path: [], message: "top-level error", keyword: "type" })).toBe(
			"(root): top-level error",
		);
		expect(formatValidationIssueHeadline(undefined)).toBeUndefined();
	});
});

describe("formatAllValidationIssues", () => {
	it("joins every issue with `; ` using slash-separated paths so callers see the whole failure set", () => {
		const out = formatAllValidationIssues([
			{ path: ["files", 0, "path"], message: "is required", keyword: "required" },
			{ path: ["files", 0, "ref"], message: "must not be present", keyword: "additionalProperties" },
		]);
		expect(out).toBe("files/0/path: is required; files/0/ref: must not be present");
	});

	it("handles the empty list with a sentinel message instead of an empty string", () => {
		expect(formatAllValidationIssues(undefined)).toBe("Unknown schema validation error.");
		expect(formatAllValidationIssues([])).toBe("Unknown schema validation error.");
	});

	it("bounds oversized retry diagnostics while preserving the first actionable issue", () => {
		const diagnostic = formatAllValidationIssues(
			Array.from({ length: 32 }, (_, index) => ({
				path: [`field_${index}`, "x".repeat(1_000)],
				message: `must be present: ${"y".repeat(1_000)}`,
				keyword: "required",
			})),
		);

		expect(diagnostic).toContain("field_0");
		expect(diagnostic.length).toBeLessThanOrEqual(2_048);
	});
});

describe("extractRequiredFields / computeMissingRequired", () => {
	it("extractRequiredFields returns the top-level required array or empty", () => {
		expect(extractRequiredFields({ required: ["a", "b"] })).toEqual(["a", "b"]);
		expect(extractRequiredFields({ properties: {} })).toEqual([]);
		expect(extractRequiredFields(null)).toEqual([]);
		expect(extractRequiredFields(undefined)).toEqual([]);
	});

	it("computeMissingRequired flags absent and explicit-undefined keys, treats non-objects as having all missing", () => {
		expect(computeMissingRequired(["a", "b"], { a: 1, b: 2 })).toEqual([]);
		expect(computeMissingRequired(["a", "b"], { a: 1 })).toEqual(["b"]);
		expect(computeMissingRequired(["a", "b"], { a: 1, b: undefined })).toEqual(["b"]);
		expect(computeMissingRequired(["a"], null)).toEqual(["a"]);
		expect(computeMissingRequired(["a"], 42)).toEqual([]);
		expect(computeMissingRequired(["a"], [])).toEqual([]);
		expect(computeMissingRequired([], { x: 1 })).toEqual([]);
	});
});

describe("prepareOutputSchema", () => {
	it("preserves a usable strict schema as a validated preparation", () => {
		const prepared = prepareOutputSchema(
			{
				type: "object",
				properties: { answer: { type: "string" } },
				required: ["answer"],
				additionalProperties: false,
			},
			"strict",
		);

		expect(prepared.schemaMode).toBe("strict");
		expect(prepared.error).toBeUndefined();
		expect(prepared.validator?.validate({ answer: "done" }).success).toBe(true);
		expect(prepared.validator?.validate({}).success).toBe(false);
	});

	it("rejects nested external references only when strict preparation cannot resolve them", () => {
		const nestedExternalRef = {
			$ref: "#/$defs/Result",
			$defs: {
				Result: {
					type: "object",
					properties: { payload: { $ref: "#/$defs/Payload" } },
					required: ["payload"],
				},
				Payload: {
					type: "object",
					properties: { detail: { $ref: "https://example.com/missing-schema.json#/Detail" } },
					required: ["detail"],
				},
			},
		};

		const strict = prepareOutputSchema(nestedExternalRef, "strict");
		const permissive = prepareOutputSchema(nestedExternalRef, "permissive");

		expect(strict).toMatchObject({
			schemaMode: "strict",
			error: "schema contains unresolved $ref after dereferencing",
		});
		expect(strict.validator).toBeUndefined();
		expect(permissive.error).toBeUndefined();
		expect(permissive.validator).toBeDefined();
	});

	it("retains strict mode and reports unusable schemas rather than silently treating them as prepared", () => {
		const circularSchema: Record<string, unknown> = { type: "object" };
		circularSchema.self = circularSchema;

		const normalizedFailure = prepareOutputSchema(false, "strict");
		const dereferenceFailure = prepareOutputSchema(circularSchema, "strict");

		expect(normalizedFailure).toMatchObject({
			schemaMode: "strict",
			error: "boolean false schema rejects all outputs",
		});
		expect(dereferenceFailure.schemaMode).toBe("strict");
		expect(dereferenceFailure.error).toMatch(/^schema preparation failed:/);
		expect(dereferenceFailure.validator).toBeUndefined();
	});
});

describe("createSchemaViolationResult", () => {
	it("keeps typed violations bounded while preserving the payload preview contract", () => {
		const violation = createSchemaViolationResult("answer: must be string", ["answer"], {
			answer: "x".repeat(1_000),
		});

		expect(violation).toMatchObject({
			error: "schema_violation",
			message: "answer: must be string",
			missingRequired: ["answer"],
		});
		expect(JSON.stringify(violation.data).length).toBeLessThanOrEqual(256);
		expect(violation.data.endsWith("…")).toBe(true);
	});

	it("bounds diagnostics emitted from oversized schemas and escaped messages", () => {
		const required = Array.from({ length: 100 }, (_, index) => `missing_${index}_${"n".repeat(1_000)}`);
		const { validator } = buildOutputValidator({
			type: "object",
			properties: Object.fromEntries(required.map(name => [name, { type: "string" }])),
			required,
		});
		const validation = validator?.validate({});
		const summary = summarizeValidationFailure(validation!, {}, validator?.requiredFields ?? []);
		const violation = createSchemaViolationResult(
			`${"\u0000".repeat(10_000)}${summary.message}`,
			summary.missingRequired,
			{ payload: "\u0000".repeat(10_000) },
		);

		expect(JSON.stringify(violation.message).length).toBeLessThanOrEqual(512);
		expect(violation.missingRequired).toHaveLength(6);
		expect(violation.missingRequired.every(field => JSON.stringify(field).length <= 48)).toBe(true);
		expect(JSON.stringify(violation.data).length).toBeLessThanOrEqual(256);
		expect(JSON.stringify(violation).length).toBeLessThanOrEqual(2_048);
	});
});
