/**
 * Video Generation Providers
 *
 * Leaf module (no runtime deps) shared by the generate_video tool, the settings
 * schema, and settings migrations — mirrors `image-providers.ts` so the
 * provider list, auto order, and settings choices never drift apart.
 */

/** Video generation backends, in settings/tool vocabulary. */
export type VideoProvider = "openrouter" | "xai";

/**
 * Auto-resolution fallback order when no configured entry or session provider
 * matches. xAI leads: it is the only backend reachable with a subscription
 * credential (Grok OAuth), and its per-second price is the lowest of the two.
 */
export const AUTO_VIDEO_PROVIDER_ORDER: readonly VideoProvider[] = ["xai", "openrouter"];

/** Settings choices for `providers.videoOrder`. */
export const VIDEO_PROVIDER_CHOICES = [
	{
		value: "xai",
		label: "xAI Grok Imagine",
		description: "Requires xAI Grok OAuth (SuperGrok / X Premium+) or XAI_API_KEY",
	},
	{
		value: "openrouter",
		label: "OpenRouter",
		description: "Requires OPENROUTER_API_KEY; brokers Veo, Seedance, Kling, Hailuo and others",
	},
] as const satisfies ReadonlyArray<{ value: VideoProvider; label: string; description: string }>;

export function isVideoProviderId(value: unknown): value is VideoProvider {
	return typeof value === "string" && AUTO_VIDEO_PROVIDER_ORDER.includes(value as VideoProvider);
}
