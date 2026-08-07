import {
	isVoiceProviderId,
	VOICE_PROVIDER_ORDER,
	type VoiceProvider,
	type VoiceProviderAvailability,
	type VoiceProviderId,
} from "./providers/base";
import { CodexVoiceProvider } from "./providers/codex";
import { GrokVoiceProvider } from "./providers/grok";

export * from "./providers/base";

const PROVIDERS: Record<VoiceProviderId, VoiceProvider> = {
	codex: new CodexVoiceProvider(),
	grok: new GrokVoiceProvider(),
};

export interface ResolveVoiceProviderOptions extends VoiceProviderAvailability {
	order?: readonly VoiceProviderId[];
	forced?: VoiceProviderId;
}

/** Prioritize configured providers while retaining unlisted providers in built-in order. */
export function resolveVoiceProviderOrder(order: readonly VoiceProviderId[] = []): VoiceProviderId[] {
	const prioritized = new Set(order.filter(isVoiceProviderId));
	return [...prioritized, ...VOICE_PROVIDER_ORDER.filter(id => !prioritized.has(id))];
}

/** Resolve a forced provider or the first available provider in configured priority order. */
export async function resolveVoiceProvider(options: ResolveVoiceProviderOptions): Promise<VoiceProvider> {
	if (options.forced) return PROVIDERS[options.forced];

	for (const id of resolveVoiceProviderOrder(options.order)) {
		const provider = PROVIDERS[id];
		if (await provider.isAvailable(options)) return provider;
	}

	throw new Error(
		"No realtime voice provider is configured. Sign in to OpenAI Codex or configure an xAI Console API key.",
	);
}
