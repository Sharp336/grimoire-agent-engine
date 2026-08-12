import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { MAX_ARTIFACT_RANGE_BYTES } from "../../session/artifacts";
import { isTodoOperationInput, isTodoPhase } from "../../tools/todo";
import { sanitizeExternalToolText } from "../../tools/xdev";
import {
	RPC_EVENT_TYPES,
	RPC_EXTENSION_UI_METHODS,
	type RpcCapabilityDisabledReason,
	type RpcCapabilityManifest,
	type RpcCommand,
	type RpcCommandCapability,
	type RpcCommandConcurrencyClass,
	type RpcCommandConfirmation,
	type RpcCommandExecution,
	type RpcCommandSchedulingClass,
	type RpcCommandScope,
	type RpcCommandType,
	type RpcInputSchema,
	type RpcJsonValue,
} from "./rpc-types";

export const RPC_APPLICATION_API_VERSION = 3;

interface RpcFieldDefinition {
	optional: boolean;
	expected: string;
	schema: Readonly<Record<string, unknown>>;
	validate(value: unknown): boolean;
}

export interface RpcCapabilityContext {
	features?: ReadonlySet<string>;
	/** Whether the current session can project a bounded authoritative tool inventory. */
	toolInventoryAvailable?: boolean;
}

type RpcCommandAvailabilityResult =
	| { availability: "available" | "conditional"; disabledReason?: never }
	| { availability: "unavailable"; disabledReason: RpcCapabilityDisabledReason };

interface RpcCommandMetadata {
	version: number;
	idRequired: boolean;
	scope: RpcCommandScope;
	execution: RpcCommandExecution;
	concurrencyClass?: RpcCommandConcurrencyClass;
	confirmation: RpcCommandConfirmation;
	requiredFeatures: readonly string[];
	availability(context: RpcCapabilityContext): RpcCommandAvailabilityResult;
	outputSchema?: RpcInputSchema;
}

interface RpcCommandDefinition<TCommand extends RpcCommand = RpcCommand> extends RpcCommandMetadata {
	scheduling: RpcCommandSchedulingClass;
	fields: Readonly<Record<string, RpcFieldDefinition>>;
	example: TCommand;
}

type RpcCommandDefinitions = {
	[TType in RpcCommandType]: RpcCommandDefinition<Extract<RpcCommand, { type: TType }>>;
};

function required(
	expected: string,
	validate: (value: unknown) => boolean,
	schema: Readonly<Record<string, unknown>> = { description: expected },
): RpcFieldDefinition {
	return { optional: false, expected, schema, validate };
}

function optional(
	expected: string,
	validate: (value: unknown) => boolean,
	schema: Readonly<Record<string, unknown>> = { description: expected },
): RpcFieldDefinition {
	return { optional: true, expected, schema, validate: value => value === null || validate(value) };
}

const stringField = required("a string", value => typeof value === "string", { type: "string" });
const booleanField = required("a boolean", value => typeof value === "boolean", { type: "boolean" });
const boundedStringField = (name: string, maxLength: number): RpcFieldDefinition =>
	required(name, value => typeof value === "string" && value.length <= maxLength, {
		type: "string",
		maxLength,
	});
const optionalBoundedStringField = (name: string, maxLength: number): RpcFieldDefinition =>
	optional(name, value => typeof value === "string" && value.length <= maxLength, {
		type: ["string", "null"],
		maxLength,
	});
const optionalStringField = optional("a string", value => typeof value === "string", {
	type: ["string", "null"],
});
const optionalBooleanField = optional("a boolean", value => typeof value === "boolean", {
	type: ["boolean", "null"],
});
const releaseTombstoneField = optional("a boolean (defaults to false)", value => typeof value === "boolean", {
	type: ["boolean", "null"],
	default: false,
});
const agentIdField = required(
	"a non-empty agent id of at most 256 UTF-8 bytes",
	value => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 256,
	{ type: "string", minLength: 1, maxLength: 256, "x-maxUtf8Bytes": 256 },
);
const optionalAgentIdField = optional(
	"a non-empty agent or message id of at most 256 UTF-8 bytes",
	value => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 256,
	{ type: ["string", "null"], minLength: 1, maxLength: 256, "x-maxUtf8Bytes": 256 },
);
const agentMessageField = required(
	"a non-empty message of at most 65536 UTF-8 bytes",
	value => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 65_536,
	{ type: "string", minLength: 1, maxLength: 65_536, "x-maxUtf8Bytes": 65_536 },
);
const optionalObjectArrayField = optional(
	"an array of objects",
	value => Array.isArray(value) && value.every(item => isRecord(item)),
	{ type: ["array", "null"], items: { type: "object" } },
);
const nonNegativeIntegerField = optional(
	"a non-negative integer",
	value => Number.isSafeInteger(value) && Number(value) >= 0,
	{ type: ["integer", "null"], minimum: 0 },
);
const positiveIntegerField = optional("a positive integer", value => Number.isSafeInteger(value) && Number(value) > 0, {
	type: ["integer", "null"],
	minimum: 1,
});
const loopActionField = optional(
	"a loop action",
	value => value === "prompt" || value === "compact" || value === "reset",
	{ type: ["string", "null"], enum: ["prompt", "compact", "reset", null] },
);
const loopLimitField = optional(
	"a positive iteration or duration loop limit",
	value =>
		isRecord(value) &&
		((value.kind === "iterations" && Number.isSafeInteger(value.iterations) && Number(value.iterations) > 0) ||
			(value.kind === "duration" && Number.isSafeInteger(value.durationMs) && Number(value.durationMs) > 0)),
	{
		oneOf: [
			{
				type: "object",
				properties: { kind: { const: "iterations" }, iterations: { type: "integer", minimum: 1 } },
				required: ["kind", "iterations"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: { kind: { const: "duration" }, durationMs: { type: "integer", minimum: 1 } },
				required: ["kind", "durationMs"],
				additionalProperties: false,
			},
			{ type: "null" },
		],
	},
);
const optionalIntegerField = optional("an integer", value => Number.isSafeInteger(value), {
	type: ["integer", "null"],
});
const optionalBoundedPositiveIntegerField = (maximum: number): RpcFieldDefinition =>
	optional(
		`a positive integer no greater than ${maximum}`,
		value => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum,
		{ type: ["integer", "null"], minimum: 1, maximum },
	);
const optionalBoundedNonNegativeIntegerField = (maximum: number): RpcFieldDefinition =>
	optional(
		`a non-negative integer no greater than ${maximum}`,
		value => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum,
		{ type: ["integer", "null"], minimum: 0, maximum },
	);
const requiredNonNegativeIntegerField = required(
	"a non-negative integer",
	value => Number.isSafeInteger(value) && Number(value) >= 0,
	{ type: "integer", minimum: 0 },
);

const MAX_OPAQUE_ID_BYTES = 256;
export const MAX_RPC_CONTEXT_SOURCES = 4096;
export const MAX_RPC_CONTEXT_RELATIONS = 8192;
export const MAX_RPC_CONTEXT_CONTENT_BYTES = 512 * 1024;
const opaqueIdField = required(
	`a non-empty opaque id of at most ${MAX_OPAQUE_ID_BYTES} UTF-8 bytes`,
	value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_OPAQUE_ID_BYTES,
	{ type: "string", minLength: 1, maxLength: MAX_OPAQUE_ID_BYTES, "x-maxUtf8Bytes": MAX_OPAQUE_ID_BYTES },
);
const optionalOpaqueIdField = optional(
	`a non-empty opaque id of at most ${MAX_OPAQUE_ID_BYTES} UTF-8 bytes`,
	value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_OPAQUE_ID_BYTES,
	{ type: ["string", "null"], minLength: 1, maxLength: MAX_OPAQUE_ID_BYTES, "x-maxUtf8Bytes": MAX_OPAQUE_ID_BYTES },
);
const artifactIdField = required("a numeric artifact id", value => typeof value === "string" && /^\d+$/.test(value), {
	type: "string",
	pattern: "^\\d+$",
});
const artifactDestinationField = required(
	"a non-empty artifact export path of at most 4096 UTF-8 bytes",
	value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 4096,
	{ type: "string", minLength: 1, maxLength: 4096, "x-maxUtf8Bytes": 4096 },
);
const artifactSha256Field = required(
	"a lowercase SHA-256 digest",
	value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
	{ type: "string", pattern: "^[a-f0-9]{64}$" },
);
const queueIndexField = required("a non-negative integer", value => Number.isSafeInteger(value) && Number(value) >= 0, {
	type: "integer",
	minimum: 0,
});
const jobIdArrayField = required(
	"an array of 1 to 64 unique opaque job ids",
	value =>
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= 64 &&
		new Set(value).size === value.length &&
		value.every(
			id => typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= MAX_OPAQUE_ID_BYTES,
		),
	{
		type: "array",
		minItems: 1,
		maxItems: 64,
		uniqueItems: true,
		items: {
			type: "string",
			minLength: 1,
			maxLength: MAX_OPAQUE_ID_BYTES,
			"x-maxUtf8Bytes": MAX_OPAQUE_ID_BYTES,
		},
	},
);
const MAX_TOOL_ACTIVATION_NAMES = 2048;
const MAX_TOOL_ACTIVATION_NAME_BYTES = 256;
const optionalToolNameArrayField: RpcFieldDefinition = {
	optional: true,
	expected: `an array of at most ${MAX_TOOL_ACTIVATION_NAMES} safe tool names`,
	schema: {
		type: "array",
		items: {
			type: "string",
			minLength: 1,
			maxLength: MAX_TOOL_ACTIVATION_NAME_BYTES,
			"x-maxUtf8Bytes": MAX_TOOL_ACTIVATION_NAME_BYTES,
		},
		maxItems: MAX_TOOL_ACTIVATION_NAMES,
	},
	validate: value =>
		Array.isArray(value) &&
		value.length <= MAX_TOOL_ACTIVATION_NAMES &&
		value.every(
			name =>
				typeof name === "string" &&
				name.length > 0 &&
				Buffer.byteLength(name, "utf8") <= MAX_TOOL_ACTIVATION_NAME_BYTES &&
				sanitizeExternalToolText(name) === name,
		),
};
export class RpcToolActivationValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcToolActivationValidationError";
	}
}

export function validateRpcToolActivationBatch(
	command: Extract<RpcCommand, { type: "set_tool_activation" }>,
	allToolNames: readonly string[],
): { activate: string[]; deactivate: string[] } {
	const activate = command.activate ?? [];
	const deactivate = command.deactivate ?? [];
	const validName = (name: unknown): name is string =>
		typeof name === "string" &&
		name.length > 0 &&
		Buffer.byteLength(name, "utf8") <= MAX_TOOL_ACTIVATION_NAME_BYTES &&
		sanitizeExternalToolText(name) === name;
	if (
		activate.length > MAX_TOOL_ACTIVATION_NAMES ||
		deactivate.length > MAX_TOOL_ACTIVATION_NAMES ||
		!activate.every(validName) ||
		!deactivate.every(validName)
	) {
		throw new RpcToolActivationValidationError(
			`Tool activation lists must contain at most ${MAX_TOOL_ACTIVATION_NAMES} safe names of at most ${MAX_TOOL_ACTIVATION_NAME_BYTES} bytes`,
		);
	}
	if (activate.length === 0 && deactivate.length === 0) {
		throw new RpcToolActivationValidationError(
			"Tool activation request must activate or deactivate at least one tool",
		);
	}
	if (new Set(activate).size !== activate.length) {
		throw new RpcToolActivationValidationError("Tool activation request contains duplicate activate names");
	}
	if (new Set(deactivate).size !== deactivate.length) {
		throw new RpcToolActivationValidationError("Tool activation request contains duplicate deactivate names");
	}
	const deactivateSet = new Set(deactivate);
	const overlap = activate.filter(name => deactivateSet.has(name));
	if (overlap.length > 0) {
		throw new RpcToolActivationValidationError(
			`Tool activation request names cannot be both activated and deactivated: ${overlap.join(", ")}`,
		);
	}
	const registered = new Set(allToolNames);
	const unknown = [...activate, ...deactivate].filter(name => !registered.has(name));
	if (unknown.length > 0) {
		throw new RpcToolActivationValidationError(
			`Tool activation request contains unregistered names: ${unknown.join(", ")}`,
		);
	}
	return { activate: [...activate], deactivate: [...deactivate] };
}

function enumField<const TValue extends string>(...values: readonly TValue[]): RpcFieldDefinition {
	return required(values.map(value => JSON.stringify(value)).join(" or "), value => values.includes(value as TValue), {
		type: "string",
		enum: values,
	});
}

function optionalEnumField<const TValue extends string>(...values: readonly TValue[]): RpcFieldDefinition {
	return optional(values.map(value => JSON.stringify(value)).join(" or "), value => values.includes(value as TValue), {
		type: ["string", "null"],
		enum: [...values, null],
	});
}

function isBoundedStringArray(value: unknown, maxItems: number, maxBytes: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every(item => typeof item === "string" && item.length > 0 && Buffer.byteLength(item, "utf8") <= maxBytes)
	);
}

const semanticProfileField = required(
	"an omp.session semantic profile range",
	value => {
		if (!isRecord(value) || value.name !== "omp.session" || !Number.isSafeInteger(value.major)) return false;
		const allowed = new Set(["name", "major", "minMinor", "maxMinor"]);
		if (Object.keys(value).some(key => !allowed.has(key))) return false;
		return (
			(value.minMinor === undefined || Number.isSafeInteger(value.minMinor)) &&
			(value.maxMinor === undefined || Number.isSafeInteger(value.maxMinor))
		);
	},
	{
		type: "object",
		properties: {
			name: { const: "omp.session" },
			major: { type: "integer", minimum: 1 },
			minMinor: { type: "integer", minimum: 0 },
			maxMinor: { type: "integer", minimum: 0 },
		},
		required: ["name", "major"],
		additionalProperties: false,
	},
);

const hostCapabilitiesField = required(
	"a host capability declaration",
	value => {
		if (!isRecord(value)) return false;
		if (Object.keys(value).some(key => key !== "interactions" && key !== "semanticContent")) return false;
		return (
			isBoundedStringArray(value.interactions, 32, 64) &&
			isBoundedStringArray(value.semanticContent, 32, 64) &&
			new Set(value.interactions).size === value.interactions.length &&
			new Set(value.semanticContent).size === value.semanticContent.length
		);
	},
	{
		type: "object",
		properties: {
			interactions: {
				type: "array",
				maxItems: 32,
				uniqueItems: true,
				items: { type: "string", minLength: 1, maxLength: 64, "x-maxUtf8Bytes": 64 },
			},
			semanticContent: {
				type: "array",
				maxItems: 32,
				uniqueItems: true,
				items: { type: "string", minLength: 1, maxLength: 64, "x-maxUtf8Bytes": 64 },
			},
		},
		required: ["interactions", "semanticContent"],
		additionalProperties: false,
	},
);

const requestedCapabilitiesField = required(
	"an array of at most 256 unique capability ids",
	value => isBoundedStringArray(value, 256, 128) && new Set(value).size === value.length,
	{
		type: "array",
		maxItems: 256,
		uniqueItems: true,
		items: { type: "string", minLength: 1, maxLength: 128, "x-maxUtf8Bytes": 128 },
	},
);

export function isRpcJsonValue(value: unknown, depth = 0): value is RpcJsonValue {
	if (depth > 64) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => isRpcJsonValue(item, depth + 1));
	if (!isRecord(value)) return false;
	return Object.values(value).every(item => isRpcJsonValue(item, depth + 1));
}

const optionalJsonObjectField = optional("a JSON object", value => isRecord(value) && isRpcJsonValue(value), {
	type: ["object", "null"],
});
const uiSubscriptionsField = optional(
	"an RPC UI subscription object",
	value =>
		isRecord(value) &&
		Object.keys(value).every(key => ["editor", "presentation", "theme", "title", "toolsExpanded"].includes(key)) &&
		Object.values(value).every(item => typeof item === "boolean"),
	{
		type: ["object", "null"],
		properties: {
			editor: { type: "boolean" },
			presentation: { type: "boolean" },
			theme: { type: "boolean" },
			title: { type: "boolean" },
			toolsExpanded: { type: "boolean" },
		},
		additionalProperties: false,
	},
);
const uiLinesField = required(
	"an array of at most 10000 editor lines and 1048576 total UTF-8 bytes",
	value =>
		Array.isArray(value) &&
		value.length <= 10_000 &&
		value.every(line => typeof line === "string") &&
		Buffer.byteLength(value.join("\n"), "utf8") <= 1_048_576,
	{
		type: "array",
		maxItems: 10_000,
		items: { type: "string" },
		"x-maxUtf8Bytes": 1_048_576,
	},
);

const observationPositionField = optional(
	"an observation epoch and non-negative sequence",
	value =>
		isRecord(value) &&
		Object.keys(value).every(key => key === "epoch" || key === "sequence") &&
		typeof value.epoch === "string" &&
		value.epoch.length > 0 &&
		Buffer.byteLength(value.epoch, "utf8") <= MAX_OPAQUE_ID_BYTES &&
		Number.isSafeInteger(value.sequence) &&
		Number(value.sequence) >= 0,
	{
		type: ["object", "null"],
		properties: {
			epoch: { type: "string", minLength: 1, maxLength: MAX_OPAQUE_ID_BYTES },
			sequence: { type: "integer", minimum: 0 },
		},
		required: ["epoch", "sequence"],
		additionalProperties: false,
	},
);

const durableCursorField = optional(
	"a durable session journal cursor",
	value =>
		isRecord(value) &&
		Object.keys(value).every(key => key === "sessionId" || key === "leafId" || key === "entryId") &&
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		Buffer.byteLength(value.sessionId, "utf8") <= MAX_OPAQUE_ID_BYTES &&
		(value.leafId === null ||
			(typeof value.leafId === "string" &&
				value.leafId.length > 0 &&
				Buffer.byteLength(value.leafId, "utf8") <= MAX_OPAQUE_ID_BYTES)) &&
		(value.entryId === null ||
			(typeof value.entryId === "string" &&
				value.entryId.length > 0 &&
				Buffer.byteLength(value.entryId, "utf8") <= MAX_OPAQUE_ID_BYTES)),
	{
		type: ["object", "null"],
		properties: {
			sessionId: { type: "string", minLength: 1, maxLength: MAX_OPAQUE_ID_BYTES },
			leafId: { type: ["string", "null"], maxLength: MAX_OPAQUE_ID_BYTES },
			entryId: { type: ["string", "null"], maxLength: MAX_OPAQUE_ID_BYTES },
		},
		required: ["sessionId", "leafId", "entryId"],
		additionalProperties: false,
	},
);

const sessionInvocationField = required(
	"a bounded session command",
	value => {
		if (!isRecord(value)) return false;
		if (Object.keys(value).some(key => !["kind", "input", "expectedRevision", "idempotencyKey"].includes(key))) {
			return false;
		}
		return (
			typeof value.kind === "string" &&
			value.kind.length > 0 &&
			Buffer.byteLength(value.kind, "utf8") <= 128 &&
			(value.input === undefined || (isRecord(value.input) && isRpcJsonValue(value.input))) &&
			(value.expectedRevision === undefined ||
				(Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 0)) &&
			(value.idempotencyKey === undefined ||
				(typeof value.idempotencyKey === "string" &&
					value.idempotencyKey.length > 0 &&
					Buffer.byteLength(value.idempotencyKey, "utf8") <= MAX_OPAQUE_ID_BYTES))
		);
	},
	{
		type: "object",
		properties: {
			kind: { type: "string", minLength: 1, maxLength: 128 },
			input: {},
			expectedRevision: { type: "integer", minimum: 0 },
			idempotencyKey: { type: "string", minLength: 1, maxLength: MAX_OPAQUE_ID_BYTES },
		},
		required: ["kind"],
		additionalProperties: false,
	},
);

const AVAILABLE: RpcCommandAvailabilityResult = { availability: "available" };

function toolInventoryAvailability(context: RpcCapabilityContext): RpcCommandAvailabilityResult {
	if (context.toolInventoryAvailable === false) {
		return {
			availability: "unavailable",
			disabledReason: {
				code: "tool_inventory_unavailable",
				message: "Authoritative tool inventory is not representable within protocol limits",
			},
		};
	}
	return AVAILABLE;
}

function requiresFeature(feature: string): Pick<RpcCommandMetadata, "requiredFeatures" | "availability"> {
	return {
		requiredFeatures: [feature],
		availability: context => ({
			availability: context.features?.has(feature) ? "available" : "conditional",
		}),
	};
}

type RpcCommandMetadataOverrides = Partial<
	Pick<
		RpcCommandMetadata,
		"idRequired" | "version" | "execution" | "confirmation" | "requiredFeatures" | "availability" | "outputSchema"
	>
>;

function classifiedCommand<TCommand extends RpcCommand>(
	scope: RpcCommandScope,
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
): RpcCommandDefinition<TCommand> {
	return {
		version: metadata.version ?? 1,
		idRequired: metadata.idRequired ?? metadata.version === 3,
		scope,
		execution: metadata.execution ?? "sync",
		concurrencyClass: scheduling,
		confirmation: metadata.confirmation ?? "none",
		requiredFeatures: metadata.requiredFeatures ?? [],
		availability: metadata.availability ?? (() => AVAILABLE),
		outputSchema: metadata.outputSchema,
		scheduling,
		fields,
		example,
	};
}

const hostCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("host", example, fields, scheduling, metadata);

const sessionCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("session", example, fields, scheduling, metadata);

const turnCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("turn", example, fields, scheduling, metadata);

const agentCommand = <TCommand extends RpcCommand>(
	example: TCommand,
	fields: Readonly<Record<string, RpcFieldDefinition>> = {},
	scheduling: RpcCommandSchedulingClass = "serial",
	metadata: RpcCommandMetadataOverrides = {},
) => classifiedCommand("agent", example, fields, scheduling, metadata);

export const RPC_COMMAND_DEFINITIONS = {
	negotiate_protocol: hostCommand(
		{ type: "negotiate_protocol", protocolVersion: 2 },
		{ protocolVersion: required("an integer", value => Number.isSafeInteger(value)) },
	),
	get_capabilities: hostCommand({ type: "get_capabilities" }),
	initialize: hostCommand(
		{
			type: "initialize",
			profile: { name: "omp.session", major: 3 },
			framingVersion: 2,
			hostCapabilities: { interactions: [], semanticContent: [] },
			requestedCapabilities: [],
		},
		{
			profile: semanticProfileField,
			framingVersion: required("an integer", value => Number.isSafeInteger(value), { type: "integer" }),
			hostCapabilities: hostCapabilitiesField,
			requestedCapabilities: requestedCapabilitiesField,
		},
	),
	session_open: sessionCommand(
		{ type: "session_open", id: "request-1" },
		{ after: observationPositionField, afterCursor: durableCursorField, snapshot: optionalBooleanField },
		"serial",
		{ version: 3, ...requiresFeature("session-observe") },
	),
	context_get: sessionCommand(
		{
			type: "context_get",
			id: "request-1",
			maxSources: 256,
			maxRelations: 512,
			maxContentBytes: 262_144,
		},
		{
			maxSources: optionalBoundedNonNegativeIntegerField(MAX_RPC_CONTEXT_SOURCES),
			maxRelations: optionalBoundedNonNegativeIntegerField(MAX_RPC_CONTEXT_RELATIONS),
			maxContentBytes: optionalBoundedNonNegativeIntegerField(MAX_RPC_CONTEXT_CONTENT_BYTES),
		},
		"concurrent",
		{ version: 3, ...requiresFeature("context.projection") },
	),
	ui_open: sessionCommand(
		{ type: "ui_open", id: "request-1", terminalId: "terminal-1", width: 100 },
		{
			terminalId: opaqueIdField,
			width: optionalBoundedPositiveIntegerField(240),
			subscriptions: uiSubscriptionsField,
		},
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_close: sessionCommand(
		{ type: "ui_close", id: "request-1", channelId: "channel-1", generation: 1 },
		{ channelId: opaqueIdField, generation: requiredNonNegativeIntegerField },
		"control",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_input: sessionCommand(
		{ type: "ui_input", id: "request-1", channelId: "channel-1", generation: 1, data: "x" },
		{
			channelId: opaqueIdField,
			generation: requiredNonNegativeIntegerField,
			data: boundedStringField("raw input no longer than 65536 characters", 65_536),
		},
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_editor_update: sessionCommand(
		{
			type: "ui_editor_update",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			expectedRevision: 0,
			text: "prompt",
		},
		{
			channelId: opaqueIdField,
			generation: requiredNonNegativeIntegerField,
			expectedRevision: requiredNonNegativeIntegerField,
			text: boundedStringField("editor text no longer than 1048576 characters", 1_048_576),
		},
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_editor_paste: sessionCommand(
		{
			type: "ui_editor_paste",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			expectedRevision: 0,
			text: "pasted text",
		},
		{
			channelId: opaqueIdField,
			generation: requiredNonNegativeIntegerField,
			expectedRevision: requiredNonNegativeIntegerField,
			text: boundedStringField("pasted text no longer than 1048576 characters", 1_048_576),
		},
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_autocomplete_suggest: sessionCommand(
		{
			type: "ui_autocomplete_suggest",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			lines: ["/"],
			cursorLine: 0,
			cursorCol: 1,
		},
		{
			channelId: opaqueIdField,
			generation: requiredNonNegativeIntegerField,
			lines: uiLinesField,
			cursorLine: requiredNonNegativeIntegerField,
			cursorCol: requiredNonNegativeIntegerField,
			forceFile: optionalBooleanField,
		},
		"concurrent",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_autocomplete_apply: sessionCommand(
		{
			type: "ui_autocomplete_apply",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			suggestionId: "suggestion-1",
		},
		{
			channelId: opaqueIdField,
			generation: requiredNonNegativeIntegerField,
			suggestionId: opaqueIdField,
		},
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_cancel: sessionCommand(
		{
			type: "ui_cancel",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			operationId: "operation-1",
		},
		{ channelId: opaqueIdField, generation: requiredNonNegativeIntegerField, operationId: opaqueIdField },
		"control",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_presentation_input: sessionCommand(
		{
			type: "ui_presentation_input",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			presentationId: "presentation-1",
			data: "x",
		},
		{
			channelId: opaqueIdField,
			generation: requiredNonNegativeIntegerField,
			presentationId: opaqueIdField,
			data: boundedStringField("presentation input no longer than 65536 characters", 65_536),
		},
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_presentation_action: sessionCommand(
		{
			type: "ui_presentation_action",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			presentationId: "presentation-1",
			action: "cancel",
		},
		{
			channelId: opaqueIdField,
			generation: requiredNonNegativeIntegerField,
			presentationId: opaqueIdField,
			action: enumField("cancel"),
		},
		"control",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_theme_list: sessionCommand(
		{ type: "ui_theme_list", id: "request-1", channelId: "channel-1", generation: 1 },
		{ channelId: opaqueIdField, generation: requiredNonNegativeIntegerField },
		"concurrent",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_theme_get: sessionCommand(
		{ type: "ui_theme_get", id: "request-1", channelId: "channel-1", generation: 1, name: "dark" },
		{ channelId: opaqueIdField, generation: requiredNonNegativeIntegerField, name: stringField },
		"concurrent",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_theme_set: sessionCommand(
		{ type: "ui_theme_set", id: "request-1", channelId: "channel-1", generation: 1, name: "dark" },
		{ channelId: opaqueIdField, generation: requiredNonNegativeIntegerField, name: stringField },
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_tools_expanded_set: sessionCommand(
		{
			type: "ui_tools_expanded_set",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			expanded: true,
		},
		{ channelId: opaqueIdField, generation: requiredNonNegativeIntegerField, expanded: booleanField },
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	ui_title_subscribe: sessionCommand(
		{
			type: "ui_title_subscribe",
			id: "request-1",
			channelId: "channel-1",
			generation: 1,
			subscribed: true,
		},
		{ channelId: opaqueIdField, generation: requiredNonNegativeIntegerField, subscribed: booleanField },
		"serial",
		{ version: 3, ...requiresFeature("ui") },
	),
	session_ack: sessionCommand(
		{ type: "session_ack", id: "request-1", subscriptionId: "subscription-1", sequence: 0 },
		{ subscriptionId: opaqueIdField, sequence: queueIndexField },
		"control",
		{ version: 3, ...requiresFeature("session-observe") },
	),
	session_unsubscribe: sessionCommand(
		{ type: "session_unsubscribe", id: "request-1", subscriptionId: "subscription-1" },
		{ subscriptionId: opaqueIdField },
		"control",
		{ version: 3, ...requiresFeature("session-observe") },
	),
	session_invoke: sessionCommand(
		{ type: "session_invoke", id: "request-1", command: { kind: "get_state" } },
		{ command: sessionInvocationField },
		"serial",
		{ version: 3, ...requiresFeature("session-execute") },
	),
	session_shutdown: sessionCommand({ type: "session_shutdown", id: "request-1" }, {}, "control", {
		version: 3,
		...requiresFeature("session-shutdown"),
	}),
	semantic_action: sessionCommand(
		{
			type: "semantic_action",
			id: "request-1",
			renderId: "render-1",
			actionId: "apply",
		},
		{
			renderId: opaqueIdField,
			actionId: opaqueIdField,
			input: optionalJsonObjectField,
		},
		"serial",
		{ version: 3, ...requiresFeature("semantic-rendering") },
	),
	semantic_cancel: sessionCommand(
		{ type: "semantic_cancel", id: "request-1", renderId: "render-1" },
		{ renderId: opaqueIdField, actionId: optionalOpaqueIdField },
		"control",
		{ version: 3, ...requiresFeature("semantic-rendering") },
	),
	artifact_describe: sessionCommand(
		{ type: "artifact_describe", id: "request-1", artifactId: "0" },
		{ artifactId: artifactIdField },
		"serial",
		{ version: 3, ...requiresFeature("artifact") },
	),
	artifact_read: sessionCommand(
		{ type: "artifact_read", id: "request-1", artifactId: "0", offset: 0, length: MAX_ARTIFACT_RANGE_BYTES },
		{
			artifactId: artifactIdField,
			offset: nonNegativeIntegerField,
			length: optionalBoundedPositiveIntegerField(MAX_ARTIFACT_RANGE_BYTES),
		},
		"serial",
		{ version: 3, ...requiresFeature("artifact") },
	),
	artifact_export: sessionCommand(
		{
			type: "artifact_export",
			id: "request-1",
			artifactId: "0",
			destination: "output.txt",
			expectedSha256: "0".repeat(64),
		},
		{
			artifactId: artifactIdField,
			destination: artifactDestinationField,
			expectedSha256: artifactSha256Field,
		},
		"serial",
		{ version: 3, ...requiresFeature("artifact") },
	),
	resource_list: sessionCommand({ type: "resource_list", id: "request-1" }, {}, "concurrent", {
		version: 3,
		...requiresFeature("resource-lifecycle"),
	}),
	resource_refresh: sessionCommand(
		{ type: "resource_refresh", id: "request-1", serverId: "resource-server-1" },
		{ serverId: optionalOpaqueIdField },
		"serial",
		{ version: 3, ...requiresFeature("resource-lifecycle") },
	),
	resource_reload: sessionCommand({ type: "resource_reload", id: "request-1" }, {}, "serial", {
		version: 3,
		...requiresFeature("resource-lifecycle"),
	}),
	resource_cancel: sessionCommand(
		{ type: "resource_cancel", id: "request-1", operationId: "resource-operation-1" },
		{ operationId: opaqueIdField },
		"control",
		{ version: 3, ...requiresFeature("resource-lifecycle") },
	),
	resource_dispose: sessionCommand(
		{ type: "resource_dispose", id: "request-1", serverId: "resource-server-1" },
		{ serverId: opaqueIdField },
		"serial",
		{ version: 3, ...requiresFeature("resource-lifecycle") },
	),
	provenance_get: sessionCommand(
		{ type: "provenance_get", id: "request-1", refreshUsage: true },
		{ refreshUsage: optionalBooleanField },
		"concurrent",
		{ version: 3, ...requiresFeature("runtime-provenance") },
	),
	collaboration_get: sessionCommand({ type: "collaboration_get", id: "request-1" }, {}, "concurrent", {
		version: 3,
		...requiresFeature("collaboration"),
	}),
	collaboration_host: sessionCommand(
		{ type: "collaboration_host", id: "request-1", relayUrl: "wss://relay.example", webUrl: "https://example" },
		{
			relayUrl: optionalBoundedStringField("a relay URL of at most 2048 UTF-8 bytes", 2048),
			webUrl: optionalBoundedStringField("a web URL of at most 2048 UTF-8 bytes", 2048),
		},
		"serial",
		{ version: 3, ...requiresFeature("collaboration") },
	),
	collaboration_join: sessionCommand(
		{ type: "collaboration_join", id: "request-1", link: "wss://relay.example/r/room.key", displayName: "guest" },
		{
			link: boundedStringField("a collaboration link of at most 8192 UTF-8 bytes", 8192),
			displayName: optionalBoundedStringField("a display name of at most 256 UTF-8 bytes", 256),
		},
		"serial",
		{ version: 3, ...requiresFeature("collaboration") },
	),
	collaboration_leave: sessionCommand(
		{ type: "collaboration_leave", id: "request-1", reason: "client_requested" },
		{ reason: optionalBoundedStringField("a leave reason of at most 1024 UTF-8 bytes", 1024) },
		"control",
		{ version: 3, ...requiresFeature("collaboration") },
	),
	collaboration_revoke: sessionCommand(
		{ type: "collaboration_revoke", id: "request-1", participantId: "7" },
		{ participantId: opaqueIdField },
		"control",
		{ version: 3, ...requiresFeature("collaboration") },
	),
	collaboration_rotate: sessionCommand({ type: "collaboration_rotate", id: "request-1" }, {}, "control", {
		version: 3,
		...requiresFeature("collaboration"),
	}),
	collaboration_acknowledge: sessionCommand(
		{ type: "collaboration_acknowledge", id: "request-1", generation: 1, sequence: 1 },
		{ generation: requiredNonNegativeIntegerField, sequence: requiredNonNegativeIntegerField },
		"concurrent",
		{ version: 3, ...requiresFeature("collaboration") },
	),
	collaboration_read_media: sessionCommand(
		{ type: "collaboration_read_media", id: "request-1", mediaId: "0", offset: 0, length: MAX_ARTIFACT_RANGE_BYTES },
		{
			mediaId: artifactIdField,
			offset: nonNegativeIntegerField,
			length: optionalBoundedPositiveIntegerField(MAX_ARTIFACT_RANGE_BYTES),
		},
		"concurrent",
		{ version: 3, ...requiresFeature("collaboration") },
	),
	prompt: turnCommand(
		{ type: "prompt", message: "hello" },
		{
			message: stringField,
			images: optionalObjectArrayField,
			streamingBehavior: optionalEnumField("steer", "followUp"),
		},
		"serial",
		{ execution: "operation" },
	),
	steer: turnCommand(
		{ type: "steer", message: "continue" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
	),
	follow_up: turnCommand(
		{ type: "follow_up", message: "then summarize" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
	),
	abort: turnCommand({ type: "abort" }, {}, "control"),
	abort_and_prompt: turnCommand(
		{ type: "abort_and_prompt", message: "try again" },
		{ message: stringField, images: optionalObjectArrayField },
		"control",
		{ execution: "operation" },
	),
	cancel_operation: turnCommand(
		{ type: "cancel_operation", operationId: "operation-1" },
		{ operationId: stringField },
		"control",
	),
	eval_execute: sessionCommand(
		{ type: "eval_execute", language: "py", code: "print('hello')" },
		{
			language: enumField("py", "js", "rb", "jl"),
			code: boundedStringField("code no longer than 262144 characters", 262_144),
			title: optionalBoundedStringField("a title no longer than 512 characters", 512),
			timeout: optionalBoundedPositiveIntegerField(3_600),
			reset: optional("a boolean", value => typeof value === "boolean", { type: ["boolean", "null"] }),
			excludeFromContext: optional("a boolean", value => typeof value === "boolean", {
				type: ["boolean", "null"],
			}),
		},
		"concurrent",
		{
			execution: "operation",
			confirmation: "required",
			outputSchema: {
				type: "object",
				properties: {
					operationId: { type: "string", maxLength: 128 },
					accepted: { const: true },
				},
				required: ["operationId", "accepted"],
				additionalProperties: false,
			},
		},
	),
	get_eval_history: sessionCommand(
		{ type: "get_eval_history" },
		{ limit: optionalBoundedPositiveIntegerField(100) },
		"concurrent",
		{
			outputSchema: {
				type: "object",
				properties: {
					entries: {
						type: "array",
						maxItems: 100,
						items: {
							type: "object",
							properties: {
								language: { enum: ["py", "js", "rb", "jl"] },
								code: { type: "string", maxLength: 262_144 },
								output: { type: "string", maxLength: 262_144 },
								exitCode: { type: "integer" },
								cancelled: { type: "boolean" },
								truncated: { type: "boolean" },
								timestamp: { type: "number" },
								excludeFromContext: { type: "boolean" },
							},
							required: ["language", "code", "output", "cancelled", "truncated", "timestamp"],
							additionalProperties: false,
						},
					},
				},
				required: ["entries"],
				additionalProperties: false,
			},
		},
	),
	set_mode: sessionCommand(
		{ type: "set_mode", mode: "plan" },
		{
			mode: enumField("none", "plan", "plan_paused"),
			planFilePath: optionalStringField,
			workflow: optionalEnumField("parallel", "iterative"),
			when: optionalEnumField("immediate", "next_idle"),
		},
		"serial",
		{ execution: "operation" },
	),
	get_plan: sessionCommand({ type: "get_plan" }, {}, "concurrent"),
	resolve_plan_approval: sessionCommand(
		{ type: "resolve_plan_approval", approvalId: "approval-1", decision: "approve" },
		{
			approvalId: opaqueIdField,
			decision: enumField("approve", "refine", "reject"),
			preserveContext: optionalBooleanField,
			compactBeforeExecute: optionalBooleanField,
			executionModelRole: optionalBoundedStringField("a model role no longer than 256 characters", 256),
			editedContent: optionalBoundedStringField("edited plan content no longer than 1048576 characters", 1_048_576),
			feedback: optionalBoundedStringField("feedback no longer than 65536 characters", 65_536),
		},
		"serial",
		{ execution: "operation" },
	),
	new_session: sessionCommand({ type: "new_session" }, { parentSession: optionalStringField }),
	get_state: sessionCommand({ type: "get_state" }),
	get_operations: sessionCommand({ type: "get_operations" }, {}, "concurrent"),
	get_advisor_state: sessionCommand({ type: "get_advisor_state" }, {}, "concurrent"),
	set_advisor_enabled: sessionCommand({ type: "set_advisor_enabled", enabled: false }, { enabled: booleanField }),
	get_tool_inventory: sessionCommand({ type: "get_tool_inventory" }, {}, "serial", {
		availability: toolInventoryAvailability,
	}),
	set_tool_activation: sessionCommand(
		{ type: "set_tool_activation", activate: ["read"], deactivate: ["bash"] },
		{ activate: optionalToolNameArrayField, deactivate: optionalToolNameArrayField },
	),
	list_provider_auth: sessionCommand({ type: "list_provider_auth" }, {}, "concurrent"),
	begin_provider_auth: sessionCommand(
		{ type: "begin_provider_auth", providerId: "anthropic", method: "oauth_callback" },
		{ providerId: stringField, method: enumField("oauth_callback", "paste_code", "device_code", "api_key") },
		"serial",
		{ execution: "operation" },
	),
	cancel_provider_auth: sessionCommand(
		{ type: "cancel_provider_auth", operationId: "operation-1" },
		{ operationId: opaqueIdField },
		"control",
	),
	remove_provider_auth: sessionCommand(
		{ type: "remove_provider_auth", providerId: "anthropic" },
		{ providerId: stringField },
		"serial",
		{ confirmation: "required" },
	),
	set_fast_mode: sessionCommand(
		{ type: "set_fast_mode", enabled: false },
		{ enabled: booleanField },
		"serial",
		requiresFeature("model.fast-mode"),
	),
	get_available_commands: sessionCommand({ type: "get_available_commands" }),
	get_settings: sessionCommand({ type: "get_settings" }, { tab: optionalStringField }, "concurrent"),
	set_settings: sessionCommand(
		{ type: "set_settings", changes: [{ path: "colorBlindMode", value: true }] },
		{
			changes: required("a nonempty array of at most 100 setting changes", value => Array.isArray(value), {
				type: "array",
				minItems: 1,
				maxItems: 100,
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						value: {
							type: ["string", "number", "boolean", "array", "object", "null"],
						},
					},
					required: ["path", "value"],
					additionalProperties: false,
				},
			}),
		},
		"serial",
	),
	set_todos: sessionCommand(
		{ type: "set_todos", phases: [] },
		{ phases: required("an array of valid todo phases", value => Array.isArray(value) && value.every(isTodoPhase)) },
	),
	todo_apply: sessionCommand(
		{ type: "todo_apply", operation: { op: "view" } },
		{
			operation: required("a valid semantic todo operation", isTodoOperationInput, {
				type: "object",
				properties: {
					op: {
						type: "string",
						enum: ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"],
					},
					list: { type: "array" },
					task: { type: "string" },
					phase: { type: "string" },
					items: { type: "array", items: { type: "string" } },
					reason: { type: "string" },
				},
				required: ["op"],
				additionalProperties: false,
			}),
		},
		"serial",
	),
	goal_control: sessionCommand(
		{ type: "goal_control", op: "get" },
		{
			op: required(
				"a goal lifecycle operation",
				value =>
					value === "create" ||
					value === "replace" ||
					value === "get" ||
					value === "resume" ||
					value === "pause" ||
					value === "drop" ||
					value === "complete" ||
					value === "set_budget" ||
					value === "clear_budget",
				{
					type: "string",
					enum: ["create", "replace", "get", "resume", "pause", "drop", "complete", "set_budget", "clear_budget"],
				},
			),
			objective: optionalBoundedStringField("a goal objective", 65_536),
			tokenBudget: positiveIntegerField,
		},
		"serial",
	),
	checkpoint_control: sessionCommand(
		{ type: "checkpoint_control", op: "get" },
		{
			op: required(
				"a checkpoint lifecycle operation",
				value => value === "get" || value === "create" || value === "rewind",
				{
					type: "string",
					enum: ["get", "create", "rewind"],
				},
			),
			goal: optionalBoundedStringField("an investigation goal", 65_536),
			report: optionalBoundedStringField("a retained rewind report", 262_144),
		},
		"serial",
	),
	loop_control: sessionCommand(
		{ type: "loop_control", op: "get" },
		{
			op: required(
				"a loop lifecycle operation",
				value =>
					value === "get" || value === "enable" || value === "pause" || value === "resume" || value === "disable",
				{ type: "string", enum: ["get", "enable", "pause", "resume", "disable"] },
			),
			action: loopActionField,
			prompt: optionalBoundedStringField("a loop prompt", 262_144),
			limit: loopLimitField,
		},
		"serial",
	),
	set_host_tools: hostCommand(
		{ type: "set_host_tools", tools: [] },
		{
			tools: required(
				"an array of host tool definitions",
				value =>
					Array.isArray(value) &&
					value.every(
						tool =>
							isRecord(tool) &&
							typeof tool.name === "string" &&
							typeof tool.description === "string" &&
							isRecord(tool.parameters),
					),
			),
		},
	),
	set_host_uri_schemes: hostCommand(
		{ type: "set_host_uri_schemes", schemes: [] },
		{
			schemes: required(
				"an array of host URI scheme definitions",
				value =>
					Array.isArray(value) &&
					value.every(
						scheme =>
							isRecord(scheme) &&
							typeof scheme.scheme === "string" &&
							(scheme.description === undefined || typeof scheme.description === "string") &&
							(scheme.writable === undefined || typeof scheme.writable === "boolean") &&
							(scheme.immutable === undefined || typeof scheme.immutable === "boolean"),
					),
			),
		},
	),
	set_subagent_subscription: agentCommand(
		{ type: "set_subagent_subscription", level: "off" },
		{ level: enumField("off", "progress", "events") },
		"serial",
		requiresFeature("subagent-event-bus"),
	),
	get_subagents: agentCommand({ type: "get_subagents" }, {}, "serial", requiresFeature("subagent-event-bus")),
	get_subagent_messages: agentCommand(
		{ type: "get_subagent_messages" },
		{
			subagentId: optionalStringField,
			sessionFile: optionalStringField,
			fromByte: nonNegativeIntegerField,
		},
		"serial",
		requiresFeature("subagent-event-bus"),
	),
	list_agents: agentCommand(
		{ type: "list_agents" },
		{ includeAdvisors: optionalBooleanField },
		"concurrent",
		requiresFeature("agent-control"),
	),
	get_agent: agentCommand(
		{ type: "get_agent", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"concurrent",
		requiresFeature("agent-control"),
	),
	start_agent: agentCommand(
		{ type: "start_agent", task: "Investigate" },
		{
			task: agentMessageField,
			agent: optionalBoundedStringField("an agent type", 256),
			name: optionalBoundedStringField("a display name", 64),
			context: optionalBoundedStringField("shared context", 65_536),
		},
		"control",
		{ ...requiresFeature("agent-control"), confirmation: "required" },
	),
	get_agent_result: agentCommand(
		{ type: "get_agent_result", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"concurrent",
		requiresFeature("agent-control"),
	),
	send_agent_message: agentCommand(
		{ type: "send_agent_message", agentId: "SubagentA", message: "continue" },
		{ agentId: agentIdField, message: agentMessageField, replyTo: optionalAgentIdField },
		"control",
		requiresFeature("agent-control"),
	),
	park_agent: agentCommand(
		{ type: "park_agent", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"control",
		requiresFeature("agent-control"),
	),
	resume_agent: agentCommand(
		{ type: "resume_agent", agentId: "SubagentA" },
		{ agentId: agentIdField },
		"control",
		requiresFeature("agent-control"),
	),
	cancel_agent: agentCommand({ type: "cancel_agent", agentId: "SubagentA" }, { agentId: agentIdField }, "control", {
		...requiresFeature("agent-control"),
		confirmation: "required",
	}),
	release_agent: agentCommand(
		{ type: "release_agent", agentId: "SubagentA" },
		{ agentId: agentIdField, tombstone: releaseTombstoneField },
		"control",
		{ ...requiresFeature("agent-control"), confirmation: "required" },
	),
	get_queue: sessionCommand({ type: "get_queue" }, {}, "control"),
	queue_insert: sessionCommand(
		{ type: "queue_insert", lane: "steering", text: "interrupt" },
		{ lane: enumField("steering", "followUp"), text: agentMessageField, toIndex: nonNegativeIntegerField },
		"control",
	),
	queue_update: sessionCommand(
		{ type: "queue_update", entryId: "queue-entry", text: "updated" },
		{ entryId: opaqueIdField, text: agentMessageField },
		"control",
	),
	queue_move: sessionCommand(
		{ type: "queue_move", entryId: "queue-entry", lane: "followUp", toIndex: 0 },
		{ entryId: opaqueIdField, lane: enumField("steering", "followUp"), toIndex: queueIndexField },
		"control",
	),
	remove_queued_message: sessionCommand(
		{ type: "remove_queued_message", entryId: "queue-entry" },
		{ entryId: opaqueIdField },
		"control",
	),
	reorder_queued_message: sessionCommand(
		{ type: "reorder_queued_message", entryId: "queue-entry", toIndex: 0 },
		{ entryId: opaqueIdField, toIndex: queueIndexField },
		"control",
	),
	clear_queue: sessionCommand(
		{ type: "clear_queue", lane: "all" },
		{ lane: optionalEnumField("steering", "followUp", "all") },
		"control",
	),
	list_jobs: agentCommand({ type: "list_jobs" }, {}, "concurrent", requiresFeature("job-control")),
	get_job: agentCommand(
		{ type: "get_job", jobId: "job-id" },
		{ jobId: opaqueIdField },
		"concurrent",
		requiresFeature("job-control"),
	),
	cancel_job: agentCommand({ type: "cancel_job", jobIds: ["job-id"] }, { jobIds: jobIdArrayField }, "control", {
		...requiresFeature("job-control"),
		confirmation: "required",
	}),
	set_model: sessionCommand(
		{ type: "set_model", provider: "anthropic", modelId: "claude" },
		{ provider: stringField, modelId: stringField },
	),
	set_model_role: sessionCommand(
		{ type: "set_model_role", role: "default" },
		{ role: boundedStringField("a model role name", 128) },
		"serial",
	),
	set_service_tier: sessionCommand(
		{ type: "set_service_tier", family: "openai", tier: null },
		{
			family: required(
				"a service-tier family",
				value => value === "openai" || value === "anthropic" || value === "google",
				{
					type: "string",
					enum: ["openai", "anthropic", "google"],
				},
			),
			tier: required(
				"a service tier or null to clear it",
				value =>
					value === null ||
					value === "auto" ||
					value === "default" ||
					value === "flex" ||
					value === "scale" ||
					value === "priority",
				{
					type: ["string", "null"],
					enum: ["auto", "default", "flex", "scale", "priority", null],
				},
			),
		},
		"serial",
	),
	cycle_model: sessionCommand({ type: "cycle_model" }),
	get_available_models: sessionCommand({ type: "get_available_models" }),
	set_thinking_level: sessionCommand(
		{ type: "set_thinking_level", level: ThinkingLevel.Medium },
		{ level: enumField("inherit", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max") },
	),
	cycle_thinking_level: sessionCommand({ type: "cycle_thinking_level" }),
	set_steering_mode: sessionCommand(
		{ type: "set_steering_mode", mode: "one-at-a-time" },
		{ mode: enumField("all", "one-at-a-time") },
	),
	set_follow_up_mode: sessionCommand(
		{ type: "set_follow_up_mode", mode: "one-at-a-time" },
		{ mode: enumField("all", "one-at-a-time") },
	),
	set_interrupt_mode: sessionCommand(
		{ type: "set_interrupt_mode", mode: "immediate" },
		{ mode: enumField("immediate", "wait") },
	),
	compact: sessionCommand({ type: "compact" }, { customInstructions: optionalStringField }),
	set_auto_compaction: sessionCommand({ type: "set_auto_compaction", enabled: true }, { enabled: booleanField }),
	set_auto_retry: sessionCommand({ type: "set_auto_retry", enabled: true }, { enabled: booleanField }),
	retry: sessionCommand({ type: "retry" }),
	abort_retry: sessionCommand({ type: "abort_retry" }, {}, "control"),
	bash: sessionCommand({ type: "bash", command: "pwd" }, { command: stringField }, "concurrent", {
		confirmation: "required",
	}),
	abort_bash: sessionCommand({ type: "abort_bash" }, {}, "control"),
	get_session_stats: sessionCommand({ type: "get_session_stats" }),
	export_html: sessionCommand({ type: "export_html" }, { outputPath: optionalStringField }),
	switch_session: sessionCommand(
		{ type: "switch_session", sessionPath: "/tmp/session.jsonl" },
		{ sessionPath: stringField },
	),
	list_sessions: hostCommand(
		{ type: "list_sessions", scope: "cwd", cwd: "/workspace", limit: 50 },
		{
			scope: optionalEnumField("cwd", "all"),
			cwd: optionalStringField,
			cursor: optionalStringField,
			limit: optionalIntegerField,
			search: optionalStringField,
		},
		"concurrent",
	),
	get_session_info: hostCommand(
		{ type: "get_session_info", session: "01901234" },
		{ session: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
		"concurrent",
	),
	get_session_tree: sessionCommand({ type: "get_session_tree" }, {}, "concurrent"),
	select_session_leaf: sessionCommand(
		{ type: "select_session_leaf", entryId: "entry-1" },
		{ entryId: stringField, summarize: optionalBooleanField, customInstructions: optionalStringField },
	),
	reset_session: sessionCommand({ type: "reset_session" }),
	list_workspace_roots: hostCommand({ type: "list_workspace_roots" }, {}, "concurrent"),
	resume_session: sessionCommand(
		{ type: "resume_session", session: "01901234" },
		{ session: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
	),
	fork_session: sessionCommand({ type: "fork_session" }),
	rename_session: hostCommand(
		{ type: "rename_session", session: "01901234", name: "Investigation" },
		{ session: stringField, name: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
	),

	delete_session: hostCommand(
		{ type: "delete_session", session: "01901234" },
		{ session: stringField, scope: optionalEnumField("cwd", "all"), cwd: optionalStringField },
		"serial",
		{ confirmation: "required" },
	),
	branch: sessionCommand({ type: "branch", entryId: "entry-1" }, { entryId: stringField }),
	get_branch_messages: sessionCommand({ type: "get_branch_messages" }),
	get_last_assistant_text: sessionCommand({ type: "get_last_assistant_text" }),
	set_session_name: sessionCommand({ type: "set_session_name", name: "Session" }, { name: stringField }),
	handoff: sessionCommand({ type: "handoff" }, { customInstructions: optionalStringField }),
	get_messages: sessionCommand({ type: "get_messages" }),
	get_messages_page: sessionCommand(
		{ type: "get_messages_page" },
		{ cursor: optionalStringField, limit: positiveIntegerField },
	),
	get_transcript_page: sessionCommand(
		{ type: "get_transcript_page" },
		{
			cursor: optionalStringField,
			limit: positiveIntegerField,
			collapseCompactedHistory: optionalBooleanField,
		},
	),
} as const satisfies RpcCommandDefinitions;

export function getRpcCommandRequiredFeatures(commandType: RpcCommandType): readonly string[] {
	return RPC_COMMAND_DEFINITIONS[commandType].requiredFeatures;
}

function inputSchemaFor(name: RpcCommandType, definition: RpcCommandDefinition): RpcInputSchema {
	const properties: Record<string, Record<string, unknown>> = {
		id: { type: "string" },
		type: { const: name },
	};
	const requiredFields = definition.idRequired ? ["type", "id"] : ["type"];
	for (const [fieldName, field] of Object.entries(definition.fields)) {
		const example = (definition.example as unknown as Record<string, unknown>)[fieldName];
		properties[fieldName] = example === undefined ? { ...field.schema } : { ...field.schema, example };
		if (!field.optional) requiredFields.push(fieldName);
	}
	return { type: "object", properties, required: requiredFields, additionalProperties: false };
}

export function getRpcCapabilityManifest(context: RpcCapabilityContext = {}): RpcCapabilityManifest {
	return {
		applicationApiVersion: RPC_APPLICATION_API_VERSION,
		commands: Object.entries(RPC_COMMAND_DEFINITIONS).map(([name, definition]): RpcCommandCapability => {
			const availability = definition.availability(context);
			const descriptor = {
				id: `rpc.command.${name}`,
				name: name as RpcCommandType,
				version: definition.version,
				scope: definition.scope,
				execution: definition.execution,
				inputSchema: inputSchemaFor(name as RpcCommandType, definition),
				...(definition.concurrencyClass === undefined ? {} : { concurrencyClass: definition.concurrencyClass }),
				confirmation: definition.confirmation,
				requiredFeatures: [...definition.requiredFeatures],
				...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
			};
			if (availability.availability === "unavailable") {
				return { ...descriptor, availability: "unavailable", disabledReason: availability.disabledReason };
			}
			return { ...descriptor, availability: availability.availability };
		}),
		events: [...RPC_EVENT_TYPES],
		extensionUiMethods: [...RPC_EXTENSION_UI_METHODS],
		hostProtocols: ["tools", "uris"],
	};
}

export interface RpcCommandValidationFailure {
	ok: false;
	id?: string;
	command: string;
	error: string;
	code: "invalid_request" | "unsupported_command";
}

export type RpcCommandValidationResult =
	| { ok: true; command: RpcCommand; scheduling: RpcCommandSchedulingClass }
	| RpcCommandValidationFailure;

export function validateRpcCommand(value: unknown): RpcCommandValidationResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			command: "parse",
			error: "RPC command must be a JSON object",
			code: "invalid_request",
		};
	}

	const id = typeof value.id === "string" ? value.id : undefined;
	if (value.id !== undefined && id === undefined) {
		return {
			ok: false,
			command: typeof value.type === "string" ? value.type : "parse",
			error: 'RPC command field "id" must be a string',
			code: "invalid_request",
		};
	}
	if (typeof value.type !== "string") {
		return {
			ok: false,
			id,
			command: "parse",
			error: 'RPC command field "type" must be a string',
			code: "invalid_request",
		};
	}

	const definitions: Readonly<Record<string, RpcCommandDefinition>> = RPC_COMMAND_DEFINITIONS;
	const definition = definitions[value.type];
	if (!definition) {
		return {
			ok: false,
			id,
			command: value.type,
			error: `Unknown RPC command: ${value.type}`,
			code: "unsupported_command",
		};
	}

	if (definition.idRequired && id === undefined) {
		return {
			ok: false,
			command: value.type,
			error: 'RPC command field "id" is required',
			code: "invalid_request",
		};
	}

	for (const [fieldName, field] of Object.entries(definition.fields)) {
		const fieldValue = value[fieldName];
		if (fieldValue === undefined) {
			if (field.optional) continue;
			return {
				ok: false,
				id,
				command: value.type,
				error: `RPC command field "${fieldName}" is required`,
				code: "invalid_request",
			};
		}
		if (!field.validate(fieldValue)) {
			return {
				ok: false,
				id,
				command: value.type,
				error: `RPC command field "${fieldName}" must be ${field.expected}`,
				code: "invalid_request",
			};
		}
	}

	const allowedFields = new Set(["id", "type", ...Object.keys(definition.fields)]);
	for (const fieldName of Object.keys(value)) {
		if (allowedFields.has(fieldName)) continue;
		return {
			ok: false,
			id,
			command: value.type,
			error: `RPC command field "${fieldName}" is not supported`,
			code: "invalid_request",
		};
	}

	let scheduling = definition.scheduling;
	if (value.type === "session_invoke") {
		const nestedCommand = value.command;
		if (!isRecord(nestedCommand)) {
			return {
				ok: false,
				id,
				command: value.type,
				error: 'RPC command field "command" must be a validated session command',
				code: "invalid_request",
			};
		}
		const nestedInput = nestedCommand.input;
		const nestedValidation = validateRpcCommand({
			...(nestedInput === undefined ? {} : nestedInput),
			id,
			type: nestedCommand.kind,
		});
		if (!nestedValidation.ok) {
			return {
				ok: false,
				id,
				command: value.type,
				error: `Invalid nested session command: ${nestedValidation.error}`,
				code: nestedValidation.code,
			};
		}
		scheduling = nestedValidation.scheduling;
	}

	const normalized = { ...value };
	for (const [fieldName, field] of Object.entries(definition.fields)) {
		if (field.optional && normalized[fieldName] === null) delete normalized[fieldName];
	}

	return {
		ok: true,
		command: normalized as RpcCommand,
		scheduling,
	};
}
