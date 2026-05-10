/**
 * Credential-disabled bridge helpers.
 *
 * These wire `AuthStorage`'s single-slot `onCredentialDisabled` callback to the per-session
 * `ExtensionRunner` and to any handler the embedder already attached. Two helpers, both
 * called from `createAgentSession`:
 *
 * - {@link installStartupBuffer}: installs a transient buffering wrapper as the AuthStorage
 *   handler at the very top of session creation. Captures events fired during model-restore
 *   and fallback-model probes (which happen before the runner exists), while still
 *   forwarding to whatever embedder handler was previously attached. Returns the buffer +
 *   a remover.
 *
 * - {@link installCredentialDisabledBridge}: replaces the wrapper with a bridge that fans
 *   events to the runner AND to the embedder's handler. Optionally drains a startup buffer
 *   to the runner. Returns a release function that marks the bridge disposed and restores
 *   the most-recent non-disposed previous handler if the slot is still ours.
 *
 * The bridge tracks `__previousHandler` and `__disposed` flags on the function object so
 * concurrent sibling bridges (parallel subagents sharing one AuthStorage) don't get a dead
 * predecessor re-installed when the later sibling disposes. Long-term this whole dance
 * goes away when AuthStorage moves to a multi-subscriber API
 * (see ~/workspace/OMP_MULTI_SUBSCRIBER_REFACTOR.md).
 */

import type { AuthStorage, CredentialDisabledEvent } from "@oh-my-pi/pi-ai";
import type { ExtensionRunner } from "./runner";

type AuthCredentialDisabledHandler = (event: CredentialDisabledEvent) => void | Promise<void>;

type CredentialDisabledBridge = AuthCredentialDisabledHandler & {
	readonly __isCredentialDisabledBridge: true;
	__disposed: boolean;
	__previousHandler: AuthCredentialDisabledHandler | undefined;
};

function isCredentialDisabledBridge(
	handler: AuthCredentialDisabledHandler | undefined,
): handler is CredentialDisabledBridge {
	return (
		typeof handler === "function" &&
		(handler as Partial<CredentialDisabledBridge>).__isCredentialDisabledBridge === true
	);
}

/**
 * Walk past disposed bridges in a previous-handler chain, returning the first non-disposed
 * handler (which may itself be a non-bridge embedder handler, an undisposed sibling bridge,
 * or `undefined` if the entire chain is disposed).
 */
function unwindDisposedBridges(
	handler: AuthCredentialDisabledHandler | undefined,
): AuthCredentialDisabledHandler | undefined {
	let cursor = handler;
	while (isCredentialDisabledBridge(cursor) && cursor.__disposed) {
		cursor = cursor.__previousHandler;
	}
	return cursor;
}

/**
 * Installs a transient buffering wrapper around the currently attached
 * `onCredentialDisabled` handler.
 *
 * Events fired through the wrapper are pushed onto the returned `buffer` AND awaited
 * against the previous handler (if one was attached). When the per-session bridge becomes
 * available, the caller drains `buffer` to the runner and calls `remove()` to take the
 * wrapper out of the slot.
 */
export function installStartupBuffer(authStorage: AuthStorage): {
	buffer: CredentialDisabledEvent[];
	remove: () => void;
} {
	const buffer: CredentialDisabledEvent[] = [];
	const previousHandler = authStorage.getCredentialDisabledHandler();
	const wrapper: AuthCredentialDisabledHandler = async event => {
		buffer.push(event);
		if (previousHandler) {
			await previousHandler(event);
		}
	};
	authStorage.setCredentialDisabledHandler(wrapper);
	return {
		buffer,
		remove: () => {
			// Only un-install if our wrapper is still the active handler. If something else
			// has been installed in the meantime (e.g. the bridge has already taken over),
			// leave the slot alone — the caller owns sequencing.
			if (authStorage.getCredentialDisabledHandler() === wrapper) {
				authStorage.setCredentialDisabledHandler(previousHandler);
			}
		},
	};
}

/**
 * Installs a bridge that forwards `credential_disabled` events to the given
 * `ExtensionRunner` and (composed) to whatever handler was attached when the bridge was
 * installed. The bridge tracks a `__disposed` flag so it short-circuits future invocations
 * once released, and so a later bridge restoring its previous handler can walk past
 * disposed predecessors.
 *
 * If `startupBuffer` is provided, those events are drained to `runner.emit` only — the
 * assumption is that the embedder's handler already received them via the startup wrapper
 * (see {@link installStartupBuffer}).
 *
 * Returns a release function that:
 *
 * 1. Marks the bridge as disposed so it stops fanning out events (defensive — a sibling
 *    bridge that captured this one as its previous handler will skip past us on emit).
 * 2. Restores the most-recent non-disposed previous handler if our bridge is still
 *    installed in the slot. If a later session has overwritten the slot, leaves it alone.
 */
export function installCredentialDisabledBridge(
	authStorage: AuthStorage,
	runner: ExtensionRunner,
	startupBuffer?: CredentialDisabledEvent[],
): () => void {
	const previousHandler = authStorage.getCredentialDisabledHandler();

	const handler: AuthCredentialDisabledHandler = async event => {
		if (bridge.__disposed) return;
		await runner.emit({ type: "credential_disabled", ...event });
		const livePrev = unwindDisposedBridges(bridge.__previousHandler);
		if (livePrev) {
			await livePrev(event);
		}
	};
	const bridge: CredentialDisabledBridge = Object.assign(handler, {
		__isCredentialDisabledBridge: true as const,
		__disposed: false,
		__previousHandler: previousHandler,
	});

	authStorage.setCredentialDisabledHandler(bridge);

	if (startupBuffer && startupBuffer.length > 0) {
		// Drain to the runner only. The embedder's handler already saw these via the
		// startup wrapper.
		for (const event of startupBuffer) {
			void runner.emit({ type: "credential_disabled", ...event });
		}
	}

	return () => {
		bridge.__disposed = true;
		if (authStorage.getCredentialDisabledHandler() !== bridge) return;
		authStorage.setCredentialDisabledHandler(unwindDisposedBridges(bridge.__previousHandler));
	};
}
