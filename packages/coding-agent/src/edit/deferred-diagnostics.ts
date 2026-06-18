import { type FileDiagnosticsResult, type WritethroughDeferredHandle } from "../lsp";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import type { DeferredDiagnosticsEntry, ToolSession } from "../tools";

/**
 * Owns the deferred-diagnostics wiring previously inlined on {@link EditTool}.
 * Extracted so other tools (e.g. the upcoming `symbol` tool's `manipulate`
 * action, which routes through the same hashline apply pipeline) can reuse one
 * implementation instead of duplicating private state.
 *
 * Pure relocation of `EditTool`'s `#beginDeferredDiagnosticsForPath`,
 * `#injectLateDiagnostics`, `#bumpFileVersion`, and `#fileVersion` — no
 * behavior change.
 */
export class EditDiagnosticsTracker {
	readonly #dedupDiagnostics: boolean;
	readonly #pendingDeferredFetches = new Map<string, AbortController>();
	/** Fallback per-path mutation counter used only when the session does not expose
	 *  a shared one. Prefer `session.bumpFileMutationVersion` so write (and any other
	 *  tool) mutating the same file also invalidates pending late-diagnostics. */
	readonly #editVersionByPath = new Map<string, number>();

	constructor(private readonly session: ToolSession) {
		this.#dedupDiagnostics =
			(session.enableLsp ?? true) &&
			session.settings.get("lsp.diagnosticsOnEdit") &&
			session.settings.get("lsp.diagnosticsDeduplicate");
	}

	beginDeferredDiagnosticsForPath(path: string): WritethroughDeferredHandle {
		const existingDeferred = this.#pendingDeferredFetches.get(path);
		if (existingDeferred) {
			existingDeferred.abort();
			this.#pendingDeferredFetches.delete(path);
		}

		const deferredController = new AbortController();
		const editVersion = this.#bumpFileVersion(path);
		return {
			onDeferredDiagnostics: (lateDiagnostics: FileDiagnosticsResult) => {
				this.#pendingDeferredFetches.delete(path);
				this.#injectLateDiagnostics(path, lateDiagnostics, editVersion);
			},
			signal: deferredController.signal,
			finalize: (diagnostics: FileDiagnosticsResult | undefined) => {
				if (!diagnostics) {
					this.#pendingDeferredFetches.set(path, deferredController);
				} else {
					deferredController.abort();
				}
			},
		};
	}

	#injectLateDiagnostics(path: string, diagnostics: FileDiagnosticsResult, editVersion: number): void {
		const effective = this.#dedupDiagnostics
			? getDiagnosticsLedger(this.session).reduce(path, diagnostics)
			: diagnostics;
		if (this.#dedupDiagnostics && effective.messages.length === 0) return;

		const entry: DeferredDiagnosticsEntry = {
			path,
			summary: effective.summary ?? "",
			messages: effective.messages ?? [],
			errored: effective.errored,
			// Drop at flush time if a later edit to the same file superseded this fetch.
			isStale: () => this.#fileVersion(path) !== editVersion,
		};
		this.session.queueDeferredDiagnostics?.(entry);
	}

	/** Bump the file's mutation counter (session-global when available). */
	#bumpFileVersion(path: string): number {
		if (this.session.bumpFileMutationVersion) return this.session.bumpFileMutationVersion(path);
		const next = (this.#editVersionByPath.get(path) ?? 0) + 1;
		this.#editVersionByPath.set(path, next);
		return next;
	}

	/** Read the file's current mutation counter (session-global when available). */
	#fileVersion(path: string): number {
		if (this.session.getFileMutationVersion) return this.session.getFileMutationVersion(path);
		return this.#editVersionByPath.get(path) ?? 0;
	}
}
