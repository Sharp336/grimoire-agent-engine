const MAX_DERIVED_INTENT_LENGTH = 72;
const MAX_DERIVED_INTENT_WORDS = 6;

/**
 * Build a concise runtime intent from arguments the model already supplies.
 *
 * Function-valued tool intents stay out of provider schemas and tool-call JSON,
 * while the runtime still emits a useful progress label. Bound both words and
 * characters so a path, regex, or command cannot become a second payload.
 */
export function deriveToolIntent(action: string, detail: unknown, fallback: string): string {
	if (typeof detail !== "string") return fallback;
	const normalized = detail.replace(/\s+/g, " ").trim();
	if (!normalized) return fallback;

	const actionWords = action.trim().split(/\s+/).filter(Boolean);
	const detailWordLimit = Math.max(1, MAX_DERIVED_INTENT_WORDS - actionWords.length);
	const boundedDetail = normalized.split(/\s+/).slice(0, detailWordLimit).join(" ");
	const intent = `${action} ${boundedDetail}`;
	if (intent.length <= MAX_DERIVED_INTENT_LENGTH) return intent;
	return `${intent.slice(0, MAX_DERIVED_INTENT_LENGTH - 3).trimEnd()}...`;
}
