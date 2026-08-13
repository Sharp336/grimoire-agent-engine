import { describe, expect, it } from "bun:test";
import { COUNCIL_MAX_ACTIVE_REVIEWERS } from "@oh-my-pi/pi-coding-agent/council/config";
import {
	COUNCIL_PLAN_CHAR_LIMIT,
	COUNCIL_PLANNER_SCHEMA,
	COUNCIL_REPORT_SCHEMA,
	type CouncilAdjudication,
	type CouncilFindingAdjudication,
	type CouncilPlannerOutput,
	CouncilSchemaValidationError,
	councilSlotPrefix,
	validateCouncilAdjudication,
	validateCouncilPlannerOutput,
	validateIncomingCouncilReport,
} from "@oh-my-pi/pi-coding-agent/council/schema";
import { buildOutputValidator } from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";

const PLAN = `## Context
Context.

## Approach
1. Change the behavior.

## Critical files & anchors
- src/example.ts: symbol

## Verification
- Exercise the behavior.

## Assumptions & contingencies
- None.
`;

const FINDING = {
	classification: "must-fix",
	severity: "high",
	confidence: "high",
	evidence: [{ path: "src/example.ts", symbol: "run", observation: "The caller is omitted." }],
	impact: "The requested path remains incomplete.",
	required: true,
	recommendation: "Update the caller.",
	rejectedAssumptions: [],
	verification: ["Exercise the caller."],
};

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		readiness: "revise",
		findings: [FINDING],
		strengths: ["The plan follows repository structure."],
		missingContext: [],
		...overrides,
	};
}

function expectSchemaRejects(schema: unknown, candidate: unknown): void {
	const { validator, error } = buildOutputValidator(schema);
	expect(error).toBeUndefined();
	expect(validator).toBeDefined();
	expect(validator?.validate(candidate).success).toBe(false);
}

describe("council schemas", () => {
	it("keeps JSON Schema caps enforceable", () => {
		expectSchemaRejects(COUNCIL_REPORT_SCHEMA, report({ findings: Array.from({ length: 41 }, () => FINDING) }));
		expectSchemaRejects(COUNCIL_REPORT_SCHEMA, report({ strengths: Array.from({ length: 6 }, () => "sound") }));
		expectSchemaRejects(COUNCIL_REPORT_SCHEMA, report({ missingContext: Array.from({ length: 9 }, () => "gap") }));
		expectSchemaRejects(
			COUNCIL_REPORT_SCHEMA,
			report({ findings: [{ ...FINDING, evidence: Array.from({ length: 13 }, () => FINDING.evidence[0]) }] }),
		);
		expectSchemaRejects(COUNCIL_REPORT_SCHEMA, report({ findings: [{ ...FINDING, evidence: [] }] }));
		expect(() => validateIncomingCouncilReport(report({ findings: [{ ...FINDING, evidence: [] }] }), 0)).toThrow(
			CouncilSchemaValidationError,
		);
		expectSchemaRejects(COUNCIL_REPORT_SCHEMA, report({ strengths: ["x".repeat(1501)] }));
		expectSchemaRejects(COUNCIL_PLANNER_SCHEMA, {
			plan: "x".repeat(COUNCIL_PLAN_CHAR_LIMIT + 1),
			assumptions: [],
			blockers: [],
			evidenceVersion: "1.0.0",
		});
	});

	it("accepts idless member reports and assigns deterministic slot IDs", () => {
		const firstSlot = validateIncomingCouncilReport(report({ findings: [FINDING, { ...FINDING }] }), 0);
		const secondSlot = validateIncomingCouncilReport(report(), 1);

		expect(firstSlot.findings.map(finding => finding.id)).toEqual(["A1", "A2"]);
		expect(secondSlot.findings[0]?.id).toBe("B1");
		expect("id" in FINDING).toBe(false);
		expect(() => validateIncomingCouncilReport(report({ findings: [{ ...FINDING, id: "forged" }] }), 0)).toThrow(
			CouncilSchemaValidationError,
		);
	});

	it("requires exact CommonMark H2 headings outside fenced code", () => {
		const output = {
			plan: PLAN,
			assumptions: [],
			blockers: [],
			evidenceVersion: "1.0.0",
		} satisfies CouncilPlannerOutput;
		expect(validateCouncilPlannerOutput(output)).toEqual(output);

		const drifted = PLAN.replace("## Critical files & anchors", "## Critical files");
		expect(() => validateCouncilPlannerOutput({ ...output, plan: drifted })).toThrow(/H2 headings/);

		const missingSeparator = PLAN.replace("## Context", "##Context");
		expect(() => validateCouncilPlannerOutput({ ...output, plan: missingSeparator })).toThrow(/H2 headings/);

		const fencedFakeHeading = `\`\`\`markdown
## Fake section
\`\`\`

${PLAN}`;
		expect(validateCouncilPlannerOutput({ ...output, plan: fencedFakeHeading }).plan).toBe(fencedFakeHeading);
	});

	it("requires duplicateOf exactly for duplicate dispositions", () => {
		const missingTarget = {
			plan: PLAN,
			dispositions: [{ id: "A1", disposition: "duplicate", reason: "Same root cause.", step: "1" }],
		};
		expect(() => validateCouncilAdjudication(missingTarget, ["A1"])).toThrow(CouncilSchemaValidationError);

		const duplicateDisposition = {
			id: "A1",
			disposition: "duplicate",
			reason: "Same root cause.",
			step: "1",
			duplicateOf: "B1",
		} satisfies CouncilFindingAdjudication;
		const duplicate = {
			plan: PLAN,
			dispositions: [duplicateDisposition],
		} satisfies CouncilAdjudication;
		expect(validateCouncilAdjudication(duplicate, ["A1"], ["B1"])).toEqual(duplicate);

		expect(() =>
			validateCouncilAdjudication(
				{
					plan: PLAN,
					dispositions: [
						{
							id: "A1",
							disposition: "accepted",
							reason: "Verified.",
							step: "1",
							duplicateOf: "B1",
						},
					],
				},
				["A1"],
				["B1"],
			),
		).toThrow(/cannot name duplicateOf/);
	});

	it("requires exactly one disposition for every expected finding id", () => {
		const accepted = (id: string): CouncilFindingAdjudication => ({
			id,
			disposition: "accepted",
			reason: "Verified.",
			step: "1",
		});
		const validate = (dispositions: CouncilFindingAdjudication[]) =>
			validateCouncilAdjudication({ plan: PLAN, dispositions }, ["A1", "A2"]);

		expect(() => validate([])).toThrow(/missing=.*A1.*A2/);
		expect(() => validate([accepted("A1")])).toThrow(/missing=.*A2/);
		expect(() => validate([accepted("A1"), accepted("A1"), accepted("A2")])).toThrow(/duplicate=.*A1/);
		expect(() => validate([accepted("A1"), accepted("A2"), accepted("C1")])).toThrow(/extra=.*C1/);
	});

	it("rejects self and unknown duplicate targets", () => {
		const selfDuplicate = {
			plan: PLAN,
			dispositions: [
				{
					id: "A1",
					disposition: "duplicate",
					reason: "Same root cause.",
					step: "1",
					duplicateOf: "A1",
				},
			],
		} satisfies CouncilAdjudication;
		const unknownDuplicate = {
			plan: PLAN,
			dispositions: [{ ...selfDuplicate.dispositions[0], duplicateOf: "B1" }],
		} satisfies CouncilAdjudication;

		expect(() => validateCouncilAdjudication(selfDuplicate, ["A1"])).toThrow(/cannot duplicate itself/);
		expect(() => validateCouncilAdjudication(unknownDuplicate, ["A1"])).toThrow(/unknown duplicate target B1/);
	});

	it("rejects duplicate chains, cycles, and non-canonical prior targets", () => {
		const duplicate = (id: string, duplicateOf: string): CouncilFindingAdjudication => ({
			id,
			disposition: "duplicate",
			reason: "Same root cause.",
			step: "1",
			duplicateOf,
		});
		const accepted = (id: string): CouncilFindingAdjudication => ({
			id,
			disposition: "accepted",
			reason: "Verified.",
			step: "1",
		});

		expect(() =>
			validateCouncilAdjudication(
				{ plan: PLAN, dispositions: [duplicate("A1", "A2"), duplicate("A2", "A3"), accepted("A3")] },
				["A1", "A2", "A3"],
			),
		).toThrow(/canonical finding.*A2.*itself duplicate/);
		expect(() =>
			validateCouncilAdjudication({ plan: PLAN, dispositions: [duplicate("A1", "A2"), duplicate("A2", "A1")] }, [
				"A1",
				"A2",
			]),
		).toThrow(/canonical finding/);

		const current = { plan: PLAN, dispositions: [duplicate("B1", "A1")] } satisfies CouncilAdjudication;
		expect(() => validateCouncilAdjudication(current, ["B1"], ["A2"])).toThrow(/unknown duplicate target A1/);
		expect(
			validateCouncilAdjudication({ ...current, dispositions: [duplicate("B1", "A2")] }, ["B1"], ["A2"]),
		).toEqual({
			plan: PLAN,
			dispositions: [duplicate("B1", "A2")],
		});
	});

	it("grades reviewer slot 64 and rejects slot 65", () => {
		// Literals, not the constant: the point is that the adjudication schema can represent exactly
		// 64 reviewers. Following COUNCIL_MAX_ACTIVE_REVIEWERS here would keep passing if the cap were
		// widened past what a grade slot can express, which is the defect this guards.
		expect(COUNCIL_MAX_ACTIVE_REVIEWERS).toBe(64);

		const accepted: CouncilFindingAdjudication = {
			id: "A1",
			disposition: "accepted",
			reason: "Verified.",
			step: "1",
		};
		const graded = (slot: number): CouncilAdjudication => ({
			plan: PLAN,
			dispositions: [accepted],
			grades: [{ slot, grade: "A", reason: "Surfaced the critical defect." }],
		});

		const atCap = graded(64);
		expect(validateCouncilAdjudication(atCap, ["A1"], [], [64])).toEqual(atCap);

		expect(() => validateCouncilAdjudication(graded(65), ["A1"])).toThrow(CouncilSchemaValidationError);
		expect(() => validateCouncilAdjudication(graded(0), ["A1"])).toThrow(CouncilSchemaValidationError);
	});

	it("shares one finding-id prefix contract between reviewer instructions and validation", () => {
		expect(councilSlotPrefix(0)).toBe("A");
		expect(councilSlotPrefix(25)).toBe("Z");
		expect(councilSlotPrefix(26)).toBe("AA");
		expect(() => councilSlotPrefix(-1)).toThrow(CouncilSchemaValidationError);

		// Slot index 63 is the 64th and last representable reviewer.
		expect(councilSlotPrefix(63)).toBe("BL");
		expect(validateIncomingCouncilReport(report(), 63).findings[0]!.id).toBe("BL1");
	});
});
