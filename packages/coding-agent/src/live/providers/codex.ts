import { $env } from "@oh-my-pi/pi-utils";
import { CodexLiveTransport } from "../transport";
import { DEFAULT_CODEX_LIVE_VOICE } from "../voices";
import { VoiceProvider, type VoiceProviderAvailability, type VoiceProviderCreateOptions } from "./base";

export class CodexVoiceProvider extends VoiceProvider {
	readonly id = "codex";
	readonly label = "OpenAI Codex";

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
