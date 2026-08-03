export const LAUNCHER_PROTOCOL_VERSION = 1 as const;
export const MAX_BROWSER_LEASES = 5 as const;

export interface LauncherProcessIdentity {
	readonly pid: number;
	readonly processStartIdentity: string;
	readonly executableIdentity: string;
	readonly __opaque: unique symbol;
}

export interface LauncherLocalEndpoint {
	readonly kind: "owner-local";
	readonly __opaque: unique symbol;
}

/** Non-secret native capability published by the launcher lifecycle owner. */
export interface LauncherDescriptor {
	readonly version: typeof LAUNCHER_PROTOCOL_VERSION;
	readonly ownerId: string;
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
	readonly launcherPid: number;
	readonly launcherNonce: string;
	readonly launcherIdentity: LauncherProcessIdentity;
	readonly endpoint: LauncherLocalEndpoint;
}

/** Passed directly by the authenticated lifecycle owner, never written into a descriptor or renderer payload. */
export interface LauncherLifecycleAuthority {
	readonly ownerId: string;
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
	readonly launcherPid: number;
	readonly launcherNonce: string;
	readonly controlToken: string;
}

export type LauncherOperation =
	| "host.login"
	| "host.close"
	| "lease.open"
	| "lease.cancel"
	| "lease.close"
	| "attachment.stage"
	| "page.goto"
	| "page.read-composer"
	| "page.read-response"
	| "page.read-health"
	| "page.state"
	| "page.close"
	| "locator.click"
	| "locator.fill"
	| "locator.insert-text"
	| "locator.press"
	| "locator.press-sequentially"
	| "locator.set-input-files"
	| "locator.is-visible"
	| "locator.is-enabled"
	| "locator.count"
	| "locator.all-inner-texts"
	| "locator.text-content";

export interface LauncherRequest {
	readonly version: typeof LAUNCHER_PROTOCOL_VERSION;
	readonly ownerId: string;
	readonly runtimeEpoch: string;
	readonly lifecycleGeneration: number;
	readonly launcherNonce: string;
	readonly controlToken: string;
	readonly clientPid: number;
	readonly connectionNonce: string;
	readonly requestNonce: string;
	readonly sequence: number;
	readonly operation: LauncherOperation;
	readonly leaseId?: string;
	readonly leaseCapability?: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

export type LauncherResponse =
	| {
			readonly version: typeof LAUNCHER_PROTOCOL_VERSION;
			readonly sequence: number;
			readonly ok: true;
			readonly result: unknown;
	  }
	| {
			readonly version: typeof LAUNCHER_PROTOCOL_VERSION;
			readonly sequence: number;
			readonly ok: false;
			readonly error: {
				readonly code: string;
			};
	  };

export interface LauncherRendererState {
	readonly status: "starting" | "ready" | "login-required" | "error";
	readonly activeLeases: number;
	readonly authenticated: boolean;
}

export type LauncherSetupStatus = "checking" | "ready" | "login-required" | "failed";
export type LauncherLoginStatus = "unknown" | "required" | "in-progress" | "authenticated" | "failed";
export type LauncherMode = "browser-only" | "full";
export type LauncherRuntimeStatus = "stopped" | "starting" | "ready" | "degraded" | "restarting" | "failed";
export type LauncherMcpStatus = "disabled" | "waiting" | "connected" | "failed";
export type LauncherFailureCode =
	| "configuration"
	| "authentication"
	| "browser"
	| "runtime"
	| "mcp"
	| "restart-limit"
	| "internal";

/** Closed, non-secret state safe to copy into the isolated renderer. */
export interface LauncherPublicState {
	readonly revision: number;
	readonly setup: LauncherSetupStatus;
	readonly login: LauncherLoginStatus;
	readonly mode: LauncherMode;
	readonly runtime: LauncherRuntimeStatus;
	readonly activeTurns: number;
	readonly mcp: LauncherMcpStatus;
	readonly autoStart: boolean;
	readonly failure: Readonly<{
		readonly code: LauncherFailureCode;
		readonly recoverable: boolean;
	}> | null;
}

/** The complete renderer bridge. It intentionally has no generic IPC operation. */
export interface LauncherPreloadApi {
	getState(): Promise<LauncherPublicState>;
	subscribeState(listener: (state: LauncherPublicState) => void): () => void;
	requestLogin(): Promise<void>;
	setMode(mode: LauncherMode): Promise<void>;
	restartRuntime(): Promise<void>;
	setAutoStart(enabled: boolean): Promise<void>;
}

declare global {
	interface Window {
		readonly ompChatGptWeb: LauncherPreloadApi;
	}
}
