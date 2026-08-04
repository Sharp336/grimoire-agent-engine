import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { $env, isInteractiveHost, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import { isLowSignalTitleInput } from "../tiny/text";
import { generateSessionTitle } from "../utils/title-generator";
import { buildReplanTitleContext } from "./messages";
import type { SessionManager } from "./session-manager";

type SessionTitleSource = "auto" | "user";
export type SessionNameTrigger = "replan";
export type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;

/** Capabilities the session-title generator borrows from its owning session. */
export interface SessionTitleHost {
	agent(): Agent;
	sessionManager(): SessionManager;
	modelRegistry(): ModelRegistry;
	currentModel(): Model | undefined;
	agentKind(): "main" | "sub";
	extensionRunner(): ExtensionRunner | undefined;
	sessionId(): string;
}

/**
 * Owns automatic session-title generation: first-input titling, the todo-init
 * replan refresh, and the {@link TITLE_SYSTEM.md} override applied to both. The
 * generation abort signal ties every request to session lifecycle so disposal
 * cancels in-flight provider and local-worker inference.
 */
export class SessionTitleGenerator {
	readonly #host: SessionTitleHost;
	readonly #settings: Settings;
	#replanTitleRefreshInFlight: Promise<void> | undefined = undefined;
	/** Resolved TITLE_SYSTEM.md override applied to every automatic session-title
	 *  generation path. Refresh via {@link SessionTitleGenerator.setTitleSystemPrompt}
	 *  when the session cwd changes. */
	#titleSystemPrompt: string | undefined;
	#titleGenerationAbortController = new AbortController();

	constructor(host: SessionTitleHost, settings: Settings, titleSystemPrompt: string | undefined) {
		this.#host = host;
		this.#settings = settings;
		this.#titleSystemPrompt = titleSystemPrompt;
	}

	/** Currently-applied {@link TITLE_SYSTEM.md} override, or undefined when the
	 *  bundled prompt is in effect. Consumed by {@link InteractiveMode} so the
	 *  first-input title path and the replan refresh share one source. */
	get titleSystemPrompt(): string | undefined {
		return this.#titleSystemPrompt;
	}

	/** Replace the title-generation system prompt override. Called by
	 *  {@link InteractiveMode.refreshTitleSystemPrompt} after the session cwd
	 *  changes (e.g. `/move` relocation) so the next replan refresh resolves
	 *  against the destination project's override. */
	setTitleSystemPrompt(prompt: string | undefined): void {
		this.#titleSystemPrompt = prompt;
	}

	/** Cancel in-flight title inference; invoked from session disposal. */
	abort(): void {
		this.#titleGenerationAbortController.abort();
	}

	scheduleReplanTitleRefresh(): void {
		// Headless subagent sessions have no operator-visible title, so a todo-init
		// replan refresh only burns a tiny-model call whose result lands in JSONL
		// and is never shown (issue #5910). In an interactive host the operator can
		// focus a live subagent from the Agent Hub, where the status line renders
		// its session name — so keep the refresh there and only skip subagents when
		// no focusable UI exists (print/RPC/ACP/eval/SDK/CI).
		if (this.#host.agentKind() === "sub" && !isInteractiveHost()) return;
		if (this.#replanTitleRefreshInFlight) return;
		if (!this.#settings.get("title.refreshOnReplan")) return;
		const sessionManager = this.#host.sessionManager();
		if (sessionManager.titleSource === "user") return;
		const context = buildReplanTitleContext(this.#host.agent().state.messages);
		if (!context) return;
		const sessionId = sessionManager.getSessionId();
		const refresh = this.#refreshTitleAfterReplan(context, sessionId)
			.catch(err => {
				logger.warn("title-generator: replan refresh failed", {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				if (this.#replanTitleRefreshInFlight === refresh) {
					this.#replanTitleRefreshInFlight = undefined;
				}
			});
		this.#replanTitleRefreshInFlight = refresh;
	}

	/**
	 * Start automatic title generation when the session and input are eligible.
	 * Interactive and CLI-bootstrap submissions share this gate so every first
	 * user message persists titles with the same environment, signal, and local
	 * extension-command policy.
	 */
	maybeStartTitleGeneration(
		firstMessage: string,
		onStart?: () => void,
		generateTitle: (message: string) => Promise<string | null> = message => this.generateTitle(message),
	): void {
		const sessionManager = this.#host.sessionManager();
		const extensionCommandSpace = firstMessage.indexOf(" ");
		const isLocalExtensionCommand =
			firstMessage.startsWith("/") &&
			this.#host
				.extensionRunner()
				?.getCommand(
					extensionCommandSpace === -1 ? firstMessage.slice(1) : firstMessage.slice(1, extensionCommandSpace),
				) !== undefined;
		if (
			isLocalExtensionCommand ||
			sessionManager.getSessionName() ||
			$env.PI_NO_TITLE ||
			isLowSignalTitleInput(firstMessage)
		) {
			return;
		}
		onStart?.();
		generateTitle(firstMessage)
			.then(async title => {
				// Re-check after generation so concurrent attempts cannot replace
				// the first title that completed.
				if (title && !sessionManager.getSessionName()) {
					await sessionManager.setSessionName(title, "auto");
				}
			})
			.catch(err => {
				logger.warn("title-generator: uncaught auto-title error", {
					sessionId: this.#host.sessionId(),
					reason: "uncaught-auto-title-error",
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	/**
	 * Generate an automatic session title tied to this session's lifecycle.
	 * Input and replan callers share the signal so disposal cancels provider and
	 * local-worker inference instead of leaving background inference alive.
	 */
	generateTitle(firstMessage: string): Promise<string | null> {
		const agent = this.#host.agent();
		return generateSessionTitle(
			firstMessage,
			this.#host.modelRegistry(),
			this.#settings,
			this.#host.sessionId(),
			this.#host.currentModel(),
			provider => agent.metadataForProvider(provider),
			this.#titleSystemPrompt,
			this.#titleGenerationAbortController.signal,
		);
	}

	async #refreshTitleAfterReplan(context: string, sessionId: string): Promise<void> {
		const title = await this.generateTitle(context);
		if (!title) return;
		const sessionManager = this.#host.sessionManager();
		if (sessionManager.getSessionId() !== sessionId) return;
		if (!this.#settings.get("title.refreshOnReplan")) return;
		if (sessionManager.titleSource === "user") return;
		const setSessionName = sessionManager.setSessionName as SetSessionNameWithTrigger;
		await setSessionName.call(sessionManager, title, "auto", "replan");
	}
}
