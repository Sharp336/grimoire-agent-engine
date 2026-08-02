import * as path from "node:path";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import sideBoundaryPrompt from "../../prompts/system/side-boundary.md" with { type: "text" };
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { SIDE_BOUNDARY_MESSAGE_TYPE } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { SIDE_AGENT_ID, SIDE_SESSION_FILE_PREFIX } from "../../session/side-conversation";
import { createMCPProxyTools } from "../../task/executor";
import { shortenPath } from "../../tools/render-utils";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { InteractiveModeContext } from "../types";

const SIDE_STATUS = "Side conversation — Esc returns to main, /side end discards it";
const DISPOSE_FAILURE_MESSAGE = "Side conversation ended, but its file could not be deleted";

/** A deferred question submit, run outside the lifecycle queue. */
type SubmitClosure = () => Promise<void>;

/** Outcome of {@link SideController.#handleExistingRef}: proceed to create, or done (optionally submit). */
type RefHandling = { outcome: "proceed" } | { outcome: "done"; submit?: SubmitClosure };

export class SideController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	// Lifecycle operations (dispatch, preconditions, reuse/stale handling,
	// create, focus, status overwrite) are serialized through this queue so
	// start()/dispose() cannot interleave at await points — a /side end fired
	// during an in-flight create waits for the create to finish, then disposes
	// the live session, rather than early-returning and leaving the side alive.
	// The question submit runs AFTER the queued op resolves (in start()), so a
	// /side end, session transition, or shutdown during a long side turn is not
	// blocked by the in-flight prompt — AgentSession.dispose handles in-flight
	// turns. The registry ref classification below stays as defense-in-depth for
	// refs created outside the queue (a failed create the SDK did not clean up,
	// platform lifecycle actions); the queue is the primary mechanism.
	#queue: Promise<void> = Promise.resolve();

	/** `/side` (create+focus), `/side <question>` (create+focus+ask), `/side end` (discard). */
	async start(args: string): Promise<void> {
		const lifecycleOp = this.#queue.then(() => this.#startImpl(args));
		this.#queue = lifecycleOp.then(
			() => {},
			() => {},
		);
		const submit = await lifecycleOp;
		if (submit) await submit();
	}

	async #startImpl(args: string): Promise<SubmitClosure | undefined> {
		const trimmed = args.trim();
		if (trimmed === "end") {
			const existed = AgentRegistry.global().get(SIDE_AGENT_ID) !== undefined;
			const ok = await this.#disposeImpl();
			if (!existed) this.ctx.showStatus("No side conversation to end");
			else if (ok) this.ctx.showStatus("Side conversation ended");
			return;
		}

		const question = trimmed;
		const ctx = this.ctx;

		// Preconditions — each matches an exact sibling string in the codebase.
		if (ctx.collabGuest) {
			ctx.showError("/side is unavailable in a collab session");
			return;
		}
		if (ctx.focusedAgentId) {
			ctx.showError("Already viewing an agent — press ←← to return first");
			return;
		}
		const session = ctx.session;
		const model = session.model;
		if (!model) {
			ctx.showError("No active model available for /side.");
			return;
		}
		const parentFile = ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			ctx.showError("/side requires a persisted session.");
			return;
		}

		// Reuse, busy, or stale-ref reclaim — shared with the create-race catch.
		const handling = await this.#handleExistingRef(question);
		if (handling.outcome === "done") return handling.submit;

		// --- Create path ---
		const parentSessionId = session.sessionId;
		const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
		const thinkingLevel = session.configuredThinkingLevel();
		const toolNames = session.getActiveToolNames();
		const extensionPaths = session.extensionPaths;
		const modelRegistry = session.modelRegistry;
		const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
		const mcpManager = ctx.mcpManager;
		const cwd = ctx.sessionManager.getCwd();
		const parentStorage = ctx.sessionManager.getStorage();
		const localProtocolOptions = {
			// Live getters, not captured values: the SDK installs these as the
			// process-global local:// mapping, so they must track the CURRENT
			// parent. A committed session switch then repoints the mapping without
			// any restore-on-dispose work.
			getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
		};

		const sessionDir = parentFile.slice(0, -6);
		const sideFile = path.join(sessionDir, `${SIDE_SESSION_FILE_PREFIX}${Snowflake.next()}.jsonl`);

		await ctx.sessionManager.ensureOnDisk();
		await ctx.sessionManager.flush();

		let side: AgentSession | undefined;
		let capturedRef: AgentRef | undefined;
		const reinject = () =>
			side?.agent.appendMessage({
				role: "developer",
				content: sideBoundaryPrompt,
				attribution: "agent",
				timestamp: Date.now(),
			});

		try {
			const sideManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, parentStorage, {
				suppressBreadcrumb: true,
				sessionFile: sideFile,
			});

			const created = await sdk.createAgentSession({
				cwd,
				sessionManager: sideManager,
				model,
				thinkingLevel,
				toolNames: toolNames.filter(name => name !== "task" && name !== "hub"),
				spawns: "",
				providerSessionId: `${parentSessionId}:side:${Snowflake.next()}`,
				providerPromptCacheKey: parentPromptCacheKey,
				modelRegistry,
				authStorage: modelRegistry.authStorage,
				settings: this.ctx.settings,
				hasUI: true,
				enableMCP: false,
				customTools: mcpManager ? createMCPProxyTools(mcpManager) : undefined,
				enableLsp: this.ctx.settings.get("task.enableLsp") !== false,
				agentId: SIDE_AGENT_ID,
				agentDisplayName: "side",
				taskDepth: 1,
				parentAgentId: ownerId,
				agentRegistry: AgentRegistry.global(),
				expectedAgentRef: null,
				disableExtensionDiscovery: true,
				preloadedExtensionPaths: extensionPaths,
				extensions: [pi => pi.on("session_compact", reinject)],
				localProtocolOptions,
			});
			side = created.session;
			// Capture the ref ONLY if it owns the session we just constructed — an
			// external replacement between the SDK's attach and this read would
			// otherwise be unregistered by captured-generation cleanup.
			const registered = AgentRegistry.global().get(SIDE_AGENT_ID);
			capturedRef = registered?.session === side ? registered : undefined;
			const uiContext = this.ctx.getToolUIContext();
			if (uiContext) created.setToolUIContext(uiContext, true);

			// 1. Clear inherited todos so the fork does not drag the parent's task.
			side.setTodoPhases([]);
			sideManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });

			// 2. Append the boundary as one message that is both model context and
			//    a visible transcript rule. A freshly created session is idle, so
			//    triggerTurn:false + deliverAs:"nextTurn" appends without starting
			//    a turn.
			await side.sendCustomMessage(
				{ customType: SIDE_BOUNDARY_MESSAGE_TYPE, content: sideBoundaryPrompt, display: true, attribution: "user" },
				{ triggerTurn: false, deliverAs: "nextTurn" },
			);

			// 3. Append session-init so the side transcript describes itself for
			//    inspection and export (cold revival is excluded from the persisted
			//    agent scan), using the post-filter tool list.
			sideManager.appendSessionInit({
				systemPrompt: side.systemPrompt.join("\n\n"),
				task: question || "side conversation",
				tools: side.getActiveToolNames(),
			});

			// 4. Re-inject the boundary after any successful compaction. Both
			//    manual and automatic compaction emit "session_compact" through
			//    the extension runner on success (session-maintenance.ts:863 and
			//    :2747), so the inline extension factory above is the single
			//    mechanism — no separate event-stream subscription is needed.

			// Focus, then overwrite the status string focusAgent emits (it is
			// written for viewing a subagent and is wrong for a side conversation).
			await ctx.focusAgentSession(SIDE_AGENT_ID);
			// Revalidate: an external generation may have replaced ours during
			// the focus await (a concurrent dispose + create, or a platform
			// lifecycle action). If so, do not submit against the stale captured
			// session — surface the busy error and clean up only the captured
			// generation, never the replacement.
			if (AgentRegistry.global().get(SIDE_AGENT_ID)?.session !== side) {
				ctx.showError("Side conversation is still starting — try again in a moment");
				await this.#cleanupCapturedGeneration(side, capturedRef, sideFile);
				await ctx.unfocusSession().catch(() => {});
				return undefined;
			}
			ctx.showStatus(SIDE_STATUS);

			// Return a submit closure so the question is asked outside the
			// lifecycle queue — a /side end or shutdown during the turn is not
			// blocked by it. The status overwrite above is the last status the
			// controller emits on this path.
			const sideSession = side;
			return question ? () => this.#submitQuestion(sideSession, question) : undefined;
		} catch (error) {
			if (side) {
				// A session was constructed — clean up the CAPTURED generation
				// only, not whatever owns the id now. An external replacement
				// may have won the slot during the failed operation; routing
				// through #disposeImpl would destroy the replacement while
				// leaking the captured session and its file.
				await this.#cleanupCapturedGeneration(side, capturedRef, sideFile);
				await ctx.unfocusSession().catch(() => {});
				ctx.showError(error instanceof Error ? error.message : String(error));
				return undefined;
			}
			// createAgentSession threw before a session existed (the
			// expectedAgentRef:null race or another failure). Clear the orphan
			// fork, then route the winning ref through the same handling the
			// top of start() uses — a mid-init winner (session: null, status:
			// "running") surfaces the clean "still starting" error instead of
			// the raw registration exception.
			await this.#removeSideFile(sideFile, "Side conversation setup failed, and its fork file could not be deleted");
			const catchHandling = await this.#handleExistingRef(question);
			if (catchHandling.outcome === "done") return catchHandling.submit;
			await ctx.unfocusSession().catch(() => {});
			ctx.showError(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}

	async dispose(): Promise<void> {
		const op = this.#queue.then(() => this.#disposeImpl().then(() => {}));
		this.#queue = op.catch(() => {});
		await op;
	}

	/**
	 * Discard the side conversation. Resolves `true` ⇔ the Side ref is gone
	 * from the registry AND (its file is gone or never existed). Resolves
	 * `false` when something remains AND every remnant (a leaked file or a
	 * surviving generation) is covered by a shown `ctx.showError` explaining
	 * why — one remnant means one error, two remnants two. Never rejects:
	 * errors are caught and surfaced via `#removeSideFile`, session-dispose
	 * errors are only warned. An externally-created in-flight generation
	 * (null-session `running` ref not from this controller) is never
	 * unregistered, deleted, or focused — it survives, but the user is told,
	 * not shown a false success.
	 */
	async #disposeImpl(): Promise<boolean> {
		// A focused side must be unfocused BEFORE disposal unregisters it: the
		// registry-event auto-unfocus is fire-and-forget, and its in-flight
		// #attach(main) can race a subsequent focusAgentSession("side.internal") into a
		// wrong final focus state.
		if (this.ctx.focusedAgentId === SIDE_AGENT_ID) {
			try {
				await this.ctx.unfocusSession();
			} catch (error) {
				logger.warn("Failed to unfocus side session before disposal", { error: String(error) });
			}
		}
		let cleanupFailed = false;

		// Reclassifying loop. Each iteration re-reads the registry, so every
		// success exit is preceded by a fresh read showing nothing named side.internal
		// remains. The body never assumes a ref stays classified the same
		// across an await: the SDK dispose wrapper unregisters in its `finally`
		// UNLESS the lifecycle manager is parking the ref (sdk.ts:1632-1640,
		// 3428-3429), so `await ref.session.dispose()` can leave the SAME ref
		// registered with status "parked", session null — and a concurrent
		// start() can replace it entirely. Each `continue` re-reads to
		// reclassify whatever is actually there now. Each iteration corresponds
		// to a real concurrent generation change, so the loop is bounded in
		// practice.
		//
		// Invariant: every `return true` is preceded by a registry read
		// showing nothing named side.internal; every `return false` is preceded by one
		// shown error per remnant that remains (a leaked file or a surviving
		// generation — one remnant means one error, two remnants two); a
		// captured ref's file is deleted only when its ref is
		// gone from the registry or its unregister was won; a lost unregister
		// never deletes anything. Side filenames are unique per generation
		// (side.internal-<snowflake>.jsonl), so a captured ref's file is never a
		// replacement generation's file — deleting it after the ref left the
		// registry, or after a won unregister, is always safe.
		for (;;) {
			const ref = AgentRegistry.global().get(SIDE_AGENT_ID);
			if (!ref) return !cleanupFailed;

			// In-flight pre-registration: the SDK registers a null-session
			// "running" ref before attaching the live session (sdk.ts:2950-
			// 2958). Deleting its file would leave the creator attaching a
			// live session backed by a deleted JSONL. Never touch it; tell
			// the user instead of reporting a false success.
			if (ref.session === null && ref.status === "running") {
				this.ctx.showError("Side conversation is still starting — try again in a moment");
				return false;
			}

			// Stale ref: null session, parked or aborted (a failed prior
			// dispose, or the SDK wrapper that left it parked for revival).
			// Reclaim the slot synchronously before any await so a concurrent
			// start() cannot register a fresh live Side whose file a delayed
			// delete would orphan.
			if (ref.session === null) {
				const won = AgentRegistry.global().unregister(SIDE_AGENT_ID, ref);
				if (!won) continue; // another generation owns the id; reclassify it
				if (ref.sessionFile && !(await this.#removeSideFile(ref.sessionFile, DISPOSE_FAILURE_MESSAGE)))
					cleanupFailed = true;
				continue; // re-read to confirm the slot is empty
			}

			// Live ref: dispose the session, then re-read the registry.
			try {
				await ref.session.dispose();
			} catch (error) {
				logger.warn("Failed to dispose side session", { error: String(error) });
			}

			// After the await the same ref may still be registered — the
			// wrapper left it parked for revival (sdk.ts:1632-1640), but the
			// user asked to end it. Or a concurrent start() may have replaced
			// it. Re-read and reclassify by identity.
			if (AgentRegistry.global().get(SIDE_AGENT_ID) === ref) {
				// Same ref survived as parked. Reclaim it now.
				const won = AgentRegistry.global().unregister(SIDE_AGENT_ID, ref);
				if (!won) continue; // replaced between the two reads; reclassify
				if (ref.sessionFile && !(await this.#removeSideFile(ref.sessionFile, DISPOSE_FAILURE_MESSAGE)))
					cleanupFailed = true;
				continue;
			}
			// Ref absent or replaced: the captured file is unique per
			// generation and now unreferenced, so it is safe to delete.
			if (ref.sessionFile && !(await this.#removeSideFile(ref.sessionFile, DISPOSE_FAILURE_MESSAGE)))
				cleanupFailed = true;
		}
	}

	/**
	 * Delete a side session file. Resolves `true` when the file is gone (or
	 * never existed — `removeSessionFiles` swallows ENOENT); `false` when the
	 * deletion failed, in which case the user has already been shown the error
	 * (the caller-supplied `failureMessage` prefix plus the shortened path) and
	 * a warning logged. Never rejects: a leaked `side.internal-*.jsonl` must not break
	 * shutdown or session transitions that await disposal.
	 */
	async #removeSideFile(sessionFile: string, failureMessage: string): Promise<boolean> {
		try {
			// Storage of the CURRENT parent manager. Documented limitation: a side
			// inherited from a different-backend session (crashed previous process,
			// or a backend switch while the side was live) may not be deletable
			// through this backend; such files stay inert on disk until the user
			// removes them (the persisted scan skips side files without deleting).
			await SessionManager.removeSessionFiles(sessionFile, this.ctx.sessionManager.getStorage());
			return true;
		} catch (err) {
			logger.warn("Failed to remove side session file", { sessionFile, error: String(err) });
			this.ctx.showError(`${failureMessage}: ${shortenPath(sessionFile)}`);
			return false;
		}
	}

	/**
	 * Clean up the CAPTURED side generation only: dispose its session directly,
	 * generation-checked unregister its ref, and delete its file. Never touches
	 * a replacement generation that won the id — `unregister` is generation-
	 * checked (returns false when `capturedRef` is no longer the registered
	 * ref), and `sideFile` is unique per generation. Used by both the create-
	 * failure catch and the post-focus revalidation, so neither routes through
	 * the id-wide `#disposeImpl` loop that could destroy an external
	 * replacement while leaking the captured session and file.
	 */
	async #cleanupCapturedGeneration(
		side: AgentSession,
		capturedRef: AgentRef | undefined,
		sideFile: string,
	): Promise<void> {
		try {
			await side.dispose();
		} catch (error) {
			logger.warn("Failed to dispose captured side session", { error: String(error) });
		}
		// Generation-checked: a no-op if dispose already unregistered the ref,
		// or if a replacement won the id. Reclaims a parked ref the SDK wrapper
		// left behind for revival.
		if (capturedRef) AgentRegistry.global().unregister(SIDE_AGENT_ID, capturedRef);
		await this.#removeSideFile(sideFile, "Side conversation setup failed, and its fork file could not be deleted");
	}

	async #submitQuestion(side: AgentSession, question: string): Promise<void> {
		const ctx = this.ctx;
		try {
			await ctx.withLocalSubmission(question, () => side.prompt(question, { streamingBehavior: "steer" }));
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
		ctx.updatePendingMessagesDisplay();
		ctx.ui.requestRender();
	}

	/**
	 * Handle an existing Side registry ref: reuse a live session, report a busy
	 * initializing one, or reclaim a stale one. Returns `{ outcome: "proceed" }`
	 * when the caller should create (no ref, or a stale ref was reclaimed);
	 * returns `{ outcome: "done", submit? }` when the ref was reused or is busy
	 * — the caller returns, optionally running the submit closure outside the
	 * lifecycle queue.
	 */
	async #handleExistingRef(question: string): Promise<RefHandling> {
		const ctx = this.ctx;
		const registry = AgentRegistry.global();
		const existing = registry.get(SIDE_AGENT_ID);
		if (!existing) return { outcome: "proceed" };

		// Parentage validation: the side file lives at <parentArtifactDir>/<name>.jsonl.
		// Some parent-session transitions (SelectorController.handleResumeSession from
		// the blank /resume picker, handoff) do not invoke this controller's dispose,
		// so after switching from parent A to parent B the registry can still hold A's
		// Side ref. Reusing it would fork from the wrong context (possibly wrong cwd).
		// On mismatch, dispose the foreign side (its file is deleted from the OLD
		// parent's artifact dir — correct) and fall through to create against the
		// current parent. If disposal cannot complete (a running foreign ref another
		// process is still creating), surface the busy error and stop — do not fall
		// through to a create that will fail the registration race.
		const currentParentFile = ctx.sessionManager.getSessionFile();
		if (currentParentFile && existing.sessionFile) {
			const currentArtifactDir = currentParentFile.slice(0, -6) + path.sep;
			if (!existing.sessionFile.startsWith(currentArtifactDir)) {
				const disposed = await this.#disposeImpl();
				if (!disposed) return { outcome: "done" };
				return { outcome: "proceed" };
			}
		}

		// Reuse path: a live side session already exists — focus it, no new fork.
		// Registry ids are re-resolved across awaits (SessionFocusController
		// .focusAgent → AgentLifecycleManager.ensureLive re-reads by id), so a
		// captured ref must be revalidated before use: a concurrent dispose +
		// new create can replace `existing` with a fresh null-session running
		// generation during the focus await, which would either throw the
		// lifecycle's raw "running agent cannot be revived" error or focus a
		// different generation than the one we captured.
		if (existing.session) {
			try {
				await ctx.focusAgentSession(SIDE_AGENT_ID);
			} catch (error) {
				const current = registry.get(SIDE_AGENT_ID);
				if (current?.session !== existing.session) {
					ctx.showError("Side conversation is still starting — try again in a moment");
					return { outcome: "done" };
				}
				ctx.showError(error instanceof Error ? error.message : String(error));
				return { outcome: "done" };
			}
			// Focus succeeded — re-read the registry and confirm the generation
			// is still the one we captured. If a concurrent dispose + create
			// swapped in a new session, do not submit the question against the
			// stale captured session.
			if (registry.get(SIDE_AGENT_ID)?.session !== existing.session) {
				ctx.showError("Side conversation is still starting — try again in a moment");
				return { outcome: "done" };
			}
			ctx.showStatus(SIDE_STATUS);
			// Capture the session for the closure; the revalidation above
			// confirmed the registry still holds it. The closure runs outside
			// the queue, so a concurrent dispose may still land first —
			// #submitQuestion's try/catch handles a prompt on a disposed session.
			const session = existing.session;
			return { outcome: "done", submit: question ? () => this.#submitQuestion(session, question) : undefined };
		}

		// Stale-ref path: ref exists but session is null. A genuinely stale ref
		// (parked/aborted after a failed dispose) is reclaimed below; but the SDK
		// pre-registers with session: null, status: "running" BEFORE attaching the
		// live session (sdk.ts:2949-2958, attached at 3380-3386), so a running
		// status means another start() is mid-create. Unregistering that
		// generation would delete a live initializing session's file and make its
		// generation-checked attach fail — losing the user's side conversation.
		if (existing.status === "running") {
			ctx.showError("Side conversation is still starting — try again in a moment");
			return { outcome: "done" };
		}

		// Stale: parked/aborted. Reclaim the slot before any await — a concurrent
		// start() could register a fresh live Side that the resumed call would
		// otherwise unregister and whose file it would delete.
		const won = registry.unregister(SIDE_AGENT_ID, existing);
		if (!won) {
			// Another generation already won. The replacement ref may be a live
			// session (reuse), a still-initializing running ref (busy), another
			// stale ref (reclaim again), or already gone (create). Reclassify it
			// through the same four-way classifier instead of focusing blindly — a
			// null-session running ref must surface the busy error, not trigger
			// revival. Each recursion is a real concurrent generation change, so
			// depth is bounded in practice. Never delete the original ref's file
			// here: the replacement generation may own a different file.
			return this.#handleExistingRef(question);
		}
		if (existing.sessionFile) {
			await this.#removeSideFile(existing.sessionFile, "Failed to delete the previous side conversation file");
		}
		return { outcome: "proceed" };
	}
}
