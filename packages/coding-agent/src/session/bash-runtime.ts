import type { BashResult } from "../exec/bash-executor";
import { executeBash as executeBashCommand } from "../exec/bash-executor";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";
import type { BashExecutionMessage } from "./messages";

/**
 * Host interface for {@link BashRuntime}. The owning session supplies these
 * callbacks so the runtime stays free of direct session / agent references.
 */
export interface BashRuntimeHost {
	/** Whether the agent is currently streaming a response. */
	isStreaming(): boolean;
	/** Current working directory for the session. */
	getCwd(): string;
	/** Stable session identifier passed to the bash executor. */
	getSessionKey(): string;
	/** Append a message to the in-memory agent state. */
	appendToAgent(message: BashExecutionMessage): void;
	/** Persist a message to the session store. */
	appendToSession(message: BashExecutionMessage): void;
	/** Persist the original (pre-minimisation) artifact. */
	saveOriginalArtifact(text: string): Promise<string | undefined>;
	/**
	 * Invoke the `user_bash` extension hook. Returns the hook result when an
	 * extension handled the command, or `undefined` to fall through to the
	 * built-in executor.
	 */
	runUserBashHook(input: {
		command: string;
		excludeFromContext: boolean;
		cwd: string;
	}): Promise<BashResult | undefined>;
}

/**
 * Owns the abort-controller set and pending-message buffer for bash
 * execution. Extracted from {@link AgentSession} to shrink the host class;
 * every public method maps 1-to-1 to the previous private/inline code.
 */
export class BashRuntime {
	readonly #host: BashRuntimeHost;
	readonly #abortControllers = new Set<AbortController>();
	#pendingMessages: BashExecutionMessage[] = [];

	constructor(host: BashRuntimeHost) {
		this.#host = host;
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.useUserShell If true, allow caller to request configured user-shell routing
	 */
	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.getCwd();

		const hookResult = await this.#host.runUserBashHook({
			command,
			excludeFromContext,
			cwd,
		});
		if (hookResult) {
			this.record(command, hookResult, options);
			return hookResult;
		}

		const abortController = new AbortController();
		this.#abortControllers.add(abortController);

		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.#host.getSessionKey(),
				cwd,
				timeout: clampTimeout("bash") * 1000,
				onMinimizedSave: originalText => this.#host.saveOriginalArtifact(originalText),
				useUserShell: options?.useUserShell,
			});

			this.record(command, result, options);
			return result;
		} finally {
			this.#abortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by execute and by extensions that handle bash execution themselves.
	 */
	record(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.#host.isStreaming()) {
			// Queue for later - will be flushed on agent_end
			this.#pendingMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.#host.appendToAgent(bashMessage);

			// Save to session
			this.#host.appendToSession(bashMessage);
		}
	}

	/** Cancel all running bash commands. */
	abort(): void {
		for (const abortController of this.#abortControllers) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running. */
	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed. */
	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	flushPendingMessages(): void {
		if (this.#pendingMessages.length === 0) return;

		for (const bashMessage of this.#pendingMessages) {
			// Add to agent state
			this.#host.appendToAgent(bashMessage);

			// Save to session
			this.#host.appendToSession(bashMessage);
		}

		this.#pendingMessages = [];
	}
}
