import { $env } from "@oh-my-pi/pi-utils";
import { CodexLiveTransport } from "../transport";
import { DEFAULT_CODEX_LIVE_VOICE } from "../voices";
import { VoiceProvider, type VoiceProviderAvailability, type VoiceProviderCreateOptions } from "./base";

/** Codex realtime provider using OAuth-authenticated WebRTC and sideband control. */
export class CodexVoiceProvider extends VoiceProvider<"codex"> {
	readonly id = "codex";
	readonly label = "OpenAI Codex";
	readonly description = "Codex WebRTC realtime API";

	isAvailable({ authStorage }: VoiceProviderAvailability): boolean {
		return (
			authStorage.hasNonEnvCredential("openai-codex") || Boolean($env.OPENAI_OAUTH_TOKEN || $env.CODEX_OAUTH_TOKEN)
		);
	}

	createTransport({ config, ...options }: VoiceProviderCreateOptions): CodexLiveTransport {
		return new CodexLiveTransport({
			...options,
			voice: config?.voice?.trim() || DEFAULT_CODEX_LIVE_VOICE,
		});
	}
}
