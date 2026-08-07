import type { VoiceProvider, VoiceProviderAvailability } from "./providers/base";
import { CodexVoiceProvider } from "./providers/codex";
import { GrokVoiceProvider } from "./providers/grok";

export * from "./providers/base";

const VOICE_PROVIDERS = [new CodexVoiceProvider(), new GrokVoiceProvider()] as const;

/** IDs of the realtime voice providers registered in this build. */
export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number]["id"];

/** Settings metadata derived from each registered provider implementation. */
export const VOICE_PROVIDER_OPTIONS = VOICE_PROVIDERS.map(({ id, label, description }) => ({
	value: id,
	label,
	description,
}));

/** Built-in automatic-selection order before user ranking is applied. */
export const VOICE_PROVIDER_ORDER: readonly VoiceProviderId[] = VOICE_PROVIDERS.map(({ id }) => id);

function getVoiceProvider(id: VoiceProviderId): VoiceProvider<VoiceProviderId> {
	const provider = VOICE_PROVIDERS.find(candidate => candidate.id === id);
	if (!provider) throw new Error(`Unknown voice provider: ${id}`);
	return provider;
}

/** Return whether a runtime string names a registered voice provider. */
export function isVoiceProviderId(value: string): value is VoiceProviderId {
	return VOICE_PROVIDER_ORDER.includes(value as VoiceProviderId);
}

/** Inputs controlling automatic or explicit provider resolution. */
export interface ResolveVoiceProviderOptions extends VoiceProviderAvailability {
	/** User-ranked providers; omitted providers retain built-in relative order. */
	order?: readonly VoiceProviderId[];
	/** One-session override that bypasses automatic availability filtering. */
	forced?: VoiceProviderId;
}

/** Prioritize configured providers while retaining unlisted providers in built-in order. */
export function resolveVoiceProviderOrder(order: readonly VoiceProviderId[] = []): VoiceProviderId[] {
	const prioritized = new Set(order.filter(isVoiceProviderId));
	return [...prioritized, ...VOICE_PROVIDER_ORDER.filter(id => !prioritized.has(id))];
}

/** Resolve a forced provider or the first available provider in configured priority order. */
export async function resolveVoiceProvider(
	options: ResolveVoiceProviderOptions,
): Promise<VoiceProvider<VoiceProviderId>> {
	if (options.forced) return getVoiceProvider(options.forced);

	for (const id of resolveVoiceProviderOrder(options.order)) {
		const provider = getVoiceProvider(id);
		if (await provider.isAvailable(options)) return provider;
	}

	throw new Error(
		`No realtime voice provider is configured. Configure credentials for ${VOICE_PROVIDERS.map(provider => provider.label).join(" or ")}.`,
	);
}
