export class InjectionCache {
	readonly #sessions = new Map<string, Set<string>>();

	hasInjected(sessionKey: string, canonicalDir: string): boolean {
		return this.#sessions.get(sessionKey)?.has(canonicalDir) ?? false;
	}

	markInjected(sessionKey: string, canonicalDir: string): void {
		let session = this.#sessions.get(sessionKey);
		if (session === undefined) {
			session = new Set<string>();
			this.#sessions.set(sessionKey, session);
		}

		session.add(canonicalDir);
	}

	getCacheSize(sessionKey: string): number {
		return this.#sessions.get(sessionKey)?.size ?? 0;
	}

	clearSession(sessionKey: string): void {
		this.#sessions.delete(sessionKey);
	}

	clearAll(): void {
		this.#sessions.clear();
	}
}
