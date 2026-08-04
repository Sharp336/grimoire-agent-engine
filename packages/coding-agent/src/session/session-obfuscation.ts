import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { SessionProviderBoundary } from "./session-provider-boundary";

/** Capabilities the obfuscation coordinator borrows from its owning session. */
export interface SessionObfuscationHost {
	/** The session/provider boundary that applies the actual secret transforms. */
	providerBoundary(): SessionProviderBoundary;
}

/**
 * Owns the session's optional {@link SecretObfuscator} and the small set of
 * provider-boundary transforms that redact secrets on the way out to a provider
 * and restore them on the way back. Holding the obfuscator here keeps every
 * read of secret state — the public `/share` getter, the display-side
 * deobfuscation, and the side-channel turn — routed through one owner instead
 * of a field scattered across {@link AgentSession}. The transform wrappers
 * forward to {@link SessionProviderBoundary}, which is where the obfuscator was
 * already threaded at construction, so behavior is unchanged.
 */
export class SessionObfuscation {
	readonly #host: SessionObfuscationHost;
	readonly #obfuscator: SecretObfuscator | undefined;

	constructor(host: SessionObfuscationHost, obfuscator: SecretObfuscator | undefined) {
		this.#host = host;
		this.#obfuscator = obfuscator;
	}

	/** Secret obfuscator, when secrets are configured; `/share` redaction reuses it. */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	/** Obfuscate optional plaintext before a provider request. */
	obfuscateTextForProvider(text: string | undefined): string | undefined {
		return this.#host.providerBoundary().obfuscateText(text);
	}

	/** Obfuscate summaries and snapcompact plaintext carried into compaction. */
	obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		return this.#host.providerBoundary().obfuscateCompactionPreparation(preparation);
	}

	/** Deobfuscate provider text before exposing it to the session. */
	deobfuscateFromProvider(text: string): string {
		return this.#host.providerBoundary().deobfuscateText(text);
	}

	/** Deobfuscate a streamed delta and drop an incomplete secret-placeholder suffix. */
	deobfuscatedProviderTextReadyForDelta(text: string): string {
		return this.#host.providerBoundary().deobfuscateDelta(text);
	}
}
