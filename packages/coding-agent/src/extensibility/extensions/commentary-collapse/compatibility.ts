export const SUPPORTED_OMP_MAJOR = 17;
export const PATCH_OWNER = Symbol.for("omp-commentary-collapse.owner");

const ASSISTANT_CLASS_KEYS = ["AssistantMessageComponent", "assistantClass"] as const;
const BUILDER_CLASS_KEYS = ["ChatTranscriptBuilder", "builderClass"] as const;
const EVENT_CONTROLLER_CLASS_KEYS = ["EventController", "eventControllerClass"] as const;
const USER_CLASS_KEYS = ["UserMessageComponent", "userClass"] as const;
const UI_HELPERS_CLASS_KEYS = ["UiHelpers", "uiHelpersClass"] as const;

const ASSISTANT_METHODS = ["updateContent", "getTranscriptBlockSettledRows", "markTranscriptBlockFinalized"] as const;
const BUILDER_METHODS = ["setExpanded", "rebuild", "append"] as const;
const EVENT_CONTROLLER_METHODS = ["handleEvent"] as const;
const UI_HELPERS_METHODS = ["addMessageToChat"] as const;

type AssistantMethodName = (typeof ASSISTANT_METHODS)[number];
type BuilderMethodName = (typeof BUILDER_METHODS)[number];
type EventControllerMethodName = (typeof EVENT_CONTROLLER_METHODS)[number];
type UiHelpersMethodName = (typeof UI_HELPERS_METHODS)[number];

type ConstructorWithPrototype<TPrototype extends object> = {
	readonly prototype: TPrototype;
	new (...args: never[]): TPrototype;
};

export type AssistantPrototype = Record<AssistantMethodName, (...args: never[]) => unknown> & {
	setExpanded?: ((expanded: boolean) => unknown) & { [PATCH_OWNER]?: true };
};

export type BuilderPrototype = Record<BuilderMethodName, (...args: never[]) => unknown>;
export type EventControllerPrototype = Record<EventControllerMethodName, (...args: never[]) => unknown>;
export type UserPrototype = object;
export type UiHelpersPrototype = Record<UiHelpersMethodName, (...args: never[]) => unknown>;

export type AssistantClass = ConstructorWithPrototype<AssistantPrototype>;
export type BuilderClass = ConstructorWithPrototype<BuilderPrototype>;
export type EventControllerClass = ConstructorWithPrototype<EventControllerPrototype>;
export type UserClass = ConstructorWithPrototype<UserPrototype>;
export type UiHelpersClass = ConstructorWithPrototype<UiHelpersPrototype>;

export interface HostLikeModule {
	readonly version?: unknown;
	readonly VERSION?: unknown;
	readonly packageVersion?: unknown;
	readonly package?: { readonly version?: unknown };
	readonly AssistantMessageComponent?: unknown;
	readonly ChatTranscriptBuilder?: unknown;
	readonly assistantClass?: unknown;
	readonly builderClass?: unknown;
	readonly EventController?: unknown;
	readonly UserMessageComponent?: unknown;
	readonly eventControllerClass?: unknown;
	readonly userClass?: unknown;
	readonly UiHelpers?: unknown;
	readonly uiHelpersClass?: unknown;
}

export type CompatibilityReason = "unsupported-version" | "missing-shape" | "conflicting-shape";

export interface MissingShape {
	readonly surface: "host" | "assistant" | "builder" | "event-controller" | "ui-helpers" | "user";
	readonly member: string;
}

export interface ConflictingShape {
	readonly surface: "assistant";
	readonly member: "setExpanded";
	readonly conflict: "non-function-member";
}

export interface CompatibilitySuccess {
	readonly ok: true;
	readonly detectedVersion: string;
	readonly majorVersion: typeof SUPPORTED_OMP_MAJOR;
	readonly assistantClass: AssistantClass;
	readonly assistantPrototype: AssistantPrototype;
	readonly builderClass: BuilderClass;
	readonly builderPrototype: BuilderPrototype;
	readonly eventControllerClass: EventControllerClass;
	readonly eventControllerPrototype: EventControllerPrototype;
	readonly userClass: UserClass;
	readonly uiHelpersClass: UiHelpersClass;
	readonly uiHelpersPrototype: UiHelpersPrototype;
}

export interface CompatibilityFailure {
	readonly ok: false;
	readonly reason: CompatibilityReason;
	readonly warning: string;
	readonly detectedVersion?: string;
	readonly majorVersion?: number;
	readonly missing: readonly MissingShape[];
	readonly conflicting: readonly ConflictingShape[];
}

export type CompatibilityResult = CompatibilitySuccess | CompatibilityFailure;

export function validateCompatibility(hostModule: HostLikeModule): CompatibilityResult {
	const detectedVersion = detectVersion(hostModule);
	const majorVersion = detectedVersion === undefined ? undefined : parseMajorVersion(detectedVersion);
	const missing: MissingShape[] = [];
	const conflicting: ConflictingShape[] = [];

	if (detectedVersion === undefined || majorVersion !== SUPPORTED_OMP_MAJOR) {
		return failure("unsupported-version", detectedVersion, majorVersion, missing, conflicting);
	}

	const assistantClass = findClass(hostModule, ASSISTANT_CLASS_KEYS);
	const builderClass = findClass(hostModule, BUILDER_CLASS_KEYS);
	const eventControllerClass = findClass(hostModule, EVENT_CONTROLLER_CLASS_KEYS);
	const userClass = findClass(hostModule, USER_CLASS_KEYS);
	const uiHelpersClass = findClass(hostModule, UI_HELPERS_CLASS_KEYS);

	if (assistantClass === undefined) missing.push({ surface: "host", member: "AssistantMessageComponent" });
	if (builderClass === undefined) missing.push({ surface: "host", member: "ChatTranscriptBuilder" });
	if (eventControllerClass === undefined) missing.push({ surface: "host", member: "EventController" });
	if (userClass === undefined) missing.push({ surface: "host", member: "UserMessageComponent" });
	if (uiHelpersClass === undefined) missing.push({ surface: "host", member: "UiHelpers" });

	const assistantPrototype = assistantClass === undefined ? undefined : getPrototype(assistantClass);
	const builderPrototype = builderClass === undefined ? undefined : getPrototype(builderClass);
	const eventControllerPrototype = eventControllerClass === undefined ? undefined : getPrototype(eventControllerClass);
	const userPrototype = userClass === undefined ? undefined : getPrototype(userClass);
	const uiHelpersPrototype = uiHelpersClass === undefined ? undefined : getPrototype(uiHelpersClass);

	if (assistantClass !== undefined && assistantPrototype === undefined) {
		missing.push({ surface: "assistant", member: "prototype" });
	}
	if (builderClass !== undefined && builderPrototype === undefined) {
		missing.push({ surface: "builder", member: "prototype" });
	}
	if (eventControllerClass !== undefined && eventControllerPrototype === undefined) {
		missing.push({ surface: "event-controller", member: "prototype" });
	}
	if (userClass !== undefined && userPrototype === undefined) {
		missing.push({ surface: "user", member: "prototype" });
	}
	if (uiHelpersClass !== undefined && uiHelpersPrototype === undefined) {
		missing.push({ surface: "ui-helpers", member: "prototype" });
	}

	if (assistantPrototype !== undefined) {
		for (const method of ASSISTANT_METHODS) {
			if (!hasFunction(assistantPrototype, method)) missing.push({ surface: "assistant", member: method });
		}

		const existingSetExpanded = findDescriptor(assistantPrototype, "setExpanded");
		if (
			existingSetExpanded !== undefined &&
			!("value" in existingSetExpanded && typeof existingSetExpanded.value === "function")
		) {
			conflicting.push({
				surface: "assistant",
				member: "setExpanded",
				conflict: "non-function-member",
			});
		}
	}

	if (builderPrototype !== undefined) {
		for (const method of BUILDER_METHODS) {
			if (!hasFunction(builderPrototype, method)) missing.push({ surface: "builder", member: method });
		}
	}
	if (eventControllerPrototype !== undefined) {
		for (const method of EVENT_CONTROLLER_METHODS) {
			if (!hasFunction(eventControllerPrototype, method)) {
				missing.push({ surface: "event-controller", member: method });
			}
		}
	}
	if (uiHelpersPrototype !== undefined) {
		for (const method of UI_HELPERS_METHODS) {
			if (!hasFunction(uiHelpersPrototype, method)) {
				missing.push({ surface: "ui-helpers", member: method });
			}
		}
	}

	if (missing.length > 0 || conflicting.length > 0) {
		return failure("missing-shape", detectedVersion, majorVersion, missing, conflicting);
	}

	return {
		ok: true,
		detectedVersion,
		majorVersion: SUPPORTED_OMP_MAJOR,
		assistantClass: assistantClass as AssistantClass,
		assistantPrototype: assistantPrototype as AssistantPrototype,
		builderClass: builderClass as BuilderClass,
		builderPrototype: builderPrototype as BuilderPrototype,
		eventControllerClass: eventControllerClass as EventControllerClass,
		eventControllerPrototype: eventControllerPrototype as EventControllerPrototype,
		userClass: userClass as UserClass,
		uiHelpersClass: uiHelpersClass as UiHelpersClass,
		uiHelpersPrototype: uiHelpersPrototype as UiHelpersPrototype,
	};
}

function detectVersion(hostModule: HostLikeModule): string | undefined {
	const version = firstString(
		hostModule.version,
		hostModule.VERSION,
		hostModule.packageVersion,
		hostModule.package?.version,
	);
	return version;
}

function firstString(...values: readonly unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function parseMajorVersion(version: string): number | undefined {
	const match = /^(\d+)/.exec(version);
	if (match === null) return undefined;
	const major = Number(match[1]);
	return Number.isSafeInteger(major) ? major : undefined;
}

function findClass(hostModule: HostLikeModule, keys: readonly string[]): unknown {
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(hostModule, key);
		if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function") {
			return descriptor.value;
		}
	}
	return undefined;
}

function getPrototype(classValue: unknown): object | undefined {
	if (typeof classValue !== "function") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(classValue, "prototype");
	if (descriptor === undefined || !("value" in descriptor) || !isObject(descriptor.value)) return undefined;
	return descriptor.value;
}

function hasFunction(prototype: object, key: string): boolean {
	const descriptor = findDescriptor(prototype, key);
	return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function";
}

function findDescriptor(prototype: object, key: string): PropertyDescriptor | undefined {
	let current: object | null = prototype;
	while (current !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor !== undefined) return descriptor;
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function failure(
	reason: CompatibilityReason,
	detectedVersion: string | undefined,
	majorVersion: number | undefined,
	missing: readonly MissingShape[],
	conflicting: readonly ConflictingShape[],
): CompatibilityFailure {
	const effectiveReason: CompatibilityReason =
		conflicting.length > 0 && missing.length === 0 ? "conflicting-shape" : reason;
	return {
		ok: false,
		reason: effectiveReason,
		warning: buildWarning(effectiveReason, detectedVersion, majorVersion, missing, conflicting),
		...(detectedVersion === undefined ? {} : { detectedVersion }),
		...(majorVersion === undefined ? {} : { majorVersion }),
		missing: [...missing],
		conflicting: [...conflicting],
	};
}

function buildWarning(
	reason: CompatibilityReason,
	detectedVersion: string | undefined,
	majorVersion: number | undefined,
	missing: readonly MissingShape[],
	conflicting: readonly ConflictingShape[],
): string {
	const detected = detectedVersion === undefined ? "unknown" : detectedVersion;
	const major = majorVersion === undefined ? "unknown" : String(majorVersion);
	const parts = [
		`omp-commentary-collapse disabled: ${reason}`,
		`detectedVersion=${detected}`,
		`majorVersion=${major}`,
	];
	if (missing.length > 0) parts.push(`missing=${missing.map(item => `${item.surface}.${item.member}`).join(",")}`);
	if (conflicting.length > 0) {
		parts.push(`conflicting=${conflicting.map(item => `${item.surface}.${item.member}:${item.conflict}`).join(",")}`);
	}
	return parts.join("; ");
}
