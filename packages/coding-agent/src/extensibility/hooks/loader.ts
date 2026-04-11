/**
 * Hook loader - loads TypeScript hook modules using native Bun import.
 */
import * as path from "node:path";
import * as piCodingAgent from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import * as typebox from "@sinclair/typebox";
import { hookCapability } from "../../capability/hook";
import type { SourceMeta } from "../../capability/types";
import type { Hook } from "../../discovery";
import { loadCapability } from "../../discovery";
import { assertCodeLoadAllowed } from "../../security/access";
import type { HookMessage } from "../../session/messages";
import type { SessionManager } from "../../session/session-manager";
import { resolvePath } from "../utils";
import { execCommand } from "./runner";
import type { ExecOptions, HookAPI, HookFactory, HookMessageRenderer, RegisteredCommand } from "./types";

/**
 * Generic handler function type.
 */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Send message handler type for pi.sendMessage().
 */
export type SendMessageHandler = <T = unknown>(
	message: Pick<HookMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
) => void;

/**
 * Append entry handler type for pi.appendEntry().
 */
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

/**
 * New session handler type for ctx.newSession() in HookCommandContext.
 */
export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

/**
 * Branch handler type for ctx.branch() in HookCommandContext.
 */
export type BranchHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

/**
 * Navigate tree handler type for ctx.navigateTree() in HookCommandContext.
 */
export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean },
) => Promise<{ cancelled: boolean }>;

/**
 * Registered handlers for a loaded hook.
 */
export interface LoadedHook {
	/** Original path from config */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** Map of event type to handler functions */
	handlers: Map<string, HandlerFn[]>;
	/** Map of customType to hook message renderer */
	messageRenderers: Map<string, HookMessageRenderer>;
	/** Map of command name to registered command */
	commands: Map<string, RegisteredCommand>;
	/** Set the send message handler for this hook's pi.sendMessage() */
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	/** Set the append entry handler for this hook's pi.appendEntry() */
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}

/**
 * Result of loading hooks.
 */
export interface LoadHooksResult {
	/** Successfully loaded hooks */
	hooks: LoadedHook[];
	/** Errors encountered during loading */
	errors: Array<{ path: string; error: string }>;
}

/**
 * Create a HookAPI instance that collects handlers, renderers, and commands.
 * Returns the API, maps, and functions to set handlers later.
 */
function createHookAPI(
	handlers: Map<string, HandlerFn[]>,
	cwd: string,
): {
	api: HookAPI;
	messageRenderers: Map<string, HookMessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
} {
	let sendMessageHandler: SendMessageHandler | null = null;
	let appendEntryHandler: AppendEntryHandler | null = null;
	const messageRenderers = new Map<string, HookMessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();

	// Cast to HookAPI - the implementation is more general (string event names)
	// but the interface has specific overloads for type safety in hooks
	const api = {
		on(event: string, handler: HandlerFn): void {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)!.push(handler);
		},
		sendMessage<T = unknown>(
			message: HookMessage<T>,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
		): void {
			if (!sendMessageHandler) {
				throw new Error("sendMessage handler not initialized");
			}
			sendMessageHandler(message, options);
		},
		appendEntry<T = unknown>(customType: string, data?: T): void {
			if (!appendEntryHandler) {
				throw new Error("appendEntry handler not initialized");
			}
			appendEntryHandler(customType, data);
		},
		registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void {
			messageRenderers.set(customType, renderer as HookMessageRenderer);
		},
		registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void {
			commands.set(name, { name, ...options });
		},
		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},
		logger,
		typebox,
		pi: piCodingAgent,
	} as HookAPI;

	return {
		api,
		messageRenderers,
		commands,
		setSendMessageHandler: (handler: SendMessageHandler) => {
			sendMessageHandler = handler;
		},
		setAppendEntryHandler: (handler: AppendEntryHandler) => {
			appendEntryHandler = handler;
		},
	};
}

/**
 * Load a single hook module using native Bun import.
 */
interface HookPathWithSource {
	path: string;
	sourceLevel?: SourceMeta["level"];
}

async function loadHook(
	hookPath: string,
	cwd: string,
	sourceLevel?: SourceMeta["level"],
): Promise<{ hook: LoadedHook | null; error: string | null }> {
	const resolvedPath = resolvePath(hookPath, cwd);

	try {
		await assertCodeLoadAllowed({
			cwd,
			targetPath: resolvedPath,
			action: `Loading hook module ${hookPath}`,
			sourceLevel,
		});
		const module = await import(resolvedPath);
		const factory = module.default as HookFactory;

		if (typeof factory !== "function") {
			return { hook: null, error: "Hook must export a default function" };
		}

		const handlers = new Map<string, HandlerFn[]>();
		const { api, messageRenderers, commands, setSendMessageHandler, setAppendEntryHandler } = createHookAPI(
			handlers,
			cwd,
		);

		factory(api);

		return {
			hook: {
				path: hookPath,
				resolvedPath,
				handlers,
				messageRenderers,
				commands,
				setSendMessageHandler,
				setAppendEntryHandler,
			},
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { hook: null, error: `Failed to load hook: ${message}` };
	}
}

/**
 * Load all hooks from configuration.
 * @param paths - Array of hook file paths
 * @param cwd - Current working directory for resolving relative paths
 */
export async function loadHooks(paths: HookPathWithSource[], cwd: string): Promise<LoadHooksResult> {
	const hooks: LoadedHook[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const { path: hookPath, sourceLevel } of paths) {
		const { hook, error } = await loadHook(hookPath, cwd, sourceLevel);

		if (error) {
			errors.push({ path: hookPath, error });
			continue;
		}

		if (hook) {
			hooks.push(hook);
		}
	}

	return { hooks, errors };
}

/**
 * Discover and load hooks from all registered providers.
 * Uses the capability API to discover hook paths from:
 * 1. OMP native configs (.omp/.pi hooks/)
 * 2. Installed plugins
 * 3. Other editor/IDE configurations
 *
 * Plus any explicitly configured paths from settings.
 */
export async function discoverAndLoadHooks(configuredPaths: string[], cwd: string): Promise<LoadHooksResult> {
	const allPaths: HookPathWithSource[] = [];
	const seen = new Set<string>();

	// Helper to add paths without duplicates
	const addPaths = (paths: HookPathWithSource[]) => {
		for (const { path: hookPath, sourceLevel } of paths) {
			const resolved = path.resolve(hookPath);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push({ path: hookPath, sourceLevel });
			}
		}
	};

	// 1. Discover hooks via capability API
	const discovered = await loadCapability<Hook>(hookCapability.id, { cwd });
	addPaths(discovered.items.map(hook => ({ path: hook.path, sourceLevel: hook._source.level })));

	// 2. Explicitly configured paths (can override/add)
	addPaths(configuredPaths.map(configuredPath => ({ path: resolvePath(configuredPath, cwd) })));

	return loadHooks(allPaths, cwd);
}
