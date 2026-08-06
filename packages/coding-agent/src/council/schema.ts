import { parsePlanSections } from "../modes/components/plan-toc";
import { buildOutputValidator, summarizeValidationFailure } from "../tools/output-schema-validator";

export const COUNCIL_PLAN_HEADINGS = [
	"Context",
	"Approach",
	"Critical files & anchors",
	"Verification",
	"Assumptions & contingencies",
] as const;

export const COUNCIL_DISPOSITIONS = [
	"accepted",
	"accepted with modification",
	"rejected",
	"duplicate",
	"unactionable",
] as const;

export type CouncilDisposition = (typeof COUNCIL_DISPOSITIONS)[number];
export type CouncilReadiness = "ready" | "revise";
export type CouncilFindingClassification = "must-fix" | "improvement" | "question";
export type CouncilFindingSeverity = "critical" | "high" | "medium" | "low";
export type CouncilFindingConfidence = "high" | "medium" | "low";

export interface CouncilEvidence {
	path: string;
	symbol?: string;
	observation: string;
}

export interface IncomingCouncilFinding {
	classification: CouncilFindingClassification;
	severity: CouncilFindingSeverity;
	confidence: CouncilFindingConfidence;
	evidence: CouncilEvidence[];
	impact: string;
	required: boolean;
	recommendation: string;
	rejectedAssumptions: string[];
	verification: string[];
}

export interface CouncilFinding extends IncomingCouncilFinding {
	id: string;
}

export interface IncomingCouncilReport {
	readiness: CouncilReadiness;
	findings: IncomingCouncilFinding[];
	strengths: string[];
	missingContext: string[];
}

export interface CouncilReport extends Omit<IncomingCouncilReport, "findings"> {
	findings: CouncilFinding[];
}

export interface CouncilPlannerOutput {
	plan: string;
	assumptions: string[];
	blockers: string[];
	evidenceVersion: "1.0.0";
}

export interface CouncilFindingAdjudication {
	id: string;
	disposition: CouncilDisposition;
	reason: string;
	step: string;
	duplicateOf?: string;
}

export interface CouncilAdjudication {
	plan: string;
	dispositions: CouncilFindingAdjudication[];
}

const EVIDENCE_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", minLength: 1, maxLength: 500 },
		symbol: { type: "string", maxLength: 300 },
		observation: { type: "string", minLength: 1, maxLength: 2000 },
	},
	required: ["path", "observation"],
	additionalProperties: false,
} as const;

const INCOMING_FINDING_SCHEMA = {
	type: "object",
	properties: {
		classification: { type: "string", enum: ["must-fix", "improvement", "question"] },
		severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
		confidence: { type: "string", enum: ["high", "medium", "low"] },
		evidence: { type: "array", minItems: 1, maxItems: 12, items: EVIDENCE_SCHEMA },
		impact: { type: "string", minLength: 1, maxLength: 3000 },
		required: { type: "boolean" },
		recommendation: { type: "string", minLength: 1, maxLength: 3000 },
		rejectedAssumptions: {
			type: "array",
			maxItems: 8,
			items: { type: "string", maxLength: 1000 },
		},
		verification: {
			type: "array",
			maxItems: 8,
			items: { type: "string", maxLength: 1000 },
		},
	},
	required: [
		"classification",
		"severity",
		"confidence",
		"evidence",
		"impact",
		"required",
		"recommendation",
		"rejectedAssumptions",
		"verification",
	],
	additionalProperties: false,
} as const;

const PERSISTED_FINDING_SCHEMA = {
	...INCOMING_FINDING_SCHEMA,
	properties: {
		...INCOMING_FINDING_SCHEMA.properties,
		id: { type: "string", minLength: 2, maxLength: 64 },
	},
	required: ["id", ...INCOMING_FINDING_SCHEMA.required],
} as const;

export const COUNCIL_REPORT_SCHEMA = {
	type: "object",
	properties: {
		readiness: { type: "string", enum: ["ready", "revise"] },
		findings: { type: "array", maxItems: 40, items: INCOMING_FINDING_SCHEMA },
		strengths: {
			type: "array",
			maxItems: 5,
			items: { type: "string", maxLength: 1500 },
		},
		missingContext: {
			type: "array",
			maxItems: 8,
			items: { type: "string", maxLength: 1500 },
		},
	},
	required: ["readiness", "findings", "strengths", "missingContext"],
	additionalProperties: false,
} as const;
const PERSISTED_COUNCIL_REPORT_SCHEMA = {
	...COUNCIL_REPORT_SCHEMA,
	properties: {
		...COUNCIL_REPORT_SCHEMA.properties,
		findings: { type: "array", maxItems: 40, items: PERSISTED_FINDING_SCHEMA },
	},
} as const;

export const COUNCIL_PLANNER_SCHEMA = {
	type: "object",
	properties: {
		plan: { type: "string", minLength: 1, maxLength: 60_000 },
		assumptions: {
			type: "array",
			maxItems: 8,
			items: { type: "string", minLength: 1, maxLength: 500 },
		},
		blockers: {
			type: "array",
			maxItems: 8,
			items: { type: "string", minLength: 1, maxLength: 500 },
		},
		evidenceVersion: { type: "string", enum: ["1.0.0"] },
	},
	required: ["plan", "assumptions", "blockers", "evidenceVersion"],
	additionalProperties: false,
} as const;

const COUNCIL_FINDING_ADJUDICATION_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 8 },
		disposition: { type: "string", enum: COUNCIL_DISPOSITIONS },
		reason: { type: "string", minLength: 1, maxLength: 3000 },
		step: { type: "string", minLength: 1, maxLength: 500 },
		duplicateOf: { type: "string", minLength: 1, maxLength: 8 },
	},
	required: ["id", "disposition", "reason", "step"],
	additionalProperties: false,
} as const;

export const COUNCIL_ADJUDICATION_SCHEMA = {
	type: "object",
	properties: {
		plan: { type: "string", minLength: 1, maxLength: 60_000 },
		dispositions: { type: "array", items: COUNCIL_FINDING_ADJUDICATION_SCHEMA },
	},
	required: ["plan", "dispositions"],
	additionalProperties: false,
} as const;

export class CouncilSchemaValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CouncilSchemaValidationError";
	}
}

function validateSchema<T>(schema: unknown, candidate: unknown, label: string): T {
	const { validator, error } = buildOutputValidator(schema);
	if (error || !validator) {
		throw new CouncilSchemaValidationError(`${label} schema is unusable: ${error ?? "no validator"}`);
	}
	const result = validator.validate(candidate);
	if (!result.success) {
		const failure = summarizeValidationFailure(result, candidate, validator.requiredFields);
		throw new CouncilSchemaValidationError(`${label} is invalid: ${failure.message}`);
	}
	return candidate as T;
}

function assertExactPlanHeadings(plan: string, label: string): void {
	const headings = parsePlanSections(plan)
		.filter(section => section.level === 2)
		.map(section => {
			const lineBreak = section.raw.indexOf("\n");
			const headingLine = lineBreak < 0 ? section.raw : section.raw.slice(0, lineBreak);
			return headingLine.slice(2).trim();
		});
	if (
		headings.length !== COUNCIL_PLAN_HEADINGS.length ||
		headings.some((heading, index) => heading !== COUNCIL_PLAN_HEADINGS[index])
	) {
		throw new CouncilSchemaValidationError(
			`${label} H2 headings are ${JSON.stringify(headings)} instead of ${JSON.stringify(COUNCIL_PLAN_HEADINGS)}`,
		);
	}
}

function councilSlotPrefix(slotIndex: number): string {
	if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
		throw new CouncilSchemaValidationError(
			`Council slot index must be a non-negative safe integer, received ${slotIndex}`,
		);
	}
	let remainder = slotIndex;
	let prefix = "";
	do {
		prefix = String.fromCharCode(65 + (remainder % 26)) + prefix;
		remainder = Math.floor(remainder / 26) - 1;
	} while (remainder >= 0);
	return prefix;
}

export function validateCouncilPlannerOutput(candidate: unknown): CouncilPlannerOutput {
	const output = validateSchema<CouncilPlannerOutput>(COUNCIL_PLANNER_SCHEMA, candidate, "Council planner output");
	assertExactPlanHeadings(output.plan, "Council planner output plan");
	return output;
}

export function validateIncomingCouncilReport(candidate: unknown, slotIndex: number): CouncilReport {
	const report = validateSchema<IncomingCouncilReport>(COUNCIL_REPORT_SCHEMA, candidate, "Council member report");
	const prefix = councilSlotPrefix(slotIndex);
	return {
		...report,
		findings: report.findings.map((finding, index) => ({ ...finding, id: `${prefix}${index + 1}` })),
	};
}

/** Strictly validates a durable coordinator-assigned report and its deterministic slot IDs. */
export function validatePersistedCouncilReport(candidate: unknown, slotIndex: number): CouncilReport {
	const report = validateSchema<CouncilReport>(
		PERSISTED_COUNCIL_REPORT_SCHEMA,
		candidate,
		"Persisted council member report",
	);
	const prefix = councilSlotPrefix(slotIndex);
	for (const [index, finding] of report.findings.entries()) {
		const expected = `${prefix}${index + 1}`;
		if (finding.id !== expected) {
			throw new CouncilSchemaValidationError(
				`Persisted council finding id ${JSON.stringify(finding.id)} does not match deterministic id ${expected}`,
			);
		}
	}
	return report;
}

export function validateCouncilAdjudication(
	candidate: unknown,
	expectedFindingIds: readonly string[],
	allowedDuplicateTargetIds: readonly string[] = [],
): CouncilAdjudication {
	const adjudication = validateSchema<CouncilAdjudication>(
		COUNCIL_ADJUDICATION_SCHEMA,
		candidate,
		"Council adjudication",
	);
	assertExactPlanHeadings(adjudication.plan, "Council adjudication plan");

	const expectedIds = new Set(expectedFindingIds);
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	const extraIds = new Set<string>();
	for (const disposition of adjudication.dispositions) {
		if (seenIds.has(disposition.id)) duplicateIds.add(disposition.id);
		seenIds.add(disposition.id);
		if (!expectedIds.has(disposition.id)) extraIds.add(disposition.id);
	}
	const missingIds = expectedFindingIds.filter(id => !seenIds.has(id));
	if (missingIds.length > 0 || extraIds.size > 0 || duplicateIds.size > 0) {
		throw new CouncilSchemaValidationError(
			`Council adjudication disposition ids must match expected findings; missing=${JSON.stringify(missingIds)}, extra=${JSON.stringify([...extraIds])}, duplicate=${JSON.stringify([...duplicateIds])}`,
		);
	}

	const allowedTargets = new Set([...expectedFindingIds, ...allowedDuplicateTargetIds]);
	const dispositionsById = new Map(adjudication.dispositions.map(disposition => [disposition.id, disposition]));
	for (const disposition of adjudication.dispositions) {
		if (disposition.disposition !== "duplicate") {
			if (disposition.duplicateOf !== undefined) {
				throw new CouncilSchemaValidationError(
					`Council adjudication disposition ${disposition.id} cannot name duplicateOf unless its disposition is duplicate`,
				);
			}
			continue;
		}
		const duplicateTarget = disposition.duplicateOf;
		if (!duplicateTarget) {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} is missing its duplicate target`,
			);
		}
		if (duplicateTarget === disposition.id) {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} cannot duplicate itself`,
			);
		}
		if (!allowedTargets.has(duplicateTarget)) {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} has unknown duplicate target ${duplicateTarget}`,
			);
		}
		const targetDisposition = dispositionsById.get(duplicateTarget);
		if (targetDisposition?.disposition === "duplicate") {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} must name a canonical finding; duplicate target ${duplicateTarget} is itself duplicate`,
			);
		}
	}
	return adjudication;
}
