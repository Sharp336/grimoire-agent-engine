import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionJsonValue } from "./session-host";

export const MAX_SEMANTIC_CONTENT_BYTES = 262_144;
export const MAX_SEMANTIC_BLOCKS = 256;
export const MAX_SEMANTIC_TREE_DEPTH = 16;
const MAX_SEMANTIC_STRING_LENGTH = 65_536;
const MAX_SEMANTIC_COLLECTION_ITEMS = 2_048;
const MAX_SEMANTIC_TABLE_COLUMNS = 64;
const MAX_SEMANTIC_ACTIONS = 64;
const MAX_SEMANTIC_FORM_OPTIONS = 128;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type SemanticScalar = string | number | boolean | null;

export interface SemanticContentFallback {
	format: "plain" | "markdown";
	text: string;
}

export interface SemanticTextBlock {
	kind: "text";
	format: "plain" | "markdown";
	text: string;
}

export interface SemanticFieldsBlock {
	kind: "fields";
	fields: Array<{ label: string; value: SemanticScalar }>;
}

export interface SemanticTableBlock {
	kind: "table";
	columns: Array<{ id: string; label: string }>;
	rows: Array<Record<string, SemanticScalar>>;
}

export interface SemanticTreeNode {
	id: string;
	label: string;
	description?: string;
	children?: SemanticTreeNode[];
}

export interface SemanticTreeBlock {
	kind: "tree";
	nodes: SemanticTreeNode[];
}

export interface SemanticDiffBlock {
	kind: "diff";
	files: Array<{ path: string; patch: string; language?: string }>;
}

export interface SemanticFileBlock {
	kind: "file";
	path: string;
	location?: {
		line?: number;
		column?: number;
		endLine?: number;
		endColumn?: number;
	};
}

export interface SemanticProgressBlock {
	kind: "progress";
	label: string;
	completed?: number;
	total?: number;
	state: "pending" | "running" | "completed" | "failed" | "cancelled";
}

export interface SemanticFormField {
	id: string;
	label: string;
	control: "input" | "textarea" | "select" | "checkbox";
	placeholder?: string;
	required?: boolean;
	options?: string[];
}

export interface SemanticFormBlock {
	kind: "form";
	formId: string;
	fields: SemanticFormField[];
}

export interface SemanticAction {
	id: string;
	label: string;
	style?: "primary" | "secondary" | "danger";
	disabled?: boolean;
}

export interface SemanticActionsBlock {
	kind: "actions";
	actions: SemanticAction[];
}

export interface SemanticArtifactBlock {
	kind: "artifact";
	artifactId: string;
	label: string;
	mediaType?: string;
}

export interface SemanticToolBlock {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	state: "pending" | "running" | "completed" | "failed" | "cancelled";
	arguments?: SessionJsonValue;
	result?: SessionJsonValue;
}

export type SemanticContentBlock =
	| SemanticTextBlock
	| SemanticFieldsBlock
	| SemanticTableBlock
	| SemanticTreeBlock
	| SemanticDiffBlock
	| SemanticFileBlock
	| SemanticProgressBlock
	| SemanticFormBlock
	| SemanticActionsBlock
	| SemanticArtifactBlock
	| SemanticToolBlock;

export interface SemanticContent {
	version: 1;
	fallback: SemanticContentFallback;
	blocks: SemanticContentBlock[];
}

export interface SemanticActionContext {
	renderId: string;
	actionId: string;
	requestId: string;
	input: Record<string, SessionJsonValue> | undefined;
	signal: AbortSignal;
}

export type SemanticActionHandler = (
	context: SemanticActionContext,
) => Promise<SemanticContent | undefined> | SemanticContent | undefined;

export interface SemanticRenderResult {
	content: SemanticContent;
	actions?: ReadonlyMap<string, SemanticActionHandler>;
}

function supportsSemanticBlock(block: SemanticContentBlock, supported: ReadonlySet<string>): boolean {
	if (block.kind !== "text") return supported.has(block.kind);
	return supported.has("text") && (block.format === "plain" || supported.has("markdown"));
}

/** Removes content kinds the host did not negotiate and makes every removal explicit in the fallback. */
export function adaptSemanticRenderResultToHost(
	result: SemanticRenderResult,
	supported: ReadonlySet<string>,
): SemanticRenderResult {
	const unsupported = new Set<string>();
	const blocks = result.content.blocks.filter(block => {
		if (supportsSemanticBlock(block, supported)) return true;
		unsupported.add(block.kind === "text" && block.format === "markdown" ? "markdown" : block.kind);
		return false;
	});
	if (unsupported.size === 0) return result;
	const unsupportedList = Array.from(unsupported).sort().join(", ");
	return {
		content: {
			version: 1,
			fallback: {
				...result.content.fallback,
				text: `${result.content.fallback.text}\nUnsupported semantic elements: ${unsupportedList}`,
			},
			blocks,
		},
		...(unsupported.has("actions") || result.actions === undefined ? {} : { actions: result.actions }),
	};
}

export type SemanticContentValidation =
	| { ok: true; content: SemanticContent }
	| {
			ok: false;
			code:
				| "invalid_semantic_content"
				| "unknown_semantic_element"
				| "semantic_depth_exceeded"
				| "semantic_size_exceeded";
			error: string;
	  };

function validString(value: unknown, allowEmpty = false): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		value.length <= MAX_SEMANTIC_STRING_LENGTH &&
		!UNSAFE_CONTROL_CHARACTERS.test(value)
	);
}

function validFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function validPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function validScalar(value: unknown): value is SemanticScalar {
	return value === null || typeof value === "boolean" || validFiniteNumber(value) || validString(value, true);
}

function validJsonValue(value: unknown, depth = 0): value is SessionJsonValue {
	if (depth > MAX_SEMANTIC_TREE_DEPTH) return false;
	if (validScalar(value)) return true;
	if (Array.isArray(value)) {
		return value.length <= MAX_SEMANTIC_COLLECTION_ITEMS && value.every(item => validJsonValue(item, depth + 1));
	}
	if (!isRecord(value) || Object.keys(value).length > MAX_SEMANTIC_COLLECTION_ITEMS) return false;
	return Object.entries(value).every(([key, item]) => validString(key) && validJsonValue(item, depth + 1));
}

function validFallback(value: unknown): value is SemanticContentFallback {
	return isRecord(value) && (value.format === "plain" || value.format === "markdown") && validString(value.text, true);
}

function validFields(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= MAX_SEMANTIC_COLLECTION_ITEMS &&
		value.every(field => isRecord(field) && validString(field.label) && validScalar(field.value))
	);
}

function validTable(block: Record<string, unknown>): boolean {
	if (!Array.isArray(block.columns) || block.columns.length > MAX_SEMANTIC_TABLE_COLUMNS) return false;
	const columnIds = new Set<string>();
	for (const column of block.columns) {
		if (!isRecord(column) || !validString(column.id) || !validString(column.label) || columnIds.has(column.id))
			return false;
		columnIds.add(column.id);
	}
	if (!Array.isArray(block.rows) || block.rows.length > MAX_SEMANTIC_COLLECTION_ITEMS) return false;
	return block.rows.every(row => {
		if (!isRecord(row)) return false;
		return Object.entries(row).every(([key, value]) => columnIds.has(key) && validScalar(value));
	});
}

function validTreeNode(
	value: unknown,
	depth: number,
	seenIds: Set<string>,
	count: { value: number },
): SemanticContentValidation | undefined {
	if (depth > MAX_SEMANTIC_TREE_DEPTH) {
		return {
			ok: false,
			code: "semantic_depth_exceeded",
			error: `Semantic tree depth exceeds ${MAX_SEMANTIC_TREE_DEPTH}`,
		};
	}
	if (!isRecord(value) || !validString(value.id) || !validString(value.label)) {
		return { ok: false, code: "invalid_semantic_content", error: "Semantic tree nodes require string id and label" };
	}
	if (seenIds.has(value.id)) {
		return { ok: false, code: "invalid_semantic_content", error: `Duplicate semantic tree node id: ${value.id}` };
	}
	seenIds.add(value.id);
	count.value++;
	if (count.value > MAX_SEMANTIC_COLLECTION_ITEMS) {
		return { ok: false, code: "invalid_semantic_content", error: "Semantic tree contains too many nodes" };
	}
	if (value.description !== undefined && !validString(value.description, true)) {
		return { ok: false, code: "invalid_semantic_content", error: "Semantic tree description is invalid" };
	}
	if (value.children === undefined) return undefined;
	if (!Array.isArray(value.children)) {
		return { ok: false, code: "invalid_semantic_content", error: "Semantic tree children must be an array" };
	}
	for (const child of value.children) {
		const invalid = validTreeNode(child, depth + 1, seenIds, count);
		if (invalid) return invalid;
	}
	return undefined;
}

function validDiff(block: Record<string, unknown>): boolean {
	return (
		Array.isArray(block.files) &&
		block.files.length <= MAX_SEMANTIC_COLLECTION_ITEMS &&
		block.files.every(
			file =>
				isRecord(file) &&
				validString(file.path) &&
				validString(file.patch, true) &&
				(file.language === undefined || validString(file.language)),
		)
	);
}

function validLocation(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	return [value.line, value.column, value.endLine, value.endColumn].every(
		coordinate => coordinate === undefined || validPositiveInteger(coordinate),
	);
}

function validProgress(block: Record<string, unknown>): boolean {
	if (!validString(block.label)) return false;
	if (block.completed !== undefined && (!validFiniteNumber(block.completed) || block.completed < 0)) return false;
	if (block.total !== undefined && (!validFiniteNumber(block.total) || block.total < 0)) return false;
	return ["pending", "running", "completed", "failed", "cancelled"].includes(String(block.state));
}

function validForm(block: Record<string, unknown>): boolean {
	if (
		!validString(block.formId) ||
		!Array.isArray(block.fields) ||
		block.fields.length > MAX_SEMANTIC_COLLECTION_ITEMS
	)
		return false;
	const ids = new Set<string>();
	for (const field of block.fields) {
		if (
			!isRecord(field) ||
			!validString(field.id) ||
			!validString(field.label) ||
			!["input", "textarea", "select", "checkbox"].includes(String(field.control)) ||
			ids.has(field.id) ||
			(field.placeholder !== undefined && !validString(field.placeholder, true)) ||
			(field.required !== undefined && typeof field.required !== "boolean")
		) {
			return false;
		}
		ids.add(field.id);
		if (field.options !== undefined) {
			if (
				!Array.isArray(field.options) ||
				field.options.length > MAX_SEMANTIC_FORM_OPTIONS ||
				!field.options.every(option => validString(option))
			) {
				return false;
			}
		}
		if (field.control === "select" && !Array.isArray(field.options)) return false;
	}
	return true;
}

function validActions(block: Record<string, unknown>): boolean {
	if (!Array.isArray(block.actions) || block.actions.length > MAX_SEMANTIC_ACTIONS) return false;
	const ids = new Set<string>();
	for (const action of block.actions) {
		if (
			!isRecord(action) ||
			!validString(action.id) ||
			!validString(action.label) ||
			ids.has(action.id) ||
			(action.style !== undefined && !["primary", "secondary", "danger"].includes(String(action.style))) ||
			(action.disabled !== undefined && typeof action.disabled !== "boolean")
		) {
			return false;
		}
		ids.add(action.id);
	}
	return true;
}

function validateBlock(block: unknown): SemanticContentValidation | undefined {
	if (!isRecord(block) || !validString(block.kind)) {
		return { ok: false, code: "invalid_semantic_content", error: "Semantic blocks require a kind" };
	}
	switch (block.kind) {
		case "text":
			if ((block.format === "plain" || block.format === "markdown") && validString(block.text, true))
				return undefined;
			break;
		case "fields":
			if (validFields(block.fields)) return undefined;
			break;
		case "table":
			if (validTable(block)) return undefined;
			break;
		case "tree": {
			if (!Array.isArray(block.nodes)) break;
			const ids = new Set<string>();
			const count = { value: 0 };
			for (const node of block.nodes) {
				const invalid = validTreeNode(node, 1, ids, count);
				if (invalid) return invalid;
			}
			return undefined;
		}
		case "diff":
			if (validDiff(block)) return undefined;
			break;
		case "file":
			if (validString(block.path) && validLocation(block.location)) return undefined;
			break;
		case "progress":
			if (validProgress(block)) return undefined;
			break;
		case "form":
			if (validForm(block)) return undefined;
			break;
		case "actions":
			if (validActions(block)) return undefined;
			break;
		case "artifact":
			if (
				validString(block.artifactId) &&
				validString(block.label) &&
				(block.mediaType === undefined || validString(block.mediaType))
			) {
				return undefined;
			}
			break;
		case "tool":
			if (
				validString(block.toolCallId) &&
				validString(block.toolName) &&
				["pending", "running", "completed", "failed", "cancelled"].includes(String(block.state)) &&
				(block.arguments === undefined || validJsonValue(block.arguments)) &&
				(block.result === undefined || validJsonValue(block.result))
			) {
				return undefined;
			}
			break;
		default:
			return {
				ok: false,
				code: "unknown_semantic_element",
				error: `Unknown semantic element kind: ${block.kind}`,
			};
	}
	return { ok: false, code: "invalid_semantic_content", error: `Invalid semantic ${block.kind} block` };
}

export function validateSemanticContent(value: unknown): SemanticContentValidation {
	let encoded: string;
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			return { ok: false, code: "invalid_semantic_content", error: "Semantic content must be JSON serializable" };
		}
		encoded = serialized;
	} catch {
		return { ok: false, code: "invalid_semantic_content", error: "Semantic content must be JSON serializable" };
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_SEMANTIC_CONTENT_BYTES) {
		return {
			ok: false,
			code: "semantic_size_exceeded",
			error: `Semantic content exceeds ${MAX_SEMANTIC_CONTENT_BYTES} bytes`,
		};
	}
	if (!isRecord(value) || value.version !== 1 || !validFallback(value.fallback) || !Array.isArray(value.blocks)) {
		return {
			ok: false,
			code: "invalid_semantic_content",
			error: "Semantic content requires version, fallback, and blocks",
		};
	}
	if (value.blocks.length > MAX_SEMANTIC_BLOCKS) {
		return {
			ok: false,
			code: "invalid_semantic_content",
			error: `Semantic content exceeds ${MAX_SEMANTIC_BLOCKS} blocks`,
		};
	}
	for (const block of value.blocks) {
		const invalid = validateBlock(block);
		if (invalid) return invalid;
	}
	return { ok: true, content: value as unknown as SemanticContent };
}

/** Reads only the mandatory fallback, so newer block kinds remain safe for older clients. */
export function getSemanticContentFallback(value: unknown): SemanticContentFallback | undefined {
	if (!isRecord(value) || value.version !== 1 || !validFallback(value.fallback)) return undefined;
	return value.fallback;
}
