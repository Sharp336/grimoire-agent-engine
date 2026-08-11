export interface RpcSessionAuthorityToken {
	readonly sessionId: string;
	readonly sessionGeneration: number;
	readonly authorityGeneration: number;
}

export interface RpcSessionTransitionToken extends RpcSessionAuthorityToken {
	readonly transitionGeneration: number;
}

export interface RpcExecutionAuthorityTransitionToken extends RpcSessionAuthorityToken {
	readonly executionTransitionGeneration: number;
}

export type RpcSessionAuthorityErrorCode = "session_busy" | "session_changed" | "authority_changed";

export class RpcSessionAuthorityError extends Error {
	constructor(
		readonly code: RpcSessionAuthorityErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RpcSessionAuthorityError";
	}
}

/**
 * Single admission and continuation authority for one long-lived RPC daemon.
 * Session transitions invalidate both session-owned and privilege-sensitive
 * work before cancellation starts. Collaboration lifecycle changes invalidate
 * only privilege-sensitive continuations.
 */
export class RpcSessionAuthorityCoordinator {
	readonly #getSessionId: () => string;
	#sessionGeneration = 0;
	#authorityGeneration = 0;
	#transitionGeneration = 0;
	#activeTransition: RpcSessionTransitionToken | undefined;
	#executionTransitionGeneration = 0;
	#activeExecutionTransition: RpcExecutionAuthorityTransitionToken | undefined;

	constructor(getSessionId: () => string) {
		this.#getSessionId = getSessionId;
	}

	get transitioning(): boolean {
		return this.#activeTransition !== undefined || this.#activeExecutionTransition !== undefined;
	}

	capture(): RpcSessionAuthorityToken {
		if (this.transitioning) {
			throw new RpcSessionAuthorityError("session_busy", "Session or execution authority transition is in progress");
		}
		return this.#snapshot();
	}

	captureIfAdmitted(): RpcSessionAuthorityToken | undefined {
		return this.transitioning ? undefined : this.#snapshot();
	}
	/**
	 * Collaboration cleanup validates the immutable authority that admitted it
	 * while the central coordinator fences every new command. Generations are
	 * committed only after that cleanup succeeds.
	 */
	captureLifecycleAuthority(): RpcSessionAuthorityToken {
		return this.#snapshot();
	}

	isCurrent(token: RpcSessionAuthorityToken): boolean {
		return (
			!this.transitioning &&
			token.sessionId === this.#getSessionId() &&
			token.sessionGeneration === this.#sessionGeneration &&
			token.authorityGeneration === this.#authorityGeneration
		);
	}

	assertCurrent(token: RpcSessionAuthorityToken): void {
		if (
			token.sessionId !== this.#getSessionId() ||
			token.sessionGeneration !== this.#sessionGeneration ||
			this.#activeTransition
		) {
			throw new RpcSessionAuthorityError(
				"session_changed",
				"Session authority changed before the operation settled",
			);
		}
		if (this.#activeExecutionTransition) {
			throw new RpcSessionAuthorityError(
				"authority_changed",
				"Execution authority changed before the operation settled",
			);
		}
		if (token.authorityGeneration !== this.#authorityGeneration) {
			throw new RpcSessionAuthorityError(
				"authority_changed",
				"Execution authority changed before the operation settled",
			);
		}
	}

	beginSessionTransition(): RpcSessionTransitionToken {
		if (this.transitioning) {
			throw new RpcSessionAuthorityError("session_busy", "Session transition is already in progress");
		}
		this.#transitionGeneration += 1;
		const transition = Object.freeze({
			...this.#snapshot(),
			transitionGeneration: this.#transitionGeneration,
		});
		this.#activeTransition = transition;
		return transition;
	}

	completeSessionTransition(transition: RpcSessionTransitionToken): RpcSessionAuthorityToken {
		this.#assertTransition(transition);
		this.#sessionGeneration += 1;
		this.#authorityGeneration += 1;
		this.#activeTransition = undefined;
		return this.#snapshot();
	}

	failSessionTransition(transition: RpcSessionTransitionToken): void {
		this.#assertTransition(transition);
		this.#activeTransition = undefined;
	}

	/**
	 * End a session transition after cancellation or teardown has started.
	 * Execution authority always advances; session authority also advances if
	 * the underlying mutation changed identity before failing.
	 */
	invalidateSessionTransitionAuthority(transition: RpcSessionTransitionToken): RpcSessionAuthorityToken {
		this.#assertTransition(transition);
		if (transition.sessionId !== this.#getSessionId()) this.#sessionGeneration += 1;
		this.#authorityGeneration += 1;
		this.#activeTransition = undefined;
		return this.#snapshot();
	}

	beginExecutionAuthorityTransition(): RpcExecutionAuthorityTransitionToken {
		if (this.transitioning) {
			throw new RpcSessionAuthorityError("session_busy", "Session or execution authority transition is in progress");
		}
		this.#executionTransitionGeneration += 1;
		const transition = Object.freeze({
			...this.#snapshot(),
			executionTransitionGeneration: this.#executionTransitionGeneration,
		});
		this.#activeExecutionTransition = transition;
		return transition;
	}

	completeExecutionAuthorityTransition(transition: RpcExecutionAuthorityTransitionToken): RpcSessionAuthorityToken {
		this.#assertExecutionTransition(transition);
		this.#authorityGeneration += 1;
		this.#activeExecutionTransition = undefined;
		return this.#snapshot();
	}

	failExecutionAuthorityTransition(transition: RpcExecutionAuthorityTransitionToken): void {
		this.#assertExecutionTransition(transition);
		this.#activeExecutionTransition = undefined;
	}

	#snapshot(): RpcSessionAuthorityToken {
		return Object.freeze({
			sessionId: this.#getSessionId(),
			sessionGeneration: this.#sessionGeneration,
			authorityGeneration: this.#authorityGeneration,
		});
	}

	#assertTransition(transition: RpcSessionTransitionToken): void {
		if (this.#activeTransition?.transitionGeneration !== transition.transitionGeneration) {
			throw new RpcSessionAuthorityError("session_changed", "Session transition authority is stale");
		}
	}

	#assertExecutionTransition(transition: RpcExecutionAuthorityTransitionToken): void {
		if (this.#activeExecutionTransition?.executionTransitionGeneration !== transition.executionTransitionGeneration) {
			throw new RpcSessionAuthorityError("authority_changed", "Execution authority transition is stale");
		}
		if (transition.sessionId !== this.#getSessionId() || transition.sessionGeneration !== this.#sessionGeneration) {
			throw new RpcSessionAuthorityError("session_changed", "Session changed during the authority transition");
		}
		if (transition.authorityGeneration !== this.#authorityGeneration) {
			throw new RpcSessionAuthorityError("authority_changed", "Execution authority changed during the transition");
		}
	}
}
