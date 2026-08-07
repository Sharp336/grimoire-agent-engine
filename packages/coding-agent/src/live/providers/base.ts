import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ILiveTransport, LiveTransportBaseOptions } from "../transport-types";

/** Realtime voice providers in their built-in fallback order. */
export const VOICE_PROVIDER_OPTIONS = [
	{
		value: "codex",
		label: "OpenAI Codex",
		description: "Codex WebRTC realtime API",
	},
	{
		value: "grok",
		label: "xAI Grok Voice",
		description: "xAI Grok Realtime WebSocket API (grok-voice-think-fast-2.0)",
	},
] as const;

export type VoiceProviderId = (typeof VOICE_PROVIDER_OPTIONS)[number]["value"];

export const VOICE_PROVIDER_ORDER: readonly VoiceProviderId[] = VOICE_PROVIDER_OPTIONS.map(option => option.value);
export const VOICE_PROVIDER_CHOICES = VOICE_PROVIDER_OPTIONS;

export function isVoiceProviderId(value: string): value is VoiceProviderId {
	return VOICE_PROVIDER_ORDER.includes(value as VoiceProviderId);
}

/** Provider-specific configuration kept outside the shared live-session controller. */
export interface VoiceProviderConfig {
	voice?: string;
	model?: string;
}

export interface VoiceProviderAvailability {
	authStorage: AuthStorage;
	sessionId: string;
}

export interface VoiceProviderCreateOptions extends LiveTransportBaseOptions {
	config?: VoiceProviderConfig;
}

/** Provider boundary for credential admission, voice defaults, and transport construction. */
export abstract class VoiceProvider {
	abstract readonly id: VoiceProviderId;
	abstract readonly label: string;

	abstract isAvailable(options: VoiceProviderAvailability): Promise<boolean> | boolean;
	abstract createTransport(options: VoiceProviderCreateOptions): ILiveTransport;
}
