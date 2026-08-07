import { $env } from "@oh-my-pi/pi-utils";
import { GrokLiveTransport } from "../grok-transport";
import { DEFAULT_GROK_LIVE_VOICE } from "../voices";
import { VoiceProvider, type VoiceProviderAvailability, type VoiceProviderCreateOptions } from "./base";

/** xAI Grok Voice provider using the Realtime WebSocket API. */
export class GrokVoiceProvider extends VoiceProvider<"grok"> {
	readonly id = "grok";
	readonly label = "xAI Grok Voice";
	readonly description = "xAI Grok Realtime WebSocket API (grok-voice-think-fast-2.0)";

	async isAvailable({ authStorage, sessionId }: VoiceProviderAvailability): Promise<boolean> {
		return Boolean($env.XAI_API_KEY || (await authStorage.getApiKey("xai", sessionId)));
	}

	createTransport({ config, ...options }: VoiceProviderCreateOptions): GrokLiveTransport {
		return new GrokLiveTransport({
			...options,
			voice: config?.voice?.trim() || DEFAULT_GROK_LIVE_VOICE,
			model: config?.model?.trim() || undefined,
		});
	}
}
