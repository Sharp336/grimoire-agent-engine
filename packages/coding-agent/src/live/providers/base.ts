import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ILiveTransport, LiveTransportBaseOptions } from "../transport-types";

/** Provider-owned voice and model overrides for one live session. */
export interface VoiceProviderConfig {
	/** Realtime output voice requested for this provider. */
	voice?: string;
	/** Provider-specific realtime model override. */
	model?: string;
}

/** Credential context used to decide whether a provider may join automatic selection. */
export interface VoiceProviderAvailability {
	/** Shared credential broker; providers must not open independent credential stores. */
	authStorage: AuthStorage;
	/** Active agent session used for credential affinity and refresh. */
	sessionId: string;
}

/** Shared live-call inputs plus the selected provider's configuration. */
export interface VoiceProviderCreateOptions extends LiveTransportBaseOptions {
	/** Voice and model overrides owned by the selected provider. */
	config?: VoiceProviderConfig;
}

/** Provider boundary for credential admission, settings metadata, and transport construction. */
export abstract class VoiceProvider<Id extends string = string> {
	/** Stable provider ID persisted in ranked settings and accepted by `/live`. */
	abstract readonly id: Id;
	/** Human-readable provider name shown in settings and errors. */
	abstract readonly label: string;
	/** Short transport description shown in ranked-provider settings. */
	abstract readonly description: string;

	/** Whether credentials required for automatic selection are currently available. */
	abstract isAvailable(options: VoiceProviderAvailability): Promise<boolean> | boolean;
	/** Create a disconnected transport configured for this provider. */
	abstract createTransport(options: VoiceProviderCreateOptions): ILiveTransport;
}
