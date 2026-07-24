import { countTokens } from "@oh-my-pi/pi-agent-core";
import { MemoryType, type MemoryType as MnemopiMemoryType } from "@oh-my-pi/pi-mnemopi/core/typed-memory";

const MAX_TITLE_CHARS = 240;
const MAX_P1_TOKENS = 2_048;
const MAX_P2_TOKENS = 4_096;
const MAX_P3_TOKENS = 8_192;
const MEMORY_TYPES = new Set<string>(Object.values(MemoryType));
const FACT_SCOPES = new Set(["session", "project", "user"]);

export interface ParsedHistorianCompartment {
	readonly startTag: number;
	readonly endTag: number;
	readonly title: string;
	readonly p1: string;
	readonly p2: string;
	readonly p3: string;
	readonly startDate: string;
	readonly endDate: string;
}

export interface ParsedHistorianFact {
	readonly text: string;
	readonly type: MnemopiMemoryType;
	readonly confidence: number;
	readonly scope: "session" | "project" | "user";
	readonly sourceTags: readonly number[];
}

export interface ParsedHistorianOutput {
	readonly compartments: readonly ParsedHistorianCompartment[];
	readonly facts: readonly ParsedHistorianFact[];
}

export interface ParsedHistorianEditorCompartment {
	readonly index: number;
	readonly title: string;
	readonly p1: string;
	readonly p2: string;
	readonly p3: string;
}

export class HistorianValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HistorianValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
	const allowed = new Set(keys);
	const unexpected = Object.keys(record).filter(key => !allowed.has(key));
	if (unexpected.length > 0)
		throw new HistorianValidationError(`${label} has unexpected keys: ${unexpected.join(", ")}`);
	const missing = keys.filter(key => !Object.hasOwn(record, key));
	if (missing.length > 0) throw new HistorianValidationError(`${label} is missing keys: ${missing.join(", ")}`);
}

function requiredString(value: unknown, label: string, maxChars?: number): string {
	if (typeof value !== "string" || !value.trim())
		throw new HistorianValidationError(`${label} must be non-empty text`);
	const normalized = value.trim();
	if (maxChars !== undefined && normalized.length > maxChars) {
		throw new HistorianValidationError(`${label} exceeds ${maxChars} characters`);
	}
	return normalized;
}

function requiredInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new HistorianValidationError(`${label} must be a positive safe integer`);
	}
	return value as number;
}

function requiredDate(value: unknown, label: string): string {
	const date = requiredString(value, label);
	if (!Number.isFinite(Date.parse(date)))
		throw new HistorianValidationError(`${label} must be an ISO-compatible date`);
	return date;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
	if (text.trim() !== text || !text.startsWith("{") || !text.endsWith("}")) {
		throw new HistorianValidationError(`${label} must be a bare JSON object with no surrounding text`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new HistorianValidationError(
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed)) throw new HistorianValidationError(`${label} must be a JSON object`);
	return parsed;
}

function validateTierLengths(compartment: ParsedHistorianCompartment, label: string): void {
	const p1Tokens = countTokens(compartment.p1);
	const p2Tokens = countTokens(compartment.p2);
	const p3Tokens = countTokens(compartment.p3);
	if (p1Tokens > MAX_P1_TOKENS) throw new HistorianValidationError(`${label}.p1 exceeds ${MAX_P1_TOKENS} tokens`);
	if (p2Tokens > MAX_P2_TOKENS) throw new HistorianValidationError(`${label}.p2 exceeds ${MAX_P2_TOKENS} tokens`);
	if (p3Tokens > MAX_P3_TOKENS) throw new HistorianValidationError(`${label}.p3 exceeds ${MAX_P3_TOKENS} tokens`);
	if (p1Tokens > p2Tokens) throw new HistorianValidationError(`${label}.p1 must not exceed p2`);
	if (p2Tokens > p3Tokens) throw new HistorianValidationError(`${label}.p2 must not exceed p3`);
}

function parseCompartment(value: unknown, index: number): ParsedHistorianCompartment {
	const label = `compartments[${index}]`;
	if (!isRecord(value)) throw new HistorianValidationError(`${label} must be an object`);
	assertOnlyKeys(value, ["startTag", "endTag", "title", "p1", "p2", "p3", "startDate", "endDate"], label);
	const compartment: ParsedHistorianCompartment = {
		startTag: requiredInteger(value.startTag, `${label}.startTag`),
		endTag: requiredInteger(value.endTag, `${label}.endTag`),
		title: requiredString(value.title, `${label}.title`, MAX_TITLE_CHARS),
		p1: requiredString(value.p1, `${label}.p1`),
		p2: requiredString(value.p2, `${label}.p2`),
		p3: requiredString(value.p3, `${label}.p3`),
		startDate: requiredDate(value.startDate, `${label}.startDate`),
		endDate: requiredDate(value.endDate, `${label}.endDate`),
	};
	if (compartment.endTag < compartment.startTag) {
		throw new HistorianValidationError(`${label} has descending tag range`);
	}
	validateTierLengths(compartment, label);
	return compartment;
}

function parseFact(value: unknown, index: number): ParsedHistorianFact {
	const label = `facts[${index}]`;
	if (!isRecord(value)) throw new HistorianValidationError(`${label} must be an object`);
	assertOnlyKeys(value, ["text", "type", "confidence", "scope", "sourceTags"], label);
	const type = requiredString(value.type, `${label}.type`);
	if (!MEMORY_TYPES.has(type)) throw new HistorianValidationError(`${label}.type is unsupported: ${type}`);
	const scope = requiredString(value.scope, `${label}.scope`);
	if (!FACT_SCOPES.has(scope)) throw new HistorianValidationError(`${label}.scope is unsupported: ${scope}`);
	if (
		typeof value.confidence !== "number" ||
		!Number.isFinite(value.confidence) ||
		value.confidence < 0 ||
		value.confidence > 1
	) {
		throw new HistorianValidationError(`${label}.confidence must be between 0 and 1`);
	}
	if (!Array.isArray(value.sourceTags) || value.sourceTags.length === 0) {
		throw new HistorianValidationError(`${label}.sourceTags must be a non-empty array`);
	}
	const sourceTags = [
		...new Set(value.sourceTags.map((tag, tagIndex) => requiredInteger(tag, `${label}.sourceTags[${tagIndex}]`))),
	];
	return {
		text: requiredString(value.text, `${label}.text`),
		type: type as MnemopiMemoryType,
		confidence: value.confidence,
		scope: scope as ParsedHistorianFact["scope"],
		sourceTags,
	};
}

export function parseHistorianOutput(text: string, tagSequence: readonly number[]): ParsedHistorianOutput {
	const root = parseJsonObject(text, "Historian output");
	assertOnlyKeys(root, ["compartments", "facts"], "Historian output");
	if (!Array.isArray(root.compartments) || root.compartments.length === 0) {
		throw new HistorianValidationError("Historian output must contain at least one compartment");
	}
	if (!Array.isArray(root.facts)) throw new HistorianValidationError("Historian facts must be an array");
	if (tagSequence.length === 0) throw new HistorianValidationError("Historian source tag sequence is empty");
	const compartments = root.compartments.map(parseCompartment);
	const positionByTag = new Map(tagSequence.map((tag, index) => [tag, index]));
	let expectedPosition = 0;
	for (const [index, compartment] of compartments.entries()) {
		const startPosition = positionByTag.get(compartment.startTag);
		const endPosition = positionByTag.get(compartment.endTag);
		if (startPosition === undefined || endPosition === undefined) {
			throw new HistorianValidationError(`compartments[${index}] references tags outside the source chunk`);
		}
		if (startPosition !== expectedPosition || endPosition < startPosition) {
			throw new HistorianValidationError(`compartments[${index}] is not contiguous with the preceding source range`);
		}
		expectedPosition = endPosition + 1;
	}
	if (expectedPosition !== tagSequence.length) {
		throw new HistorianValidationError(
			`Historian compartments leave ${tagSequence.length - expectedPosition} source tags uncovered`,
		);
	}
	const tagSet = new Set(tagSequence);
	const facts = root.facts.map(parseFact);
	for (const [index, fact] of facts.entries()) {
		if (fact.sourceTags.some(tag => !tagSet.has(tag))) {
			throw new HistorianValidationError(`facts[${index}] cites a tag outside the source chunk`);
		}
	}
	return { compartments, facts };
}

export function parseHistorianEditorOutput(
	text: string,
	original: ParsedHistorianOutput,
): readonly ParsedHistorianEditorCompartment[] {
	const root = parseJsonObject(text, "Historian editor output");
	assertOnlyKeys(root, ["compartments"], "Historian editor output");
	if (!Array.isArray(root.compartments) || root.compartments.length !== original.compartments.length) {
		throw new HistorianValidationError("Historian editor must return exactly one item per compartment");
	}
	return root.compartments.map((value, index) => {
		const label = `compartments[${index}]`;
		if (!isRecord(value)) throw new HistorianValidationError(`${label} must be an object`);
		assertOnlyKeys(value, ["index", "title", "p1", "p2", "p3"], label);
		if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) {
			throw new HistorianValidationError(`${label}.index must be a non-negative safe integer`);
		}
		const item: ParsedHistorianEditorCompartment = {
			index: value.index as number,
			title: requiredString(value.title, `${label}.title`, MAX_TITLE_CHARS),
			p1: requiredString(value.p1, `${label}.p1`),
			p2: requiredString(value.p2, `${label}.p2`),
			p3: requiredString(value.p3, `${label}.p3`),
		};
		if (item.index !== index) throw new HistorianValidationError(`${label}.index must equal ${index}`);
		validateTierLengths(
			{
				...original.compartments[index],
				title: item.title,
				p1: item.p1,
				p2: item.p2,
				p3: item.p3,
			},
			label,
		);
		return item;
	});
}
