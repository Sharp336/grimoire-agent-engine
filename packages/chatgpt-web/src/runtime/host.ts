import type { LoginHost } from "../browser/login-host";
import type { ChatGptWebErrorClass, ChatGptWebRuntimeAdmission } from "../provider/types";

export const BROWSER_LIMITS = Object.freeze({
	attachmentBytes: 20_000_000,
	attachmentNameBytes: 255,
	composerTextBytes: 1_000_000,
	generationIdBytes: 512,
	locatorCount: 256,
	locatorTextBytes: 1_000_000,
	locatorTexts: 256,
	responseTextBytes: 8_000_000,
} as const);

export type BrowserNavigationTarget = { kind: "temporary-chat" };
export type BrowserSelectorKey =
	| "composer"
	| "send"
	| "response"
	| "reasoning"
	| "commentary"
	| "generation"
	| "attachment-input"
	| "health";
export type BrowserRoleTarget =
	| { role: "button"; name: "Send" | "Stop generating" | "Attach files" | "Regenerate" }
	| { role: "textbox"; name: "Message" | "Prompt" }
	| { role: "heading"; name: "ChatGPT" }
	| { role: "main" };
export interface BrowserFilterTarget {
	key: BrowserSelectorKey;
	/** Bounded literal text used only for host-side filtering; never a selector expression. */
	hasText?: string;
}
export type BrowserKey = "Enter" | "Escape" | "ControlOrMeta+Enter";
export interface BrowserLeaseCapability {
	readonly __opaque: unique symbol;
}
export interface BrowserAttachment {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly sha256: string;
	readonly __opaque: unique symbol;
}
export interface ComposerSnapshot {
	ready: boolean;
	text: string;
	canSubmit: boolean;
}
export interface ResponseSnapshot {
	userText: string;
	assistantText: string;
	reasoningText: string;
	generationId: string | null;
	settled: boolean;
}
export interface HealthSnapshot {
	temporaryChat: boolean;
	ready: boolean;
	errorClass: ChatGptWebErrorClass | null;
}

export interface BrowserLocator {
	click(): Promise<void>;
	fill(text: string): Promise<void>;
	insertText(text: string): Promise<void>;
	press(key: BrowserKey): Promise<void>;
	pressSequentially(text: string): Promise<void>;
	setInputFiles(files: readonly BrowserAttachment[]): Promise<void>;
	isVisible(): Promise<boolean>;
	isEnabled(): Promise<boolean>;
	count(): Promise<number>;
	nth(index: number): BrowserLocator;
	last(): BrowserLocator;
	allInnerTexts(): Promise<readonly string[]>;
	textContent(): Promise<string | null>;
	filter(target: BrowserFilterTarget): BrowserLocator;
}
export interface BrowserPage {
	goto(target: BrowserNavigationTarget): Promise<void>;
	locator(target: BrowserSelectorKey): BrowserLocator;
	getByRole(target: BrowserRoleTarget): BrowserLocator;
	readComposerSnapshot(): Promise<ComposerSnapshot>;
	readResponseSnapshot(): Promise<ResponseSnapshot>;
	readHealthSnapshot(): Promise<HealthSnapshot>;
	state(): Promise<"temporary-chat" | "other" | "closed">;
	close(): Promise<void>;
}
export interface BrowserLeaseRequest {
	readonly sessionId: string;
	readonly turnId: string;
	readonly modelKey: string;
	readonly mode: "browser-only" | "full";
	readonly headed: boolean;
	readonly signal?: AbortSignal;
}
export interface BrowserHost extends LoginHost {
	lease(request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission): Promise<BrowserLease>;
	close(): Promise<void>;
}
export interface BrowserLease {
	id: string;
	capability: BrowserLeaseCapability;
	page: BrowserPage;
	stageAttachment(input: { name: string; bytes: Uint8Array }): Promise<BrowserAttachment>;
	close(): Promise<void>;
}

export class BrowserContractError extends Error {
	readonly errorClass: ChatGptWebErrorClass;
	constructor(errorClass: ChatGptWebErrorClass, code: string) {
		super(code);
		this.name = "BrowserContractError";
		this.errorClass = errorClass;
	}
}

const selectorKeys = new Set<BrowserSelectorKey>([
	"composer",
	"send",
	"response",
	"reasoning",
	"commentary",
	"generation",
	"attachment-input",
	"health",
]);
const browserKeys = new Set<BrowserKey>(["Enter", "Escape", "ControlOrMeta+Enter"]);
const roleNames = Object.freeze({
	button: new Set(["Send", "Stop generating", "Attach files", "Regenerate"]),
	heading: new Set(["ChatGPT"]),
	main: new Set<never>(),
	textbox: new Set(["Message", "Prompt"]),
});
const errorClasses = new Set<ChatGptWebErrorClass>([
	"aborted",
	"browser_unavailable",
	"login_required",
	"profile_conflict",
	"selector_drift",
	"tool_protocol",
	"runtime_draining",
	"malformed_browser_output",
	"unsupported_context",
	"internal",
]);
const encoder = new TextEncoder();

function boundedString(value: unknown, maximumBytes: number, code: string): string {
	if (typeof value !== "string" || encoder.encode(value).byteLength > maximumBytes) {
		throw new BrowserContractError("malformed_browser_output", code);
	}
	return value;
}

export function assertBrowserSelectorKey(value: unknown): asserts value is BrowserSelectorKey {
	if (typeof value !== "string" || !selectorKeys.has(value as BrowserSelectorKey)) {
		throw new BrowserContractError("selector_drift", "unknown_selector_key");
	}
}
export function assertBrowserKey(value: unknown): asserts value is BrowserKey {
	if (typeof value !== "string" || !browserKeys.has(value as BrowserKey)) {
		throw new BrowserContractError("selector_drift", "unknown_keyboard_key");
	}
}
export function assertBrowserRoleTarget(value: unknown): asserts value is BrowserRoleTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new BrowserContractError("selector_drift", "invalid_role_target");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (record.role === "main") {
		if (keys.length !== 1) throw new BrowserContractError("selector_drift", "invalid_role_target");
		return;
	}
	if (record.role !== "button" && record.role !== "heading" && record.role !== "textbox") {
		throw new BrowserContractError("selector_drift", "invalid_role_target");
	}
	if (keys.length !== 2 || typeof record.name !== "string" || !roleNames[record.role].has(record.name as never)) {
		throw new BrowserContractError("selector_drift", "invalid_role_target");
	}
}
export function assertBrowserFilterTarget(value: unknown): asserts value is BrowserFilterTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new BrowserContractError("selector_drift", "invalid_filter_target");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some(key => key !== "key" && key !== "hasText")) {
		throw new BrowserContractError("selector_drift", "invalid_filter_target");
	}
	assertBrowserSelectorKey(record.key);
	if (record.hasText !== undefined) boundedString(record.hasText, 512, "filter_text_too_large");
}

export function validateComposerSnapshot(value: unknown): ComposerSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new BrowserContractError("malformed_browser_output", "invalid_composer_snapshot");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 3 || typeof record.ready !== "boolean" || typeof record.canSubmit !== "boolean") {
		throw new BrowserContractError("malformed_browser_output", "invalid_composer_snapshot");
	}
	return Object.freeze({
		ready: record.ready,
		text: boundedString(record.text, BROWSER_LIMITS.composerTextBytes, "composer_text_too_large"),
		canSubmit: record.canSubmit,
	});
}
export function validateResponseSnapshot(value: unknown): ResponseSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new BrowserContractError("malformed_browser_output", "invalid_response_snapshot");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 5 || typeof record.settled !== "boolean") {
		throw new BrowserContractError("malformed_browser_output", "invalid_response_snapshot");
	}
	const generationId =
		record.generationId === null
			? null
			: boundedString(record.generationId, BROWSER_LIMITS.generationIdBytes, "generation_id_too_large");
	return Object.freeze({
		userText: boundedString(record.userText, BROWSER_LIMITS.responseTextBytes, "user_text_too_large"),
		assistantText: boundedString(record.assistantText, BROWSER_LIMITS.responseTextBytes, "assistant_text_too_large"),
		reasoningText: boundedString(record.reasoningText, BROWSER_LIMITS.responseTextBytes, "reasoning_text_too_large"),
		generationId,
		settled: record.settled,
	});
}
export function validateHealthSnapshot(value: unknown): HealthSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new BrowserContractError("malformed_browser_output", "invalid_health_snapshot");
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 3 ||
		typeof record.temporaryChat !== "boolean" ||
		typeof record.ready !== "boolean"
	) {
		throw new BrowserContractError("malformed_browser_output", "invalid_health_snapshot");
	}
	if (
		record.errorClass !== null &&
		(typeof record.errorClass !== "string" || !errorClasses.has(record.errorClass as ChatGptWebErrorClass))
	) {
		throw new BrowserContractError("malformed_browser_output", "invalid_health_error_class");
	}
	return Object.freeze({
		temporaryChat: record.temporaryChat,
		ready: record.ready,
		errorClass: record.errorClass as ChatGptWebErrorClass | null,
	});
}
export function validateLocatorCount(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > BROWSER_LIMITS.locatorCount) {
		throw new BrowserContractError("malformed_browser_output", "invalid_locator_count");
	}
	return value as number;
}
export function validateLocatorText(value: unknown): string | null {
	return value === null ? null : boundedString(value, BROWSER_LIMITS.locatorTextBytes, "locator_text_too_large");
}
export function validateLocatorTexts(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length > BROWSER_LIMITS.locatorTexts) {
		throw new BrowserContractError("malformed_browser_output", "invalid_locator_texts");
	}
	return Object.freeze(
		value.map(text => boundedString(text, BROWSER_LIMITS.locatorTextBytes, "locator_text_too_large")),
	);
}
export function validateAttachmentDisplayName(name: unknown): string {
	const value = boundedString(name, BROWSER_LIMITS.attachmentNameBytes, "invalid_attachment_name");
	if (!value || /[\u0000-\u001f\u007f\\/]/u.test(value) || /^(?:\\\\|\/\/|[a-zA-Z]:|\\[?.]\\)/u.test(value)) {
		throw new BrowserContractError("malformed_browser_output", "invalid_attachment_name");
	}
	return value;
}
