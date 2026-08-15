import { VERSION } from "@oh-my-pi/pi-utils";

export const OMP_EXTENSION_SCHEMA_VERSION = 1;
export const OMP_EXTENSION_MAX_TEXT_BYTES = 16 * 1024;
export const OMP_EXTENSION_MAX_TIMEOUT_MS = 15_000;

export const OMP_EXTENSION_METHODS = {
	capabilities: "_omp/capabilities",
	advisorStatus: "_omp/advisor/status",
	advisorSet: "_omp/advisor/set",
	advisorDrain: "_omp/advisor/drain",
	autolearnStatus: "_omp/autolearn/status",
	autolearnDrain: "_omp/autolearn/drain",
	memoryStatus: "_omp/memory/status",
	memoryStats: "_omp/memory/stats",
	memoryDiagnose: "_omp/memory/diagnose",
	memoryEnqueue: "_omp/memory/enqueue",
	memoryClear: "_omp/memory/clear",
	launchList: "_omp/launch/list",
	launchDescribe: "_omp/launch/describe",
	launchLogs: "_omp/launch/logs",
	launchSend: "_omp/launch/send",
	launchStop: "_omp/launch/stop",
	launchRestart: "_omp/launch/restart",
} as const;

export const OMP_EXTENSION_EVENTS = {
	advisorNote: "_omp/advisor/note",
	autolearnLifecycle: "_omp/autolearn/lifecycle",
	launchLifecycle: "_omp/launch/lifecycle",
} as const;

export const OMP_LAUNCH_LIFECYCLE_EVENTS = {
	completed: "completed",
	sent: "sent",
	stopped: "stopped",
	restarted: "restarted",
} as const;

export type OmpLaunchLifecycleEvent = (typeof OMP_LAUNCH_LIFECYCLE_EVENTS)[keyof typeof OMP_LAUNCH_LIFECYCLE_EVENTS];

const METHOD_SET = new Set<string>(Object.values(OMP_EXTENSION_METHODS));

export type OmpExtensionFeatureName = "advisor" | "autolearn" | "memory" | "launch" | "managedSkills";

export interface OmpExtensionFeatureCapability {
	available: boolean;
	enabled: boolean;
	observable: boolean;
	controllable: boolean;
	recoverable: boolean;
	methods: string[];
	events: string[];
	reason?: string;
}

export interface OmpExtensionError {
	code: string;
	message: string;
	recoverable: boolean;
	detail?: Record<string, unknown>;
}

export interface OmpExtensionEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
	schemaVersion: typeof OMP_EXTENSION_SCHEMA_VERSION;
	ompVersion: string;
	sessionId: string;
	generation: string;
	sequence: number;
	timestamp: string;
	correlationId?: string;
	data?: T;
	error?: OmpExtensionError;
}

export interface OmpExtensionRequestContext {
	sessionId: string;
	correlationId?: string;
	timeoutMs: number;
}

export interface OmpExtensionSequenceState {
	generation: string;
	sequence: number;
}

export function isOmpTypedExtensionMethod(method: string): boolean {
	return METHOD_SET.has(method);
}

export function parseOmpExtensionRequest(params: Record<string, unknown>): OmpExtensionRequestContext {
	const sessionId = requiredString(params.sessionId, "sessionId", 512);
	const correlationId = optionalString(params.correlationId, "correlationId", 512);
	const requestedTimeout = optionalInteger(params.timeoutMs, "timeoutMs");
	return {
		sessionId,
		correlationId,
		timeoutMs: Math.max(1, Math.min(OMP_EXTENSION_MAX_TIMEOUT_MS, requestedTimeout ?? 5_000)),
	};
}

export function requiredString(value: unknown, label: string, maxBytes = OMP_EXTENSION_MAX_TEXT_BYTES): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
	return value;
}

export function optionalString(
	value: unknown,
	label: string,
	maxBytes = OMP_EXTENSION_MAX_TEXT_BYTES,
): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, label, maxBytes);
}

export function requiredBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined) return undefined;
	return requiredBoolean(value, label);
}

export function optionalInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
	return value;
}

export function boundedInteger(value: unknown, label: string, fallback: number, min: number, max: number): number {
	const parsed = optionalInteger(value, label) ?? fallback;
	return Math.max(min, Math.min(max, parsed));
}

export function createOmpExtensionSequenceState(): OmpExtensionSequenceState {
	return { generation: crypto.randomUUID(), sequence: 0 };
}

export function createOmpExtensionEnvelope<T extends Record<string, unknown>>(
	state: OmpExtensionSequenceState,
	context: Pick<OmpExtensionRequestContext, "sessionId" | "correlationId">,
	data: T,
): OmpExtensionEnvelope<T> {
	state.sequence += 1;
	return {
		schemaVersion: OMP_EXTENSION_SCHEMA_VERSION,
		ompVersion: VERSION,
		sessionId: context.sessionId,
		generation: state.generation,
		sequence: state.sequence,
		timestamp: new Date().toISOString(),
		...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
		data,
	};
}

export function createOmpExtensionCapabilities(
	enabled: Pick<Record<OmpExtensionFeatureName, boolean>, "advisor" | "autolearn" | "memory" | "launch">,
): Record<string, unknown> {
	const feature = (
		name: Exclude<OmpExtensionFeatureName, "managedSkills">,
		methods: string[],
		events: string[],
		recoverable: boolean,
	): OmpExtensionFeatureCapability => ({
		available: true,
		enabled: enabled[name],
		observable: true,
		controllable: methods.some(method => !method.endsWith("/status") && !method.endsWith("/list")),
		recoverable,
		methods,
		events,
	});
	return {
		protocol: "omp-acp-extensions",
		supportedSchemaVersions: [OMP_EXTENSION_SCHEMA_VERSION],
		selectedSchemaVersion: OMP_EXTENSION_SCHEMA_VERSION,
		features: {
			advisor: feature(
				"advisor",
				[OMP_EXTENSION_METHODS.advisorStatus, OMP_EXTENSION_METHODS.advisorSet, OMP_EXTENSION_METHODS.advisorDrain],
				[OMP_EXTENSION_EVENTS.advisorNote],
				true,
			),
			autolearn: feature(
				"autolearn",
				[OMP_EXTENSION_METHODS.autolearnStatus, OMP_EXTENSION_METHODS.autolearnDrain],
				[OMP_EXTENSION_EVENTS.autolearnLifecycle],
				true,
			),
			memory: feature(
				"memory",
				[
					OMP_EXTENSION_METHODS.memoryStatus,
					OMP_EXTENSION_METHODS.memoryStats,
					OMP_EXTENSION_METHODS.memoryDiagnose,
					OMP_EXTENSION_METHODS.memoryEnqueue,
					OMP_EXTENSION_METHODS.memoryClear,
				],
				[],
				true,
			),
			launch: feature(
				"launch",
				[
					OMP_EXTENSION_METHODS.launchList,
					OMP_EXTENSION_METHODS.launchDescribe,
					OMP_EXTENSION_METHODS.launchLogs,
					OMP_EXTENSION_METHODS.launchSend,
					OMP_EXTENSION_METHODS.launchStop,
					OMP_EXTENSION_METHODS.launchRestart,
				],
				[OMP_EXTENSION_EVENTS.launchLifecycle],
				true,
			),
			managedSkills: {
				available: false,
				enabled: false,
				observable: false,
				controllable: false,
				recoverable: false,
				methods: [],
				events: [],
				reason: "No stable typed managed-skills owner is exposed by the ACP runtime.",
			} satisfies OmpExtensionFeatureCapability,
		},
	};
}
